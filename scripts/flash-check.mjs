#!/usr/bin/env node
/**
 * 「跳到 PDF 原文」闪烁验收：
 *  - 点对话框的「跳到 PDF 原文」后，切到 PDF 且目标页出现页面级闪烁；
 *  - 引文能逐字匹配时，文本层同时出现高亮闪烁；
 *  - 闪烁结束后样式被清理（不残留）。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9239)
const PDF = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const PROFILE = '/tmp/akn-flash-profile'

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
    await delay(150)
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
  await waitFor('抽取完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 120000)

  await cdp.evaluate(`document.querySelector('[data-testid^="graph-node-"]').click()`)
  await waitFor('学习对话框', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`))

  const anchorPage = await cdp.evaluate(`Number(document.querySelector('[data-testid="learning-dialog"]')?.getAttribute('data-anchor-page') ?? 0)`)
  const canJump = await cdp.evaluate(`!document.querySelector('[data-testid="learning-jump-pdf"]')?.disabled`)
  check('节点有原文锚点，跳转按钮可用', canJump, `page=${anchorPage}`)

  await cdp.evaluate(`document.querySelector('[data-testid="learning-jump-pdf"]').click()`)

  // 三种信号并发轮询（页面闪烁 2s、框 2.6s，必须先抓到再断言，不能串行等待）
  let snapshot = { page: false, boxes: 0, spans: 0 }
  try {
    snapshot = await waitFor(
      '闪烁信号',
      () =>
        cdp.evaluate(`(() => {
          const page = document.querySelector('.page.akn-page-flash') !== null
          const boxes = document.querySelectorAll('[data-testid="flash-box"]').length
          const spans = document.querySelectorAll('.textLayer span.akn-flash').length
          return page || boxes > 0 || spans > 0 ? { page, boxes, spans } : null
        })()`),
      6000,
    )
  } catch {
    snapshot = { page: false, boxes: 0, spans: 0 }
  }

  check('命中文字处出现下划线闪烁（按行）', snapshot.boxes > 0, `${snapshot.boxes} 条`)
  const underline = await cdp.evaluate(`(() => {
    const boxes = [...document.querySelectorAll('[data-testid="flash-box"]')]
    return {
      count: boxes.length,
      style: boxes[0]?.getAttribute('data-flash-style') ?? '',
      heights: boxes.map((el) => Math.round(el.getBoundingClientRect().height)),
    }
  })()`)
  check('是下划线而不是整块遮罩（高度 ≤ 4px）', underline.count === 0 || (underline.style === 'underline' && underline.heights.every((h) => h <= 4)), `heights=${underline.heights.slice(0, 4).join(',')}`)
  check('命中时不整页闪（只有框）', snapshot.boxes === 0 || snapshot.page === false)
  check('原文处出现文字高亮', snapshot.spans > 0, `${snapshot.spans} 个 span`)
  check('有明确视觉反馈（页面闪烁或文字框至少一个）', snapshot.page || snapshot.boxes > 0)

  const activeTab = await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]')?.getAttribute('aria-selected') ?? ''`)
  check('已经切到 PDF 视图', activeTab === 'true', activeTab)

  await delay(3200)
  const leftover = await cdp.evaluate(`document.querySelectorAll('.akn-flash, .akn-page-flash, [data-testid="flash-box"]').length`)
  check('闪烁结束后样式被清理', leftover === 0, `leftover=${leftover}`)

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/flash-jump.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 截图：docs/flash-jump.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
