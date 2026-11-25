#!/usr/bin/env node
/**
 * 真实模型端到端：章节速览（整理这一章）。
 * 打开 DSH /akn/ → 上传论文 → 全局抽取 → 章节拆解 → 点「整理这一章」→ 读结果。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:3080/akn/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9242)
const PDF = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const PROFILE = '/tmp/akn-chap-live-profile'

let pass = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const waitFor = async (desc, fn, timeoutMs = 900000) => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`超时：${desc}`)
    await delay(400)
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
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 60000)

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF] })
  await waitFor('PDF 打开', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 120000)

  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  const extractionStart = Date.now()
  await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
  await waitFor('全局抽取完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 900000)
  console.log(`  全局抽取用时 ${Math.round((Date.now() - extractionStart) / 1000)}s`)

  // 进入章节模式 + 章节拆解（缓存命中，应很快）
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]').click()`)
  await delay(300)
  await cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]')[3].click()`)
  await delay(400)
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  await waitFor('章节模式', () => cdp.evaluate(`!!document.querySelector('[data-testid="chapter-select"]')`), 30000)
  await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
  await waitFor('章节拆解完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 120000)

  // 展开速览面板 + 点「整理这一章」
  await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-toggle"]')?.click()`)
  await delay(300)
  const hasGenerate = await cdp.evaluate(`!!document.querySelector('[data-testid="chapter-summary-generate"]')`)
  check('展开后有「整理这一章」按钮', hasGenerate)
  if (hasGenerate) {
    const summaryStart = Date.now()
    await cdp.evaluate(`document.querySelector('[data-testid="chapter-summary-generate"]').click()`)
    await waitFor('速览结果', () => cdp.evaluate(`!!document.querySelector('[data-testid="chapter-summary-text"]') || !!document.querySelector('[data-testid="chapter-summary-error"]')`), 180000)
    const result = await cdp.evaluate(`(() => ({
      text: document.querySelector('[data-testid="chapter-summary-text"]')?.textContent?.trim() ?? null,
      error: document.querySelector('[data-testid="chapter-summary-error"]')?.textContent?.trim() ?? null,
    }))()`)
    console.log(`  整理用时 ${Math.round((Date.now() - summaryStart) / 1000)}s`)
    if (result.text !== null) {
      check('生成了章节速览', result.text.length > 40, `${result.text.length} 字`)
      // 内容要求：逐段总结、不写学习顺序建议
      const hasStudyAdvice = /先学|再学|学习建议|建议按.*顺序|容易卡/.test(result.text)
      check('速览不含「学习顺序建议」', hasStudyAdvice === false, hasStudyAdvice ? '仍出现学习建议措辞' : '')
      const segments = result.text.split(/\n\s*\n/).filter((part) => part.trim() !== '').length
      check('速览按段落组织（≥2 段）', segments >= 2, `${segments} 段`)
      console.log('  速览开头:', result.text.slice(0, 90))

      // 关键词联动：真实速览里应能识别出知识点标题
      const keyword = await cdp.evaluate(`(() => {
        const btn = document.querySelector('[data-testid^="summary-kw-"]')
        return btn === null ? null : { id: btn.getAttribute('data-testid').replace('summary-kw-', ''), text: btn.textContent.trim() }
      })()`)
      check('速览里识别出可点关键词', keyword !== null, keyword === null ? '无' : `${keyword.text}`)
      if (keyword !== null) {
        await cdp.evaluate(`document.querySelector('[data-testid="summary-kw-${keyword.id}"]').click()`)
        await delay(400)
        const selected = await cdp.evaluate(`document.querySelector('[data-testid="graph-node-${keyword.id}"]')?.getAttribute('data-selected') ?? null`)
        check('点击关键词后图谱节点被选中', selected === 'true', `selected=${selected}`)
      }
    } else {
      check('生成了章节速览', false, `失败：${result.error}`)
    }
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/chapter-summary-live.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 截图：docs/chapter-summary-live.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
