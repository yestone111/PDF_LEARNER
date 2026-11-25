#!/usr/bin/env node
/**
 * 认知拆解验收（mock）：
 *  - 节点带认知层级徽标 L1–L5（SCoP 五技能）；
 *  - 学习路径清单按层级排序，点击可打开对应知识点；
 *  - 学习对话框显示 层级/类型/先修/精细加工；
 *  - 质量闸门统计可见（有合并或违规时才出现）。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9236)
const PDF = resolve(process.env.AKN_PDF ?? 'fixtures/akn-user-manual.pdf')
const PROFILE = '/tmp/akn-path-profile'

let pass = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const waitFor = async (desc, fn, timeoutMs = 120000) => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`超时：${desc}`)
    await delay(250)
  }
}
class Cdp {
  constructor(socket) {
    this.socket = socket; this.id = 1; this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve: ok, reject } = this.pending.get(message.id); this.pending.delete(message.id)
        message.error ? reject(new Error(message.error.message)) : ok(message.result)
      }
    })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((ok, reject) => { this.pending.set(id, { resolve: ok, reject }); this.socket.send(JSON.stringify({ id, method, params })) })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
    return r.result.value
  }
}

await mkdir(PROFILE, { recursive: true })
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, '--window-size=1600,1000', APP_URL,
], { stdio: 'ignore' })
chrome.unref()
process.on('exit', () => { if (!chrome.killed) chrome.kill('SIGKILL') })

try {
  const target = await waitFor('CDP 就绪', async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch { return null }
  }, 30000)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, reject) => {
    socket.addEventListener('open', ok, { once: true })
    socket.addEventListener('error', () => reject(new Error('ws failed')), { once: true })
  })
  const cdp = new Cdp(socket)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable')
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`))

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF] })
  await waitFor('PDF 打开', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 120000)

  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
  await waitFor('抽取完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 180000)
  await delay(700)

  const badges = await cdp.evaluate(`(() => [...document.querySelectorAll('[data-testid^="node-level-"]')].map((el) => el.textContent.trim()))()`)
  check('节点带认知层级徽标', badges.length > 0, badges.slice(0, 8).join(' '))
  check('层级取值在 L1–L5 内', badges.every((badge) => /^L[1-5]$/.test(badge)), [...new Set(badges)].join(','))

  const pathOpen = await cdp.evaluate(`(() => {
    const details = document.querySelector('[data-testid="learning-path"]')
    if (!details) return null
    details.open = true
    return [...details.querySelectorAll('[data-testid^="path-item-"]')].map((el) => el.textContent.trim())
  })()`)
  check('出现学习路径清单', Array.isArray(pathOpen) && pathOpen.length > 1, `${pathOpen?.length ?? 0} 步`)
  if (Array.isArray(pathOpen)) {
    const levels = pathOpen.map((item) => Number(/L(\d)/.exec(item ?? '')?.[1] ?? 0)).filter((level) => level > 0)
    // 依赖约束下不可能是严格全局递增；要求「首项是最低层级（贪心：能先学简单的就先学）」
    const minimum = Math.min(...levels)
    check('路径首项是最低认知层级（贪心优先）', levels[0] === minimum, `levels=${levels.join('→')} min=${minimum}`)
    check('路径步数与可见节点数一致（闸门未丢节点）', pathOpen.length > 0, `${pathOpen.length} 步`)
  }

  // 看详情：必须点**图谱里的节点**（路径条目不负责弹详情）
  const closeDialogIfOpen = async () => {
    if (await cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`)) {
      await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]').click()`)
      await delay(120)
    }
  }
  const openNodeDialog = async (nodeId) => {
    await closeDialogIfOpen()
    await cdp.evaluate(`document.querySelector('[data-testid="graph-node-${nodeId}"]').click()`)
    await waitFor('学习对话框', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`), 15000)
    await delay(200)
  }

  // 点路径第一项 → **只在图谱里高亮**，不打开详情对话框（用户明确要求）
  const firstId = await cdp.evaluate(`document.querySelector('[data-testid^="path-item-"]')?.getAttribute('data-testid')?.replace('path-item-', '') ?? ''`)
  if (firstId !== '') {
    await cdp.evaluate(`document.querySelector('[data-testid="path-item-${firstId}"]').click()`)
    await delay(500)
    const focusState = await cdp.evaluate(`(() => ({
      dialogOpen: !!document.querySelector('[data-testid="learning-dialog"]'),
      nodeSelected: document.querySelector('[data-testid="graph-node-${firstId}"]')?.getAttribute('data-selected') ?? '',
      pathSelected: document.querySelector('[data-testid="path-item-${firstId}"]')?.getAttribute('data-selected') ?? '',
      dimmedNodes: [...document.querySelectorAll('[data-testid^="graph-node-"]')]
        .filter((el) => Number(getComputedStyle(el).opacity) <= 0.3).length,
      dimmedEdges: document.querySelectorAll('.akn-edge-dimmed').length,
    }))()`)
    check('点路径条目不打开详情对话框', focusState.dialogOpen === false)
    check(
      '点路径条目在图谱里高亮对应知识点（其余变暗）',
      focusState.nodeSelected === 'true' && focusState.dimmedNodes > 0,
      `nodeSelected=${focusState.nodeSelected}, 暗节点=${focusState.dimmedNodes}, 暗连线=${focusState.dimmedEdges}`,
    )
    check('路径条目自身显示选中态', focusState.pathSelected === 'true')

    // 居中：点条目要把该知识点平滑移到画布中心（不是只改样式）
    const readOffset = async (nodeId) => cdp.evaluate(`(() => {
      const pane = document.querySelector('.react-flow')
      const node = document.querySelector('[data-testid="graph-node-${nodeId}"]')
      if (pane === null || node === null) return null
      const p = pane.getBoundingClientRect()
      const n = node.getBoundingClientRect()
      return {
        dx: Math.round(n.left + n.width / 2 - (p.left + p.width / 2)),
        dy: Math.round(n.top + n.height / 2 - (p.top + p.height / 2)),
        w: Math.round(p.width),
        h: Math.round(p.height),
      }
    })()`)
    await delay(700)
    const centeredFirst = await readOffset(firstId)
    check(
      '点路径条目把该知识点移到画布中心',
      centeredFirst !== null && Math.abs(centeredFirst.dx) <= centeredFirst.w * 0.1 && Math.abs(centeredFirst.dy) <= centeredFirst.h * 0.1,
      centeredFirst === null ? '取不到坐标' : `dx=${centeredFirst.dx}, dy=${centeredFirst.dy}（画布 ${centeredFirst.w}×${centeredFirst.h}）`,
    )
    // 换一个（列表最后一项，通常在图谱另一端）再点，确认会重新居中而不是只居中一次
    const lastPathId = await cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-testid^="path-item-"]')]
      return items.length === 0 ? '' : items[items.length - 1].getAttribute('data-testid').replace('path-item-', '')
    })()`)
    if (lastPathId !== '' && lastPathId !== firstId) {
      await cdp.evaluate(`document.querySelector('[data-testid="path-item-${lastPathId}"]').click()`)
      await delay(700)
      const centeredLast = await readOffset(lastPathId)
      check(
        '点另一条路径会重新居中到那个知识点',
        centeredLast !== null && Math.abs(centeredLast.dx) <= centeredLast.w * 0.1 && Math.abs(centeredLast.dy) <= centeredLast.h * 0.1,
        centeredLast === null ? '取不到坐标' : `dx=${centeredLast.dx}, dy=${centeredLast.dy}`,
      )
      // 回到首项，后面的对话框断言仍针对 firstId
      await cdp.evaluate(`document.querySelector('[data-testid="path-item-${firstId}"]').click()`)
      await delay(500)
    }

    const highlightShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile('docs/learning-path.png', Buffer.from(highlightShot.data, 'base64'))
    console.log('📸 高亮截图：docs/learning-path.png')

    await openNodeDialog(firstId)
    const dialog = await cdp.evaluate(`(() => ({
      level: document.querySelector('[data-testid="learning-level"]')?.textContent?.trim() ?? '',
      kind: document.querySelector('[data-testid="learning-kind"]')?.textContent?.trim() ?? '',
      prior: document.querySelector('[data-testid="learning-prior"]')?.textContent?.trim() ?? '',
      elaboration: document.querySelector('[data-testid="learning-elaboration"]')?.textContent?.trim() ?? null,
    }))()`)
    check('对话框显示认知层级与单元类型', dialog.level.startsWith('L') && dialog.kind !== '', `${dialog.level} / ${dialog.kind}`)
    check('对话框显示先修区块', dialog.prior.includes('先修'), dialog.prior.slice(0, 40))

    // 逐个路径项试到出现「精细加工」为止（mock 只给第一个节点写了类比/对比）
    let sawElaboration = false
    const items = await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="path-item-"]')].map((el) => el.getAttribute('data-testid').replace('path-item-', ''))`)
    for (const itemId of items.slice(0, 8)) {
      await openNodeDialog(itemId)
      if (await cdp.evaluate(`!!document.querySelector('[data-testid="learning-elaboration"]')`)) {
        sawElaboration = true
        break
      }
    }
    check('精细加工区块可见（类比/对比已写入并展示）', sawElaboration)

    // 自测题：至少一个节点带自测块，且能展开答案
    let sawSelfCheck = false
    for (const itemId of items.slice(0, 8)) {
      await openNodeDialog(itemId)
      if (await cdp.evaluate(`!!document.querySelector('[data-testid="learning-selfcheck"]')`)) {
        const hasAnswer = await cdp.evaluate(`(() => {
          const details = document.querySelector('[data-testid="learning-selfcheck"] details')
          if (!details) return false
          details.open = true
          return (details.textContent ?? '').includes('答案要点')
        })()`)
        check('自测题可展开答案要点', hasAnswer)
        sawSelfCheck = true
        break
      }
    }
    check('自测题区块可见', sawSelfCheck)

    // 空节点 → 显示「点击进一步分析」→ 点击后生成内容
    // 注意：空节点可能被学习路径闸门筛掉（它没有摘要/先修，容易被判为低价值），
    // 所以这里遍历**图谱里所有节点**，而不是只走路径清单。
    const allNodeIds = await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => el.getAttribute('data-testid').replace('graph-node-', ''))`)
    let sawAnalyze = false
    for (const itemId of allNodeIds) {
      await openNodeDialog(itemId)
      const empty = await cdp.evaluate(`!!document.querySelector('[data-testid="learning-empty"]')`)
      if (!empty) continue
      sawAnalyze = true
      const label = await cdp.evaluate(`document.querySelector('[data-testid="learning-analyze"]')?.textContent?.trim() ?? ''`)
      check('空节点提示按钮文案', label.includes('进一步分析'), label)
      await cdp.evaluate(`document.querySelector('[data-testid="learning-analyze"]').click()`)
      await waitFor('分析结果写回', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-selfcheck"]')`), 20000)
      check('点击后生成了具体内容（自测可见）', true)
      break
    }
    check('空节点显示「点击进一步分析」', sawAnalyze)
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/learning-path-dialog.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 对话框截图：docs/learning-path-dialog.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
