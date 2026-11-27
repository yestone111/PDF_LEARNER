#!/usr/bin/env node
/**
 * 短引文（中文术语）跳转高亮验收 —— 用户反馈「零拷贝卸载」点了跳原文没有下划线。
 *
 * 根因：`flashQuoteInPage` 用 `quote.length < 6` 一刀切，5 个汉字的术语被判成「太短不可定位」，
 * 于是只整页闪、没有下划线。修法：改成「权重」判断（CJK 记 2，拉丁记 1，阈值 6），
 * 并把降级原因显示在 PDF 头部（以前写进 error 字段，PDF 打开时根本不渲染）。
 *
 * 本脚本往 IndexedDB 注入四条真实节点来复现：
 *  A. 4 字中文引文「三栏布局」（权重 8）→ 必须画出下划线闪烁；
 *  B. 2 字引文「布局」（权重 4）→ 明确降级：整页闪 + 头部提示，不假装命中；
 *  C. 没有任何锚点、只有标题「界面导览」→ 按标题在原文里搜到并画下划线（用户「点了没反应」的主因）；
 *  D. 没有锚点、标题在原文里不存在 → 明确提示「没能在 PDF 里找到」，不猜页码。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9245)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/akn-user-manual.pdf')
const PROFILE = '/tmp/akn-flash-short-profile'

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

const SHORT_ID = 'flash-short-cjk-node'
const TINY_ID = 'flash-tiny-cjk-node'
const TITLE_ONLY_ID = 'flash-title-only-node'
const MISSING_TITLE_ID = 'flash-missing-title-node'

const readIdb = (expression) => `new Promise((resolve) => { ${expression} })`

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
  console.log('· CDP 已连接')

  // 每次跑都从「无上次文档」开始，避免把别人的数据混进来
  await cdp.evaluate(`(() => { try { window.localStorage.clear() } catch {} return true })()`)
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 30000)

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
  console.log('· 已上传 PDF，等渲染')
  await waitFor('PDF 打开', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 120000)
  await waitFor('目录加载', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]').length > 3`), 60000)

  console.log('· 目录就绪，开始注入节点')
  // 注入两条节点：一条 4 字引文（可搜索），一条 2 字引文（不可搜索）
  const injectExpr = readIdb(`
    const watchdog = setTimeout(() => resolve('watchdog'), 6000)
    const request = indexedDB.open('ai-knowledge-navigator')
    request.onblocked = () => { clearTimeout(watchdog); resolve('blocked') }
    request.onerror = () => { clearTimeout(watchdog); resolve('open-error:' + String(request.error)) }
    request.onsuccess = () => {
      clearTimeout(watchdog)
      const db = request.result
      let docs
      try {
        docs = db.transaction('documents', 'readonly').objectStore('documents').getAll()
      } catch (error) {
        return resolve('tx-error:' + String(error) + '|v=' + db.version + '|stores=' + [...db.objectStoreNames].join(','))
      }
      docs.onsuccess = () => {
        const documentId = docs.result.sort((a, b) => b.createdAt - a.createdAt)[0]?.id
        if (documentId === undefined) return resolve('no-document')
        const now = Date.now()
        const make = (id, title, quote) => ({
          id,
          documentId,
          parentId: null,
          chapterId: null,
          scope: 'global',
          title,
          titleNorm: title.toLowerCase(),
          aliases: [],
          summary: '为「短引文跳转高亮」验收注入的节点。',
          difficulty: 3,
          importance: 4,
          importanceSource: 'llm',
          cognitiveLevel: 2,
          unitKind: 'concept',
          priorKnowledge: [],
          elaboration: null,
          selfCheck: '',
          mastery: 'unmastered',
          anchor: { page: 6, quote, rects: [] },
          sourceChunkId: null,
          figure: null,
          createdAt: now,
          updatedAt: now,
        })
        const makeTitleOnly = (id, title) => ({
          ...make(id, title, ''),
          anchor: null,
        })
        const txn = db.transaction('knowledgeNodes', 'readwrite')
        const store = txn.objectStore('knowledgeNodes')
        store.put(make('${SHORT_ID}', '短词锚点：三栏布局', '三栏布局'))
        store.put(make('${TINY_ID}', '过短锚点：布局', '布局'))
        store.put(makeTitleOnly('${TITLE_ONLY_ID}', '界面导览'))
        store.put(makeTitleOnly('${MISSING_TITLE_ID}', '量子纠缠与超导计算机'))
        txn.oncomplete = () => resolve('ok')
        txn.onerror = () => resolve(String(txn.error))
        txn.onabort = () => resolve('aborted')
      }
      docs.onerror = () => resolve('documents-error')
    }
    request.onerror = () => resolve('open-error')
  `)

  // 写库用 Promise.race 兜底：IndexedDB 事件漏触发时不要静默挂住整个验收
  let injected = 'not-run'
  try {
    injected = await Promise.race([
      cdp.evaluate(injectExpr),
      delay(12000).then(() => 'evaluate-timeout'),
    ])
  } catch (error) {
    injected = `throw:${String(error)}`
  }
  check('注入短引文节点（4 字 / 2 字）', injected === 'ok', String(injected))

  console.log('· 注入完成，刷新页面')
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('恢复文档', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 60000)
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]')?.click()`)
  await waitFor('图谱恢复（含注入节点）', () => cdp.evaluate(`!!document.querySelector('[data-testid="graph-node-${SHORT_ID}"]') && !!document.querySelector('[data-testid="graph-node-${TINY_ID}"]') && !!document.querySelector('[data-testid="graph-node-${TITLE_ONLY_ID}"]') && !!document.querySelector('[data-testid="graph-node-${MISSING_TITLE_ID}"]')`), 60000)

  const jumpFromNode = async (nodeId) => {
    await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]')?.click()`)
    await delay(120)
    await cdp.evaluate(`document.querySelector('[data-testid="graph-node-${nodeId}"]').click()`)
    await waitFor('学习对话框', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`), 15000)
    await delay(300)
    const disabled = await cdp.evaluate(`document.querySelector('[data-testid="learning-jump-pdf"]')?.disabled`)
    await cdp.evaluate(`document.querySelector('[data-testid="learning-jump-pdf"]').click()`)
    return { disabled }
  }

  // ---------- A. 4 字中文引文：必须有下划线闪烁 ----------
  const a = await jumpFromNode(SHORT_ID)
  check('4 字中文术语的跳转按钮可用', a.disabled === false)
  let boxes = 0
  try {
    boxes = await waitFor(
      '下划线闪烁',
      () => cdp.evaluate(`document.querySelectorAll('[data-testid="flash-box"]').length`),
      8000,
    )
  } catch {
    boxes = 0
  }
  check('4 字中文术语能画出下划线闪烁（此前被判「太短」直接跳过）', boxes > 0, `${boxes} 条`)
  const boxInfo = await cdp.evaluate(`(() => {
    const boxes = [...document.querySelectorAll('[data-testid="flash-box"]')]
    return {
      style: boxes[0]?.getAttribute('data-flash-style') ?? '',
      heights: boxes.map((el) => Math.round(el.getBoundingClientRect().height)),
      hint: document.querySelector('[data-testid="pdf-flash-hint"]')?.textContent?.trim() ?? '',
    }
  })()`)
  check('画的是下划线（高 ≤ 4px）而不是遮罩', boxInfo.hint === '' && boxInfo.heights.every((h) => h <= 4), `heights=${boxInfo.heights.slice(0, 4).join(',')}, hint=${boxInfo.hint || '无'}`)

  // ---------- B. 2 字引文：明确降级（整页闪 + 头部提示） ----------
  // 先把上一条的下划线/整页闪烁等干净（2.6s 自动清理），否则会误判「这条也画了框」
  await waitFor('上一条闪烁清理完毕', async () => (await cdp.evaluate(`document.querySelectorAll('[data-testid="flash-box"]').length`)) === 0, 8000)
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]')?.click()`)
  await delay(200)
  const boxesBeforeB = await cdp.evaluate(`document.querySelectorAll('[data-testid="flash-box"]').length`)
  const b = await jumpFromNode(TINY_ID)
  check('2 字引文的跳转按钮仍可用（至少能跳页）', b.disabled === false)
  const fallback = await waitFor(
    '整页闪烁或降级提示',
    () => cdp.evaluate(`(() => {
      const page = document.querySelector('.page.akn-page-flash') !== null
      const hint = document.querySelector('[data-testid="pdf-flash-hint"]')?.textContent?.trim() ?? ''
      return page || hint !== '' ? { page, hint } : null
    })()`),
    8000,
  ).catch(() => ({ page: false, hint: '' }))
  const boxesAfterB = await cdp.evaluate(`document.querySelectorAll('[data-testid="flash-box"]').length`)
  check('过短引文不假装命中（没有画出下划线框）', boxesAfterB === boxesBeforeB, `before=${boxesBeforeB}, after=${boxesAfterB}`)
  check('整页闪烁作为兜底反馈', fallback.page === true)
  check('头部提示说明降级原因（以前写进不渲染的 error 字段，用户看不到）', /太短|未能逐字匹配/.test(fallback.hint), fallback.hint)

  // ---------- C. 没有锚点、只有标题：按标题在原文里搜到并画下划线 ----------
  await waitFor('上一条闪烁清理完毕', async () => (await cdp.evaluate(`document.querySelectorAll('[data-testid="flash-box"]').length`)) === 0, 8000)
  await waitFor('上一条提示条已自动消失', () => cdp.evaluate(`!document.querySelector('[data-testid="pdf-flash-hint"]')`), 10000)
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]')?.click()`)
  await delay(200)
  await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]')?.click()`)
  await delay(120)
  await cdp.evaluate(`document.querySelector('[data-testid="graph-node-${TITLE_ONLY_ID}"]').click()`)
  await waitFor('学习对话框（无锚点节点）', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`), 15000)
  await delay(300)
  const titleOnlyDialog = await cdp.evaluate(`(() => ({
    disabled: document.querySelector('[data-testid="learning-jump-pdf"]')?.disabled,
    footer: (document.querySelector('[data-testid="learning-dialog"] footer')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    note: document.querySelector('[data-testid="learning-anchor-note"]')?.textContent?.trim() ?? '',
  }))()`)
  check('无锚点节点的跳转按钮可用（以前是灰的/点了没反应）', titleOnlyDialog.disabled === false)
  check('底部说明「按标题在 PDF 中搜索」', /按标题/.test(titleOnlyDialog.footer), titleOnlyDialog.footer)
  check('描述区提示按标题搜索而不是「无法跳转」', /按标题/.test(titleOnlyDialog.note), titleOnlyDialog.note)

  await cdp.evaluate(`document.querySelector('[data-testid="learning-jump-pdf"]').click()`)
  let titleBoxes = 0
  try {
    titleBoxes = await waitFor(
      '标题兜底定位画出下划线',
      () => cdp.evaluate(`document.querySelectorAll('[data-testid="flash-box"]').length`),
      15000,
    )
  } catch {
    titleBoxes = 0
  }
  check('无锚点节点按标题在原文里定位并画出下划线', titleBoxes > 0, `${titleBoxes} 条`)
  const titleJump = await cdp.evaluate(`(() => ({
    page: document.querySelector('[data-testid="page-indicator"]')?.textContent?.trim() ?? '',
    hint: document.querySelector('[data-testid="pdf-flash-hint"]')?.textContent?.trim() ?? '',
  }))()`)
  check('跳到了标题所在的页（第 6 页）', titleJump.page.startsWith('6 /'), titleJump.page)
  check('标题命中时不报降级提示', titleJump.hint === '', titleJump.hint || '无')

  // ---------- D. 标题在原文里不存在：明确提示，不猜页码 ----------
  await waitFor('上一条闪烁清理完毕', async () => (await cdp.evaluate(`document.querySelectorAll('[data-testid="flash-box"]').length`)) === 0, 8000)
  await waitFor('上一条提示条已自动消失', () => cdp.evaluate(`!document.querySelector('[data-testid="pdf-flash-hint"]')`), 10000)
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]')?.click()`)
  await delay(200)
  await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]')?.click()`)
  await delay(120)
  await cdp.evaluate(`document.querySelector('[data-testid="graph-node-${MISSING_TITLE_ID}"]').click()`)
  await waitFor('学习对话框（标题不存在）', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`), 15000)
  await delay(200)
  await cdp.evaluate(`document.querySelector('[data-testid="learning-jump-pdf"]').click()`)
  const missingHint = await waitFor(
    '找不到原文的提示',
    () => cdp.evaluate(`document.querySelector('[data-testid="pdf-flash-hint"]')?.textContent?.trim() ?? ''`),
    15000,
  ).catch(() => '')
  check('标题在原文里不存在时给出明确提示（不静默失败）', /没能在 PDF 里找到/.test(missingHint), missingHint)
  check('找不到时不画下划线（不假装命中）', (await cdp.evaluate(`document.querySelectorAll('[data-testid="flash-box"]').length`)) === 0)

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/flash-short-quote.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 截图：docs/flash-short-quote.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
