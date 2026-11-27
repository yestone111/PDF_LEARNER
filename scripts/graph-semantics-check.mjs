#!/usr/bin/env node
/**
 * 视觉语义验收（mock 上游，快）：
 *  大小 = 关联程度（连边数）、颜色深浅 = 掌握难度、红/绿 = 掌握状态、左→右 = 依赖方向。
 *  以及两组的切换（① 全文档总览 / ② 章节拆解）。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9234)
const PDF = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const PROFILE = '/tmp/akn-semantics-profile'

let pass = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const waitFor = async (desc, fn, timeoutMs = 90000) => {
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
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, '--window-size=1440,900', APP_URL,
], { stdio: 'ignore' })
chrome.unref()
process.on('exit', () => { if (!chrome.killed) chrome.kill('SIGKILL') })

const READ = `(() => [...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => {
  const rect = el.getBoundingClientRect()
  return {
    id: el.getAttribute('data-testid').replace('graph-node-', ''),
    degree: Number(el.getAttribute('data-degree')),
    difficulty: Number(el.getAttribute('data-difficulty')),
    mastery: el.getAttribute('data-mastery'),
    width: Math.round(rect.width),
    fill: getComputedStyle(el).backgroundColor,
    opacity: Number(getComputedStyle(el).opacity),
    x: Math.round(rect.left + rect.width / 2),
  }
}))()`

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
  await waitFor('抽取完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 120000)
  await delay(600)

  const legend = await cdp.evaluate(`document.querySelector('[data-testid="graph-legend"]')?.textContent ?? ''`)
  check('图例解释了三重语义', /大小/.test(legend) && /深浅|难度/.test(legend) && /红|绿/.test(legend), legend.slice(0, 50))
  check('两组入口存在（总览 / 章节拆解）', await cdp.evaluate(`!!document.querySelector('[data-testid="graph-mode-overview"]') && !!document.querySelector('[data-testid="graph-mode-chapter"]')`))

  const nodes = await cdp.evaluate(READ)
  check('节点都带关联度与难度属性', nodes.every((n) => Number.isFinite(n.degree) && Number.isFinite(n.difficulty)), `n=${nodes.length}`)

  // 大小随关联度单调
  const sorted = [...nodes].sort((a, b) => a.degree - b.degree)
  let monotonic = true
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].degree > sorted[i - 1].degree && sorted[i].width < sorted[i - 1].width) monotonic = false
  }
  check('大小随关联程度单调递增', monotonic, sorted.map((n) => `${n.degree}→${n.width}`).slice(0, 6).join(' '))

  // 深浅随难度：同 mastery 下，difficulty 越大颜色越深
  const unmastered = nodes.filter((n) => n.mastery === 'unmastered')
  const byDifficulty = new Map()
  for (const n of unmastered) if (!byDifficulty.has(n.difficulty)) byDifficulty.set(n.difficulty, n.fill)
  const luminance = (color) => {
    const [r, g, b] = color.match(/\d+/g).slice(0, 3).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const difficultyKeys = [...byDifficulty.keys()].sort((a, b) => a - b)
  let depthOk = difficultyKeys.length >= 2
  for (let i = 1; i < difficultyKeys.length && depthOk; i += 1) {
    if (luminance(byDifficulty.get(difficultyKeys[i])) >= luminance(byDifficulty.get(difficultyKeys[i - 1]))) depthOk = false
  }
  check('颜色深浅随掌握难度递增（同掌握状态）', depthOk, difficultyKeys.map((k) => `${k}:${byDifficulty.get(k)}`).join(' '))

  // 左→右：依赖方向
  const edges = await cdp.evaluate(`(() => [...document.querySelectorAll('.react-flow__edge')].length)()`)
  const xSorted = [...nodes].sort((a, b) => a.x - b.x)
  check('节点按依赖层级横向铺开（不是圆环）', edges > 0 && xSorted.length > 2, `edges=${edges}`)

  // 掌握切换：尺寸不变、色相改变
  const target0 = nodes.find((n) => n.mastery === 'unmastered')
  if (target0 !== undefined) {
    await cdp.evaluate(`document.querySelector('[data-testid="mastery-${target0.id}"]').click()`)
    await delay(400)
    const after = (await cdp.evaluate(READ)).find((n) => n.id === target0.id)
    check('点圆点切换为已掌握（红 → 绿）', after?.mastery === 'mastered', after?.fill ?? '')
    check('切换掌握状态时尺寸不变', after?.width === target0.width, `${target0.width} → ${after?.width}`)
    check('绿系：绿通道大于红通道', (() => {
      const [r, g] = (after?.fill ?? '').match(/\d+/g).map(Number)
      return g > r
    })())

    // ---- 三态循环：已掌握 → 有疑问（黄）→ 未掌握（红），并检查学习路径标记联动 ----
    const readPathMarker = async (id) => cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="path-mastery-${id}"]')
      if (el === null) return null
      const row = el.closest('[data-testid^="path-item-"]')
      const box = el.getBoundingClientRect()
      const rowBox = row === null ? null : row.getBoundingClientRect()
      return {
        state: el.getAttribute('data-state'),
        text: el.textContent.trim(),
        w: Math.round(box.width),
        // 标记在行首：距整行左边 < 30px
        offsetLeft: rowBox === null ? -1 : Math.round(box.left - rowBox.left),
      }
    })()`)
    const hueOf = (fill) => {
      const [r, g, b] = (fill.match(/\d+/g) ?? []).slice(0, 3).map((value) => Number(value) / 255)
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const delta = max - min
      if (delta === 0) return 0
      const raw = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
      return (raw * 60 + 360) % 360
    }

    let marker = await readPathMarker(target0.id)
    check('已掌握时学习路径条目出现打勾', marker === null || (marker.state === 'mastered' && marker.text === '✓'),
      marker === null ? '该节点不在学习路径里（跳过）' : `${marker.text} / ${marker.state}`)
    check('打勾标记在行首、且看得清（≥14px）', marker === null || (marker.offsetLeft >= 0 && marker.offsetLeft < 30 && marker.w >= 14),
      marker === null ? '跳过' : `left=${marker.offsetLeft}px, size=${marker.w}px`)

    // 显式按钮：已掌握 → 点「? 有疑问」直接切黄色（不再需要循环点击）
    await cdp.evaluate(`document.querySelector('[data-testid="doubt-${target0.id}"]').click()`)
    await delay(400)
    const doubt = (await cdp.evaluate(READ)).find((n) => n.id === target0.id)
    check('再点一次进入「有疑问」（黄系）', doubt?.mastery === 'doubt', `${doubt?.fill ?? ''}（hue=${Math.round(hueOf(doubt?.fill ?? ''))}）`)
    check('黄色：色相在 35°–60°（金黄，不是红色也不是绿色）', doubt !== undefined && hueOf(doubt.fill) >= 35 && hueOf(doubt.fill) <= 60, `${Math.round(hueOf(doubt?.fill ?? ''))}°`)
    check('有疑问时尺寸不变', doubt?.width === target0.width, `${target0.width} → ${doubt?.width}`)
    marker = await readPathMarker(target0.id)
    check('有疑问时学习路径条目出现问号', marker === null || (marker.state === 'doubt' && marker.text === '?'),
      marker === null ? '该节点不在学习路径里（跳过）' : `${marker.text} / ${marker.state}`)

    // 截图时把学习路径展开，顺便证明「黄 = ?」与「路径标记」是同一份状态
    await cdp.evaluate(`(() => { const details = document.querySelector('[data-testid="learning-path"]'); if (details !== null) details.open = true; return true })()`)
    await delay(250)
    const doubtShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile('docs/mastery-doubt.png', Buffer.from(doubtShot.data, 'base64'))
    console.log('📸 有疑问状态截图：docs/mastery-doubt.png')

    // 再点同一个「?」按钮 = 取消（回到未掌握）
    await cdp.evaluate(`document.querySelector('[data-testid="doubt-${target0.id}"]').click()`)
    await delay(400)
    const reset = (await cdp.evaluate(READ)).find((n) => n.id === target0.id)
    check('再点「有疑问」按钮取消，回到未掌握（红系）', reset?.mastery === 'unmastered' && hueOf(reset.fill) < 30, `${reset?.fill ?? ''}（hue=${Math.round(hueOf(reset?.fill ?? ''))}）`)
    marker = await readPathMarker(target0.id)
    check('未掌握时学习路径不显示打勾/问号', marker === null || (marker.state === 'unmastered' && marker.text === ''),
      marker === null ? '该节点不在学习路径里（跳过）' : `text="${marker.text}"`)

    // 两个按钮是显式的：从「未掌握」直接点「?」也能一步到位（不必先点 ✓）
    await cdp.evaluate(`document.querySelector('[data-testid="doubt-${target0.id}"]').click()`)
    await delay(300)
    const direct = (await cdp.evaluate(READ)).find((n) => n.id === target0.id)
    check('未掌握时直接点「? 有疑问」一步到黄色', direct?.mastery === 'doubt', `${direct?.fill ?? ''}`)
    await cdp.evaluate(`document.querySelector('[data-testid="doubt-${target0.id}"]').click()`)
    await delay(300)
  }

  // 选中一个节点：不相关节点**和连线**一起暗下去（用户反馈：线也要跟着暗）
  // 选关联度最小的那个（中心/根节点连着几乎所有节点，选了它等于没弱化，测不出东西）
  const focusTarget = [...nodes].filter((n) => n.degree > 0).sort((a, b) => a.degree - b.degree)[0] ?? nodes[0]
  await cdp.evaluate(`document.querySelector('[data-testid="graph-node-${focusTarget.id}"]').click()`)
  await waitFor('学习对话框', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`), 20000)
  await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]').click()`)
  // 等弱化真的落到 DOM 上（节点有 opacity 过渡，别在过渡中间读数）
  await waitFor(
    '弱化生效',
    () =>
      cdp.evaluate(
        `document.querySelectorAll('.akn-edge-dimmed').length > 0 &&
         [...document.querySelectorAll('[data-testid^="graph-node-"]')].some((el) => Number(getComputedStyle(el).opacity) <= 0.3)`,
      ),
    8000,
  ).catch(() => null)
  await delay(400)

  const READ_FOCUS = `(() => {
    const edges = [...document.querySelectorAll('.react-flow__edge')].map((g) => {
      const path = g.querySelector('.react-flow__edge-path')
      const text = g.querySelector('.react-flow__edge-text')
      return {
        kind: g.classList.contains('akn-edge-related') ? 'related'
          : g.classList.contains('akn-edge-dimmed') ? 'dimmed' : 'none',
        opacity: path === null ? null : Number(getComputedStyle(path).opacity),
        labelOpacity: text === null ? null : Number(getComputedStyle(text).opacity),
      }
    })
    const nodes = [...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => ({
      id: el.getAttribute('data-testid').replace('graph-node-', ''),
      selected: el.getAttribute('data-selected') === 'true',
      opacity: Number(getComputedStyle(el).opacity),
    }))
    return { edges, nodes }
  })()`

  const focus = await cdp.evaluate(READ_FOCUS)
  const related = focus.edges.filter((edge) => edge.kind === 'related')
  const dimmed = focus.edges.filter((edge) => edge.kind === 'dimmed')
  const strayEdges = focus.edges.filter((edge) => edge.kind === 'none')
  check('选中节点后每条连线都归入「相关 / 不相关」', strayEdges.length === 0, `${focus.edges.length} 条连线`)
  check('与选中节点相连的连线保持高亮', related.length > 0 && related.every((edge) => edge.opacity === 1),
    `选中节点 degree=${focusTarget.degree}, related=${related.length}, opacity=${[...new Set(related.map((e) => e.opacity))].join(',')}`)
  check('不相关连线一起暗下去（透明度 ≤ 0.2）', dimmed.length > 0 && dimmed.every((edge) => edge.opacity <= 0.2),
    `dimmed=${dimmed.length}/${focus.edges.length}, opacity=${[...new Set(dimmed.map((e) => e.opacity))].join(',')}`)
  check('不相关连线的标签也跟着暗（不发亮地悬着）',
    dimmed.every((edge) => edge.labelOpacity === null || edge.labelOpacity <= 0.2),
    [...new Set(dimmed.map((e) => e.labelOpacity))].join(','))
  const selectedNode = focus.nodes.find((node) => node.selected)
  const brightNodes = focus.nodes.filter((node) => node.opacity === 1)
  const dimNodes = focus.nodes.filter((node) => node.opacity <= 0.3)
  check('选中节点本身保持高亮', selectedNode !== undefined && selectedNode.opacity === 1,
    `selected=${selectedNode?.id?.slice(0, 8) ?? 'none'}, opacity=${selectedNode?.opacity}`)
  check('不相关节点暗下去（与连线同步）', dimNodes.length > 0 && brightNodes.length >= 1,
    `亮 ${brightNodes.length} / 暗 ${dimNodes.length} / 共 ${focus.nodes.length}`)

  const focusClip = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="graph-pane"]')
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
  })()`)
  const focusShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    ...(focusClip === null ? {} : { clip: { ...focusClip, scale: 2 } }),
  })
  await writeFile('docs/graph-focus.png', Buffer.from(focusShot.data, 'base64'))
  console.log('📸 焦点截图：docs/graph-focus.png')

  // 点空白取消选中 → 全部恢复
  await cdp.evaluate(`document.querySelector('.react-flow__pane').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
  await delay(400)
  const reset = await cdp.evaluate(READ_FOCUS)
  check('点空白取消选中后，连线全部恢复亮度',
    reset.edges.every((edge) => edge.opacity === 1) && reset.nodes.every((node) => node.opacity === 1),
    `edges=${[...new Set(reset.edges.map((e) => e.opacity))].join(',')}`)

  // 第二组：章节拆解
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]').click()`)
  await delay(300)
  await cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]')[3].click()`)
  await delay(400)
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  await waitFor('章节模式', () => cdp.evaluate(`!!document.querySelector('[data-testid="chapter-select"]')`))
  check('第二组：章节拆解可切换章节', true)
  check('章节模式仍有「AI 开启拆解」入口', await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]')?.textContent?.includes('开启拆解')`))

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/graph-semantics.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 截图：docs/graph-semantics.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
