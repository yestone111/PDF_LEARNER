#!/usr/bin/env node
/**
 * 笔记侧独立滚动验收。
 *
 * 用户反馈：「笔记侧不能单独上下翻滚」—— 笔记内容变长后应该只滚动右栏，
 * 页面整体 / PDF 区不能被顶出视口。这里把编辑器写成超长内容，
 * 然后检查：右栏内部有独立滚动容器、能滚、页面本身不跟着滚。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9249)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/akn-user-manual.pdf')
const PROFILE = '/tmp/akn-notes-scroll-profile'

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
    await delay(120)
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

/** 从编辑器往上找「真正能滚」的容器，并记录页面是否被顶出视口。 */
const PROBE = `(() => {
  const describe = (el) => {
    if (el === null) return null
    const cs = getComputedStyle(el)
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') ?? '',
      overflowY: cs.overflowY,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
      height: Math.round(el.getBoundingClientRect().height),
    }
  }
  const editor = document.querySelector('[data-testid="note-editor"]')
  const chain = []
  let node = editor
  for (let depth = 0; depth < 8 && node !== null; depth += 1) {
    chain.push(describe(node))
    node = node.parentElement
  }
  const scroller = chain.find((item) => item !== null && item.scrollHeight > item.clientHeight + 8)
  const doc = document.scrollingElement
  return {
    chain,
    scroller,
    page: {
      scrollHeight: doc === null ? 0 : doc.scrollHeight,
      clientHeight: doc === null ? 0 : doc.clientHeight,
      innerHeight: window.innerHeight,
    },
    center: describe(document.querySelector('[data-testid="panel-center"]')),
    centerTop: (() => { const el = document.querySelector('[data-testid="panel-center"]'); return el === null ? -1 : Math.round(el.getBoundingClientRect().top) })(),
  }
})()`

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

  await cdp.evaluate(`(() => { try { window.localStorage.clear() } catch {} return true })()`)
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 30000)

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
  await waitFor('PDF 打开', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 120000)

  await cdp.evaluate(`document.querySelector('[data-testid="tab-notes"]').click()`)
  await waitFor('笔记编辑器', () => cdp.evaluate(`!!document.querySelector('[data-testid="note-editor"]')`), 30000)
  await delay(600)

  // 写 120 段，远超一屏
  await cdp.evaluate(`document.querySelector('[data-testid="note-editor"]').focus()`)
  const lines = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 段：用来把笔记写得很长，验证右栏能自己滚动。`).join('\n')
  await cdp.send('Input.insertText', { text: lines })
  await delay(700)

  let probe = await cdp.evaluate(PROBE)
  check('笔记内容已超过一屏', probe.scroller !== null && probe.scroller.scrollHeight > probe.scroller.clientHeight + 100,
    probe.scroller === null ? '找不到可滚动容器' : `${probe.scroller.scrollHeight} > ${probe.scroller.clientHeight}`)
  check('滚动发生在笔记侧（不是整个页面）', probe.page.scrollHeight <= probe.page.innerHeight + 2,
    `page=${probe.page.scrollHeight}/${probe.page.innerHeight}`)

  // 1) 程序化滚动：scrollTop 生效
  const scrolled = await cdp.evaluate(`(() => {
    const editor = document.querySelector('[data-testid="note-editor"]')
    let node = editor
    while (node !== null && !(node.scrollHeight > node.clientHeight + 8)) node = node.parentElement
    if (node === null) return { ok: false }
    // 输入结束时容器通常停在底部，先归零再设 240，验证能滚到任意位置
    node.scrollTop = 0
    const atTop = node.scrollTop
    node.scrollTop = 240
    return {
      ok: atTop === 0 && node.scrollTop >= 200,
      before: atTop,
      after: node.scrollTop,
      testid: node.getAttribute('data-testid') ?? '',
      overflowY: getComputedStyle(node).overflowY,
    }
  })()`)
  check('右栏能独立滚动到 240px 以后', scrolled.ok === true, JSON.stringify(scrolled))

  const afterCenter = await cdp.evaluate(`(() => {
    const center = document.querySelector('[data-testid="panel-center"]')
    const rect = center.getBoundingClientRect()
    const doc = document.scrollingElement
    return { top: Math.round(rect.top), pageScrollTop: doc === null ? 0 : doc.scrollTop }
  })()`)
  check('滚动笔记不会带动中栏', afterCenter.top === probe.centerTop, `center top ${probe.centerTop} → ${afterCenter.top}`)
  check('滚动笔记不会带动整页', afterCenter.pageScrollTop === 0, `pageScrollTop=${afterCenter.pageScrollTop}`)

  // 2) 真实滚轮事件：鼠标在笔记区中心向下滚，scrollTop 必须增加
  await cdp.evaluate(`(() => {
    const editor = document.querySelector('[data-testid="note-editor"]')
    let node = editor
    while (node !== null && !(node.scrollHeight > node.clientHeight + 8)) node = node.parentElement
    if (node !== null) node.scrollTop = 0
    return true
  })()`)
  const wheelPoint = await cdp.evaluate(`(() => {
    const body = document.querySelector('[data-testid="right-dock-body"]')
    const rect = body.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: wheelPoint.x, y: wheelPoint.y, deltaX: 0, deltaY: 300,
  })
  await delay(400)
  const wheelResult = await cdp.evaluate(`(() => {
    const editor = document.querySelector('[data-testid="note-editor"]')
    let node = editor
    while (node !== null && !(node.scrollHeight > node.clientHeight + 8)) node = node.parentElement
    return { scrollTop: node === null ? -1 : node.scrollTop }
  })()`)
  check('真实滚轮在笔记区能滚动（事件不被外层吞掉）', wheelResult.scrollTop > 50, `scrollTop=${wheelResult.scrollTop}`)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/notes-scroll.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 截图：docs/notes-scroll.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
