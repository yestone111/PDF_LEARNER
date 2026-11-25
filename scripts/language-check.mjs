#!/usr/bin/env node
/**
 * 主要语言验收：
 *  1) 默认简体中文，切换后刷新保持；
 *  2) 真实模型验证：用**英文提问** + 语言=简体中文 → 回答应是中文（证明指令生效）。
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:3080/akn/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9233)
const PDF = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const PROFILE = '/tmp/akn-lang-profile'

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
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, '--window-size=1440,900', APP_URL,
], { stdio: 'ignore' })
chrome.unref()
process.on('exit', () => { if (!chrome.killed) chrome.kill('SIGKILL') })

const CJK = /[\u4e00-\u9fff]/

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
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="language-select"]')`))

  const readLang = () => cdp.evaluate(`document.querySelector('[data-testid="language-select"]').value`)
  check('默认主要语言是简体中文', (await readLang()) === 'zh-CN', await readLang())

  await cdp.evaluate(`(() => {
    const select = document.querySelector('[data-testid="language-select"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'en')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await delay(300)
  check('可切换为 English', (await readLang()) === 'en')

  await cdp.send('Page.reload', { ignoreCache: false })
  await delay(1200)
  await waitFor('刷新后就绪', () => cdp.evaluate(`!!document.querySelector('[data-testid="language-select"]')`))
  check('刷新后语言选择保持', (await readLang()) === 'en')

  // 切回中文，做真实模型验证
  await cdp.evaluate(`(() => {
    const select = document.querySelector('[data-testid="language-select"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'zh-CN')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await delay(300)

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF] })
  await waitFor('PDF 打开', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 120000)

  await cdp.evaluate(`document.querySelector('[data-testid="tab-chat"]').click()`)
  await cdp.evaluate(`document.querySelector('[data-testid="chat-input"]').focus()`)
  await cdp.send('Input.insertText', { text: 'Summarize the core contribution of this paper in one sentence.' })
  await cdp.evaluate(`document.querySelector('[data-testid="chat-send"]').click()`)

  await waitFor('回答完成', () =>
    cdp.evaluate(`!!document.querySelector('[data-testid="chat-message-assistant"][data-status="done"]')`),
  { timeoutMs: 120000 })

  const answer = await cdp.evaluate(
    `document.querySelector('[data-testid="chat-message-assistant"]')?.textContent ?? ''`,
  )
  const cjkCount = [...answer].filter((char) => CJK.test(char)).length
  check(
    '英文提问 + 中文语言设置 → 模型用中文回答（指令生效）',
    cjkCount >= 5,
    `中文字符 ${cjkCount} 个 · 开头：「${answer.trim().slice(0, 40)}」`,
  )
  check('回答带引注（引文保留原文语言）', (await cdp.evaluate(`document.querySelectorAll('[data-testid="citation-verified"], [data-testid="citation-unverified"]').length`)) > 0)
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
