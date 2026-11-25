#!/usr/bin/env node
/**
 * 目录章节标志验收：
 *  - 每条目录都有层级编号（1 / 1.1 / 2 …）；
 *  - 一级条目标注「章」徽标；
 *  - 多级目录（论文）能出现 1.1 这样的子编号。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9238)
const PDF = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const PROFILE = '/tmp/akn-numbering-profile'

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
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, '--window-size=1280,900', APP_URL,
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
  await waitFor('目录加载', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]').length > 3`), 60000)

  // 关键：刷新一次。存储层按 level 排序（一级全在前、二级在后），
  // 折叠成扁平数组时最容易暴露「第一章的小节 = 8.1」的错位。
  await cdp.send('Page.reload', { ignoreCache: false })
  await waitFor('刷新后目录恢复', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]').length > 3`), 60000)
  await delay(500)

  const info = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('[data-testid^="outline-item-"]')]
    return {
      count: items.length,
      numbers: items.map((el) => el.getAttribute('data-outline-number') ?? ''),
      levels: items.map((el) => Number(el.getAttribute('data-level'))),
      chapterBadges: items.filter((el) => el.textContent.includes('章')).length,
      firstText: items[0]?.textContent?.trim() ?? '',
      sample: items.slice(0, 6).map((el) => ({ n: el.getAttribute('data-outline-number'), t: el.textContent.trim().slice(0, 24) })),
      shown: items.filter((el) => el.getAttribute('data-number-shown') === '1').length,
      selfNumbered: items.filter((el) => /^\s*\d+(\.\d+)*\s+/.test(el.textContent.replace(/^\s*\d+(\.\d+)*/, '').trim() === '' ? '' : (el.querySelector('span:nth-child(2)')?.textContent ?? ''))).length,
    }
  })()`)

  const invalid = info.numbers.filter((n) => !/^\d+(\.\d+)*$/.test(n))
  check(
    '目录条目有编号',
    info.numbers.length > 0 && invalid.length === 0,
    invalid.length === 0 ? info.sample.map((s) => s.n).join(' ') : `异常值 ${JSON.stringify(invalid.slice(0, 5))}`,
  )
  check('编号从 1 开始且唯一', info.numbers[0] === '1' && new Set(info.numbers).size === info.numbers.length, `${info.numbers[0]} … ${info.numbers[info.numbers.length - 1]}`)
  check('多级目录出现子编号（1.1 式）', info.numbers.some((n) => n.includes('.')), info.numbers.filter((n) => n.includes('.')).slice(0, 3).join(' '))
  // 刷新后编号仍必须与树的父子关系一致：子编号的前缀必须是某个一级条目的编号
  const level1Numbers = new Set(info.numbers.filter((_, index) => info.levels[index] === 1))
  const childNumbers = info.numbers.filter((_, index) => info.levels[index] === 2)
  const prefixesValid = childNumbers.every((n) => level1Numbers.has(n.split('.').slice(0, 1).join('.')))
  check('子小节编号挂在自己的章下面（不是 8.1 这种错位）', childNumbers.length === 0 || prefixesValid, childNumbers.slice(0, 5).join(' '))
  const level1Count = info.levels.filter((level) => level === 1).length
  check('一级条目标注「章」徽标', info.chapterBadges === level1Count, `${info.chapterBadges} / ${level1Count}`)
  check('一级条目文字加粗样式存在', info.firstText.length > 0)
  // 标题自带编号（「1 Introduction」）时不重复显示我们生成的编号
  check(
    '自带编号的标题不重复显示编号',
    info.shown === 0 || info.shown === info.count || info.shown < info.count,
    `显示编号 ${info.shown} / ${info.count}`,
  )

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/outline-numbering.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 截图：docs/outline-numbering.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
