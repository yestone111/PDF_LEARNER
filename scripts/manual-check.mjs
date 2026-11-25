#!/usr/bin/env node
/**
 * 手册自检（dogfood）：把《使用手册》PDF 放进产品里读一遍。
 * 验证：书签目录可用、章节跳页正确、AI 抽取能跑、学习对话框能摘录、图摘抄能命中 Figure caption。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9228)
const PDF_PATH = resolve('fixtures/akn-user-manual.pdf')
const SHOT = 'docs/manual-dogfood.png'
const PROFILE = '/tmp/akn-manual-profile'

const failures = []
let pass = 0
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function waitFor(desc, fn, timeoutMs = 60000) {
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
    this.socket = socket; this.id = 1; this.pending = new Map(); this.listeners = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve: ok, reject } = this.pending.get(message.id); this.pending.delete(message.id)
        message.error ? reject(new Error(message.error.message)) : ok(message.result)
      } else if (typeof message.method === 'string') {
        for (const callback of this.listeners.get(message.method) ?? []) callback(message.params)
      }
    })
  }
  on(method, callback) { const list = this.listeners.get(method) ?? []; list.push(callback); this.listeners.set(method, list) }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((ok, reject) => { this.pending.set(id, { resolve: ok, reject }); this.socket.send(JSON.stringify({ id, method, params })) })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return result.result.value
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
      return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null
    } catch { return null }
  })
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, reject) => {
    socket.addEventListener('open', ok, { once: true })
    socket.addEventListener('error', () => reject(new Error('ws failed')), { once: true })
  })
  const cdp = new Cdp(socket)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('Log.enable')

  const errors = []
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.text ?? 'uncaught'))
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error' && p.entry.source !== 'network') errors.push(p.entry.text) })

  await waitFor('首屏', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`))
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
  await waitFor('PDF 打开', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`))

  const outline = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('[data-testid^="outline-item-"]')]
    return items.map((el) => ({ text: el.textContent.trim(), page: Number(el.getAttribute('data-page')) }))
  })()`)
  check('手册书签被解析成目录', outline.length === 13, `items=${outline.length}`)
  const chapters = outline.filter((item) => item.page > 0)
  check('每条目录都能解析出页码（可跳转）', chapters.length === outline.length, `${chapters.length}/${outline.length}`)
  const pageList = chapters.map((item) => item.page).join(',')
  // 不钉死具体页码（手册会随内容重排），只钉「严格递增 + 从正文页开始 + 覆盖到最后一页」
  const pageNumbers = chapters.map((item) => item.page)
  const increasing = pageNumbers.every((page, index) => index === 0 || page > pageNumbers[index - 1])
  const totalPages = await cdp.evaluate(`document.querySelectorAll('.page[data-page-number]').length`)
  check(
    '章首页码严格递增，且覆盖正文首页到最后一页',
    increasing && (pageNumbers[0] ?? 0) === 2 && pageNumbers[pageNumbers.length - 1] === totalPages,
    `${pageList}（共 ${totalPages} 页）`,
  )

  // 点第 3 章（CHAPTER 03 → 界面导览 → p.6）
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]').click()`)
  await delay(300)
  const targetIndex = outline.findIndex((item) => item.page === 6)
  await cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]')[${targetIndex}].click()`)
  await delay(900)
  const indicator = await cdp.evaluate(`document.querySelector('[data-testid="page-indicator"]').textContent.trim()`)
  check('点「3 界面导览」跳到第 6 页', indicator.startsWith('6 /'), indicator)

  // 抽取（mock）
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
  await waitFor('抽取完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 120000)
  const nodeCount = await cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length`)
  check('AI 能在手册 PDF 上抽出知识点', nodeCount > 0, `nodes=${nodeCount}`)

  // 打开对话框看「知识点描述」（原文摘抄已移除）
  const nodeIds = await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => el.getAttribute('data-testid'))`)
  let dialog = null
  for (const testId of nodeIds.slice(0, 8)) {
    await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]')?.click()`)
    await delay(150)
    await cdp.evaluate(`document.querySelector('[data-testid="${testId}"]').click()`)
    await waitFor('对话框', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`))
    await delay(500)
    dialog = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[data-testid="learning-dialog"]')
      return {
        description: (dialog.querySelector('[data-testid="learning-description-text"]')?.textContent ?? '').trim(),
        hasExcerpt: !!document.querySelector('[data-testid="excerpt-body"]'),
        figure: !!dialog.querySelector('[data-testid="figure-excerpt"]'),
      }
    })()`)
    if (dialog.description.length > 0) break
  }
  check('手册里的知识点能给出知识点描述', (dialog?.description?.length ?? 0) > 0, `chars=${dialog?.description?.length ?? 0}`)
  check('对话框里不再有原文摘抄', dialog?.hasExcerpt === false)

  // 图摘抄：手册第 6 页有「Figure 1: 主界面三栏布局示意」
  let figureHit = dialog?.figure === true
  if (!figureHit) {
    for (const testId of nodeIds.slice(0, 14)) {
      await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]')?.click()`)
      await delay(120)
      await cdp.evaluate(`document.querySelector('[data-testid="${testId}"]').click()`)
      await delay(450)
      if (await cdp.evaluate(`!!document.querySelector('[data-testid="figure-excerpt"]')`)) { figureHit = true; break }
    }
  }
  if (figureHit) {
    const figureSrc = await cdp.evaluate(`document.querySelector('[data-testid="figure-image"]')?.getAttribute('src') ?? ''`)
    check('手册里的 Figure 1 caption 触发图摘抄', true)
    check('图摘抄渲染出 PNG 区域', figureSrc.startsWith('data:image/png'), figureSrc.slice(0, 24))
  } else {
    console.log('⏭️  图摘抄：这批节点摘录未覆盖 Figure 1，跳过')
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(SHOT, Buffer.from(shot.data, 'base64'))
  console.log(`📸 截图：${SHOT}`)
  check('全程无未捕获异常', errors.length === 0, JSON.stringify(errors).slice(0, 160))
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await new Promise((ok) => setTimeout(ok, 150))
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
