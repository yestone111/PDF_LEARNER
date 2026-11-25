#!/usr/bin/env node
/**
 * 插件 UI 快速验收（不跑抽取，约 10 秒）：
 *  - /akn/ 能打开、底部状态栏出现
 *  - 「返回 DSH」按钮在最下面一行最右边，样式为椭圆
 *  - 点击后真的回到 DSH 源
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:3080/akn/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9230)
const SHOT = 'docs/plugin-footer.png'
const PROFILE = '/tmp/akn-ui-profile'

let pass = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const waitFor = async (desc, fn, timeoutMs = 20000) => {
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
  const target = await waitFor('CDP', async () => {
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
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 30000)

  const footer = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="app-footer"]')
    const btn = document.querySelector('[data-testid="return-to-dsh"]')
    if (!el || !btn) return null
    const f = el.getBoundingClientRect()
    const b = btn.getBoundingClientRect()
    const style = getComputedStyle(btn)
    return {
      footerBottom: Math.round(f.bottom),
      viewportHeight: window.innerHeight,
      btnRightGap: Math.round(window.innerWidth - b.right),
      btnBottomGap: Math.round(window.innerHeight - b.bottom),
      radius: style.borderRadius,
      background: style.backgroundImage.slice(0, 60),
      text: btn.textContent.trim(),
      href: btn.getAttribute('href'),
      zIndex: style.zIndex,
    }
  })()`)

  check('插件形态出现底部状态栏', footer !== null)
  if (footer !== null) {
    check('状态栏贴在页面最底部', Math.abs(footer.footerBottom - footer.viewportHeight) <= 2, `bottom=${footer.footerBottom}/${footer.viewportHeight}`)
    check('按钮在最下面一行的最右边', footer.btnRightGap <= 16 && footer.btnBottomGap <= 12, `right gap=${footer.btnRightGap}px, bottom gap=${footer.btnBottomGap}px`)
    check('按钮是椭圆（圆角 9999px/20px 级）', footer.radius !== '0px', `radius=${footer.radius}`)
    check('按钮用渐变（对齐 RTL_Cockpit 风格）', footer.background.includes('linear-gradient'), footer.background)
    check('按钮文案为「返回 DSH」', footer.text.trim() === '返回 DSH', footer.text)
    check('按钮不含任何图标/emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(footer.text), footer.text)
    check('未点击前目标是 DSH 源', footer.href !== null, footer.href ?? '')
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(SHOT, Buffer.from(shot.data, 'base64'))
  console.log(`📸 截图：${SHOT}`)

  // 点击后应真的离开 /akn/、回到 DSH 源
  await cdp.evaluate(`document.querySelector('[data-testid="return-to-dsh"]').click()`)
  await delay(1200)
  const after = await cdp.evaluate(`({ href: window.location.href, path: window.location.pathname })`)
  check('点击后真的返回 DSH（离开 /akn/）', !after.path.startsWith('/akn'), `now=${after.href}`)
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
