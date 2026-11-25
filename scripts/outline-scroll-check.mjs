#!/usr/bin/env node
/**
 * 左侧目录滚动验收：章节很多时（60 条）必须能向下滚到最后一个条目，
 * 页面本身不能被撑破。
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9237)
const PDF = resolve(process.env.AKN_PDF ?? 'fixtures/outline-many-probe.pdf')
const PROFILE = '/tmp/akn-scroll-profile'
const VIEWPORT = { width: 1280, height: 720 }

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
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`,
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, APP_URL,
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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
  })
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`))

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF] })
  await waitFor('目录加载', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]').length >= 60`), 60000)

  const state = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('[data-testid^="outline-item-"]')]
    const last = items[items.length - 1]
    const scroller = last?.closest('div[class*="overflow-y-auto"]') ?? null
    const before = scroller ? { top: scroller.scrollTop, h: scroller.clientHeight, sh: scroller.scrollHeight } : null
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    const after = scroller ? scroller.scrollTop : 0
    const lastRect = last?.getBoundingClientRect()
    const scrollerRect = scroller?.getBoundingClientRect()
    return {
      count: items.length,
      before,
      after,
      lastVisible: lastRect && scrollerRect ? lastRect.bottom <= scrollerRect.bottom + 2 && lastRect.top >= scrollerRect.top - 2 : false,
      docScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }
  })()`)

  check('目录条目数正确（60）', state.count >= 60, `${state.count} 条`)
  check('目录容器可滚动（内容超过可视高度）', state.before !== null && state.before.sh > state.before.h, state.before ? `${state.before.sh} > ${state.before.h}` : '找不到滚动容器')
  check('能滚动到底部', state.after > 0, `scrollTop=${state.after}`)
  check('最后一条目录可见', state.lastVisible === true)
  check('页面本身没有被撑出滚动条', state.docScroll <= 2, `docScroll=${state.docScroll}`)

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await import('node:fs/promises').then((fs) => fs.writeFile('docs/outline-scroll.png', Buffer.from(shot.data, 'base64')))
  console.log('📸 截图：docs/outline-scroll.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
