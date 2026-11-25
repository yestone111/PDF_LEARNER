#!/usr/bin/env node
/**
 * 章节速览浮窗验收（mock）：
 *  - 章节模式出现「章节速览」入口，打开是可拖动浮窗（不压缩图谱高度）；
 *  - 失败时给错误 + 重试按钮，重试可成功；
 *  - 关键词可点 → 联动选中图谱节点；
 *  - 浮窗可拖动、可关闭；
 *  - 刷新后缓存速览仍在。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9243)
const PDF = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const PROFILE = '/tmp/akn-chapter-summary-profile'

let pass = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const waitFor = async (desc, fn, timeoutMs = 60000) => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`超时：${desc}`)
    await delay(200)
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
  await waitFor('全局抽取完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 120000)

  // 进入章节模式（先不拆解，用于验证失败态）
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]').click()`)
  await delay(300)
  await cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]')[3].click()`)
  await delay(400)
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  await waitFor('章节模式', () => cdp.evaluate(`!!document.querySelector('[data-testid="chapter-select"]')`), 30000)

  check('章节模式出现「章节速览」入口', await cdp.evaluate(`!!document.querySelector('[data-testid="chapter-summary-open"]')`))

  const canvasBefore = await cdp.evaluate(`Math.round(document.querySelector('[data-testid="graph-pane"]')?.getBoundingClientRect().height ?? 0)`)
  await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-open"]').click()`)
  await waitFor('浮窗出现', () => cdp.evaluate(`!!document.querySelector('[data-testid="chapter-summary-popup"]')`))
  const canvasAfter = await cdp.evaluate(`Math.round(document.querySelector('[data-testid="graph-pane"]')?.getBoundingClientRect().height ?? 0)`)
  check('浮窗打开不压缩图谱高度', Math.abs(canvasAfter - canvasBefore) <= 2, `${canvasBefore} → ${canvasAfter}`)

  // 未拆解 → 失败 + 重试按钮
  await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-generate"]').click()`)
  await waitFor('错误提示', () => cdp.evaluate(`!!document.querySelector('[data-testid="chapter-summary-error"]')`), 15000)
  const errorText = await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-error"]').textContent.trim()`)
  check('失败时显示错误信息', errorText.length > 0, errorText.slice(0, 30))
  check('失败时提供「重试整理」按钮', await cdp.evaluate(`!!document.querySelector('[data-testid="chapter-summary-retry"]')`))

  // 章节拆解 → 点重试
  await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
  await waitFor('章节拆解完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 120000)
  await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-retry"]').click()`)
  await waitFor('速览生成', () => cdp.evaluate(`!!document.querySelector('[data-testid="chapter-summary-text"]')`), 30000)
  const text = await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-text"]').textContent.trim()`)
  check('重试后生成速览', text.length > 20, `${text.length} 字`)

  // 关键词联动
  const keyword = await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid^="summary-kw-"]')
    return btn === null ? null : { id: btn.getAttribute('data-testid').replace('summary-kw-', ''), text: btn.textContent.trim() }
  })()`)
  check('速览里识别出可点关键词', keyword !== null, keyword?.text ?? '')
  if (keyword !== null) {
    await cdp.evaluate(`document.querySelector('[data-testid="summary-kw-${keyword.id}"]').click()`)
    await delay(300)
    const selected = await cdp.evaluate(`document.querySelector('[data-testid="graph-node-${keyword.id}"]')?.getAttribute('data-selected') ?? null`)
    check('点击关键词后图谱节点被选中', selected === 'true', `selected=${selected}`)
    await delay(700)
    const centered = await cdp.evaluate(`(() => {
      const pane = document.querySelector('.react-flow')
      const node = document.querySelector('[data-testid="graph-node-${keyword.id}"]')
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
    check(
      '点击关键词后该节点被移到画布中心',
      centered !== null && Math.abs(centered.dx) <= centered.w * 0.1 && Math.abs(centered.dy) <= centered.h * 0.1,
      centered === null ? '取不到坐标' : `dx=${centered.dx}, dy=${centered.dy}（画布 ${centered.w}×${centered.h}）`,
    )
  }

  // 拖动浮窗
  const drag = await cdp.evaluate(`(() => {
    const popup = document.querySelector('[data-testid="chapter-summary-popup"]')
    const header = document.querySelector('[data-testid="chapter-summary-drag"]')
    if (popup === null || header === null) return null
    const before = popup.getBoundingClientRect()
    const rect = header.getBoundingClientRect()
    const fire = (type, x, y) => header.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }))
    fire('pointerdown', rect.left + 12, rect.top + 6)
    fire('pointermove', rect.left + 92, rect.top + 66)
    fire('pointerup', rect.left + 92, rect.top + 66)
    return { before: { x: Math.round(before.left), y: Math.round(before.top) } }
  })()`)
  await delay(300)
  const moved = await cdp.evaluate(`(() => {
    const popup = document.querySelector('[data-testid="chapter-summary-popup"]')
    const rect = popup.getBoundingClientRect()
    return { x: Math.round(rect.left), y: Math.round(rect.top) }
  })()`)
  check('浮窗可以自由拖动', drag !== null && (moved.x !== drag.before.x || moved.y !== drag.before.y), `${JSON.stringify(drag?.before)} → ${JSON.stringify(moved)}`)

  // 关闭：用真实指针序列（pointerdown→pointerup→click）复现「点叉没反应」
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="chapter-summary-close"]')
    const rect = btn.getBoundingClientRect()
    const fire = (type) => btn.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, pointerId: 2 }))
    fire('pointerdown')
    fire('pointerup')
    btn.click()
  })()`)
  await delay(300)
  check('点 ✕ 能关闭浮窗（真实指针序列）', await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-popup"]') === null`))

  // 刷新后缓存仍在
  await cdp.send('Page.reload', { ignoreCache: false })
  await waitFor('刷新后应用就绪', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 60000)
  await delay(1500)
  await cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]')[3].click()`)
  await delay(300)
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  await waitFor('刷新后进入章节模式', () => cdp.evaluate(`!!document.querySelector('[data-testid="chapter-summary-open"]')`), 30000)
  await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-open"]').click()`)
  await delay(300)
  const cached = await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-text"]')?.textContent?.trim().slice(0, 20) ?? null`)
  check('刷新后缓存速览仍在（不重复调用模型）', cached !== null, cached ?? '无')

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/chapter-summary-popup.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 截图：docs/chapter-summary-popup.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
