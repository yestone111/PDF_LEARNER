#!/usr/bin/env node
/**
 * 图表/表格知识点「跳到原文」验收。
 *
 * 背景（用户反馈）：图谱里的 Table / Figure 知识点点了跳不到原文。
 * 根因：这类节点通常只有 caption、没有可逐字定位的 quote，anchor 为空，跳转被直接判失败。
 *
 * 两条链路都要绿：
 *  A. 新抽取：用 caption 去原文定位 → 生成真实锚点 → 跳过去在 caption 处画下划线；
 *  B. 旧数据（anchor 为空、只有 figure）：退化为「figure.page + caption」→ 至少落到那一页；
 *     这条用「往 IndexedDB 注入一个无锚点图表节点 + 刷新」来真实复现。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9243)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/akn-user-manual.pdf')
const PROFILE = '/tmp/akn-table-jump-profile'

let pass = 0
const failures = []
const skipped = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const skip = (name, detail = '') => { skipped.push(name); console.log(`⏭️  ${name}${detail ? ` — ${detail}` : ''}`) }
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

const READ_DIALOG = `(() => {
  const dialog = document.querySelector('[data-testid="learning-dialog"]')
  if (!dialog) return null
  const jump = document.querySelector('[data-testid="learning-jump-pdf"]')
  return {
    title: document.querySelector('[data-testid="learning-title"]')?.textContent?.trim() ?? '',
    hasFigureBlock: !!dialog.querySelector('[data-testid="figure-excerpt"]'),
    figureSrc: dialog.querySelector('[data-testid="figure-image"]')?.getAttribute('src') ?? '',
    anchorNote: dialog.querySelector('[data-testid="learning-anchor-note"]')?.textContent?.trim() ?? '',
    jumpDisabled: jump === null ? null : jump.disabled,
    jumpLabel: jump?.textContent?.trim() ?? '',
    footer: (dialog.querySelector('footer')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
  }
})()`

async function openDialog(cdp, nodeId) {
  await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]')?.click()`)
  await delay(120)
  await cdp.evaluate(`document.querySelector('[data-testid="graph-node-${nodeId}"]').click()`)
  await waitFor('学习对话框', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`), 15000)
  await delay(600)
  return cdp.evaluate(READ_DIALOG)
}

async function clickJump(cdp) {
  await cdp.evaluate(`document.querySelector('[data-testid="learning-jump-pdf"]').click()`)
  await delay(600)
  const pdfTab = await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]')?.getAttribute('aria-selected') ?? ''`)
  const indicator = await cdp.evaluate(`document.querySelector('[data-testid="page-indicator"]')?.textContent?.trim() ?? ''`)
  // 命中引文 → body 上会出现 .akn-flash-box；没命中 → 页面级闪烁 .akn-page-flash
  const flash = await waitFor('跳转后的视觉反馈', async () => {
    const state = await cdp.evaluate(`({
      boxes: document.querySelectorAll('.akn-flash-box').length,
      pageFlash: document.querySelectorAll('.akn-page-flash').length,
      status: document.body.innerText.includes('已标出该页') ? 'page-only' : '',
    })`)
    return state.boxes > 0 || state.pageFlash > 0 || state.status !== '' ? state : null
  }, 12000).catch(() => ({ boxes: 0, pageFlash: 0, status: '' }))
  return { pdfTab, indicator, flash }
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

  await cdp.evaluate(`(() => { try { window.localStorage.clear() } catch {} return true })()`)
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 30000)

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
  await waitFor('PDF 就绪', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 120000)
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
  await waitFor('抽取完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 180000)
  await delay(800)

  // ---------- A. 新抽取出来的图表节点 ----------
  const figureNodes = await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="graph-node-"][data-figure="true"]')].map((el) => ({
    id: el.getAttribute('data-testid').replace('graph-node-', ''),
    title: el.getAttribute('title') ?? '',
  }))`)
  if (figureNodes.length === 0) {
    skip('新抽取的图表节点（mock 只在含 Figure/Table caption 的块里生成）', '这份 PDF 的 mock 抽取没生成图表节点')
  } else {
    const figureNode = figureNodes[0]
    check('抽取出了图表/表格知识点', true, `${figureNode.title}（共 ${figureNodes.length} 个）`)
    const dialog = await openDialog(cdp, figureNode.id)
    check('图表节点未提供逐字引文时，对话框仍能打开', dialog !== null)
    check('对话框里能看到图表块（caption）', dialog.hasFigureBlock, dialog.figureSrc.startsWith('data:image/png') ? '含区域截图' : '仅 caption')
    check('「跳到 PDF 原文」按钮可用（不再被判为无锚点）', dialog.jumpDisabled === false, `label=${dialog.jumpLabel}`)

    const anchor = await cdp.evaluate(`new Promise((resolve) => {
      const request = indexedDB.open('ai-knowledge-navigator')
      request.onsuccess = () => {
        const db = request.result
        const get = db.transaction('knowledgeNodes', 'readonly').objectStore('knowledgeNodes').get('${figureNode.id}')
        get.onsuccess = () => resolve(get.result === undefined ? null : { page: get.result.anchor === null ? null : get.result.anchor.page, figurePage: get.result.figure?.page ?? null })
        get.onerror = () => resolve(null)
      }
      request.onerror = () => resolve(null)
    })`)
    check('caption 被用来在原文里定位出真实锚点', anchor?.page !== null && anchor?.page === anchor?.figurePage, JSON.stringify(anchor))

    const jump = await clickJump(cdp)
    check('点「跳到 PDF 原文」切到 PDF 并落到图表页', jump.pdfTab === 'true' && jump.indicator.startsWith(`${anchor?.figurePage} /`), `tab=${jump.pdfTab}, indicator=${jump.indicator}`)
    check('跳过去后原文有视觉反馈（caption 下划线或整页闪烁）', jump.flash.boxes > 0 || jump.flash.pageFlash > 0 || jump.flash.status === 'page-only', JSON.stringify(jump.flash))

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile('docs/table-jump.png', Buffer.from(shot.data, 'base64'))
    console.log('📸 截图：docs/table-jump.png')
  }

  // ---------- B. 旧数据：anchor 为空、只有 figure ----------
  const docId = await cdp.evaluate(`new Promise((resolve) => {
    const request = indexedDB.open('ai-knowledge-navigator')
    request.onsuccess = () => {
      const db = request.result
      const all = db.transaction('documents', 'readonly').objectStore('documents').getAll()
      all.onsuccess = () => resolve(all.result.sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? '')
      all.onerror = () => resolve('')
    }
    request.onerror = () => resolve('')
  })`)
  const legacyId = 'legacy-table-node-1'
  const captionText = 'Figure 1: 主界面三栏布局示意'
  const inserted = await cdp.evaluate(`new Promise((resolve) => {
    const request = indexedDB.open('ai-knowledge-navigator')
    request.onsuccess = () => {
      const db = request.result
      const now = Date.now()
      const node = {
        id: '${legacyId}',
        documentId: '${docId}',
        parentId: null,
        chapterId: null,
        scope: 'global',
        title: 'Table 1: 三栏布局（旧数据）',
        titleNorm: 'table1三栏布局旧数据',
        aliases: [],
        summary: '旧数据里图表节点只有 caption，没有可逐字定位的 quote。',
        difficulty: 3,
        importance: 4,
        importanceSource: 'llm',
        cognitiveLevel: 4,
        unitKind: 'structure',
        priorKnowledge: [],
        elaboration: null,
        selfCheck: '',
        mastery: 'unmastered',
        anchor: null,
        sourceChunkId: null,
        figure: { kind: 'caption_only', label: 'Figure 1', caption: '${captionText}', page: 6, rects: [] },
        createdAt: now,
        updatedAt: now,
      }
      const put = db.transaction('knowledgeNodes', 'readwrite').objectStore('knowledgeNodes').put(node)
      put.onsuccess = () => resolve(true)
      put.onerror = () => resolve(String(put.error))
    }
    request.onerror = () => resolve('open failed')
  })`)
  check('注入旧数据：无锚点、只有 figure 的图表节点', inserted === true, String(inserted))

  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('恢复文档', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 60000)
  // 刷新后中栏可能停在 PDF（上一次跳转留下的状态），图谱节点要切回图谱 Tab 才挂载
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]')?.click()`)
  const graphReady = () => cdp.evaluate(`!!document.querySelector('[data-testid="graph-node-${legacyId}"]')`)
  try {
    await waitFor('图谱恢复', graphReady, 30000).catch(async () => {
      // 刷新后偶发「图谱 Tab 先于 store 就绪」：再点一次 Tab，多数情况立刻渲染
      await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]')?.click()`)
      await waitFor('图谱恢复（重试）', graphReady, 30000)
    })
  } catch (error) {
    const diag = await cdp.evaluate(`(() => ({
      tab: document.querySelector('[data-testid="center-tab-graph"]')?.getAttribute('aria-selected') ?? '',
      nodes: [...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => el.getAttribute('data-testid')).slice(0, 6),
      nodeCount: document.querySelectorAll('[data-testid^="graph-node-"]').length,
      status: document.querySelector('[data-testid="graph-pane"]')?.textContent?.slice(0, 160) ?? '',
    }))()`)
    console.log('   恢复诊断:', JSON.stringify(diag))
    throw error
  }
  const legacyDialog = await openDialog(cdp, legacyId)
  check('旧图表节点（无锚点）也能打开对话框', legacyDialog !== null)
  check('旧图表节点的跳转按钮可用', legacyDialog.jumpDisabled === false)
  check('旧图表节点提示按 caption 跳到第 N 页', /caption/.test(legacyDialog.anchorNote) && /第 6 页/.test(legacyDialog.anchorNote), legacyDialog.anchorNote)
  check('底部显示「图表位置：第 6 页」', legacyDialog.footer.includes('图表位置：第 6 页'), legacyDialog.footer)

  const legacyJump = await clickJump(cdp)
  check('旧数据也能跳到图表所在页', legacyJump.pdfTab === 'true' && legacyJump.indicator.startsWith('6 /'), `indicator=${legacyJump.indicator}`)
  check('旧数据跳转后同样有视觉反馈', legacyJump.flash.boxes > 0 || legacyJump.flash.pageFlash > 0 || legacyJump.flash.status === 'page-only', JSON.stringify(legacyJump.flash))

  const legacyShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/table-jump-legacy.png', Buffer.from(legacyShot.data, 'base64'))
  console.log('📸 截图：docs/table-jump-legacy.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项，跳过 ${skipped.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
