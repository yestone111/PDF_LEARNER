#!/usr/bin/env node
/**
 * 书签编码验收：
 *  1) 本产品生成的中文手册 → 目录必须是正常中文（UTF-16BE 书签）；
 *  2) GBK 字节书签的第三方 PDF（fixtures/outline-gbk-probe.pdf）→ 应用要自动还原成中文。
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:3080/akn/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9232)
const PROFILE = '/tmp/akn-outline-profile'

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

// 只读标题本身：行里还有 DFS 编号、「章」徽标和页码，textContent 会把它们混进来（那是模板问题，不是编码问题）
const READ_OUTLINE = `(() => [...document.querySelectorAll('[data-testid^="outline-item-"]')].map((el) => (el.querySelector('[data-outline-title]')?.textContent ?? '').trim()))()`

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

  const upload = async (path) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [resolve(path)] })
    await waitFor(`打开 ${path}`, () => cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]').length > 0`), 120000)
    await delay(600)
    return cdp.evaluate(READ_OUTLINE)
  }

  // 1) 手册（UTF-16BE 书签）
  const manual = await upload('fixtures/akn-user-manual.pdf')
  check('手册目录条数正确', manual.length === 13, `items=${manual.length}`)
  check('手册第一条是「目录」而不是乱码', manual[0] === '目录', manual[0])
  check('手册章节标题是正常中文', manual.slice(0, 4).every((t) => /[\u4e00-\u9fff]/.test(t)), manual.slice(0, 4).join(' / '))
  check('目录里不出现典型的 UTF-8 误解码乱码', !manual.some((t) => /[ÃÂåç]/.test(t)), manual.join(' ').slice(0, 60))

  // 2) GBK 书签的第三方 PDF → 应用端修复
  const probe = await upload('fixtures/outline-gbk-probe.pdf')
  check('GBK 书签被还原（pdf.js 原始解出是「Ä¿Â¼」）', probe[0] === '目录', probe[0] ?? '')
  check('第二条 GBK 标题也被还原', probe[1] === '第一章', probe[1] ?? '')

  // 3) 旧版手册同款：UTF-8 字节书签，标题含「习」（0xA0 → € 的坑）
  const utf8Probe = await upload('fixtures/outline-utf8-probe.pdf')
  check(
    'UTF-8 书签含「习」也能还原（旧手册第 4 章）',
    utf8Probe[0] === '4 第一次学习：五步走',
    utf8Probe[0] ?? '',
  )
  check(
    'UTF-8 书签含「习」也能还原（旧手册第 5 章）',
    utf8Probe[1] === '5 学习对话框详解',
    utf8Probe[1] ?? '',
  )
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
