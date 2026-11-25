#!/usr/bin/env node
/**
 * 主题验收：默认羊皮卷、可切夜读、刷新后保持、颜色真的变了。
 * 用法：node scripts/theme-check.mjs   （默认打 http://127.0.0.1:3080/akn/）
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:3080/akn/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9231)
const PROFILE = '/tmp/akn-theme-profile'

let pass = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const waitFor = async (desc, fn, timeoutMs = 30000) => {
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

const snapshot = `(() => {
  const root = document.documentElement
  const body = getComputedStyle(document.body)
  const panel = document.querySelector('[data-testid="panel-left"]')
  return {
    theme: root.dataset.theme,
    bodyBg: body.backgroundColor,
    bodyInk: body.color,
    panelBg: panel ? getComputedStyle(panel).backgroundColor : '',
    gridLine: getComputedStyle(root).getPropertyValue('--akn-grid').trim(),
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
  })
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, reject) => {
    socket.addEventListener('open', ok, { once: true })
    socket.addEventListener('error', () => reject(new Error('ws failed')), { once: true })
  })
  const cdp = new Cdp(socket)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="theme-switch"]')`))

  const parchment = await cdp.evaluate(snapshot)
  check('默认主题是羊皮卷', parchment.theme === 'parchment', parchment.theme)
  check('默认背景是暖纸色 #f4ead6', parchment.bodyBg === 'rgb(244, 234, 214)', parchment.bodyBg)
  check('默认文字是深棕（阅读友好）', parchment.bodyInk === 'rgb(59, 48, 37)', parchment.bodyInk)

  let shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/theme-parchment.png', Buffer.from(shot.data, 'base64'))

  await cdp.evaluate(`document.querySelector('[data-testid="theme-night"]').click()`)
  await delay(400)
  const night = await cdp.evaluate(snapshot)
  check('可切换到夜读主题', night.theme === 'night', night.theme)
  check('夜读背景变深色', night.bodyBg === 'rgb(11, 16, 32)', night.bodyBg)
  check('面板/网格线也随之变化', night.panelBg !== parchment.panelBg && night.gridLine !== parchment.gridLine, `${parchment.panelBg} → ${night.panelBg}`)
  shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/theme-night.png', Buffer.from(shot.data, 'base64'))

  await cdp.send('Page.reload', { ignoreCache: false })
  await delay(1200)
  await waitFor('刷新后应用就绪', () => cdp.evaluate(`!!document.querySelector('[data-testid="theme-switch"]')`))
  const afterReload = await cdp.evaluate(snapshot)
  check('刷新后主题保持夜读（持久化生效）', afterReload.theme === 'night', afterReload.theme)
  check('刷新后没有先闪一下浅色（首屏脚本生效）', afterReload.bodyBg === 'rgb(11, 16, 32)', afterReload.bodyBg)

  await cdp.evaluate(`document.querySelector('[data-testid="theme-parchment"]').click()`)
  await delay(300)
  const back = await cdp.evaluate(snapshot)
  check('可切回羊皮卷', back.theme === 'parchment' && back.bodyBg === 'rgb(244, 234, 214)', back.bodyBg)

  console.log('📸 截图：docs/theme-parchment.png / docs/theme-night.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
