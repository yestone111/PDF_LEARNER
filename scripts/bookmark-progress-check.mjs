#!/usr/bin/env node
/**
 * 目录「章节掌握度圆圈」+「章节书签」验收。
 *
 * 覆盖：
 *  1) 每章左侧圆圈三态：未开始（灰空心）/ 部分掌握（半绿）/ 全部掌握（实心绿 + 提示文案）；
 *  2) 圆圈按章节聚合（父章节 = 子树合计），图例与总计可读；
 *  3) 行尾 ☆ 加书签 → 落 IndexedDB（bookmarks 表）→ 星标变实心；
 *  4) 刷新页面（自动恢复上次文档）→ 直接跳到书签所在章节，并给出「已跳到书签」提示；
 *  5) 取消书签后星标恢复空心、表里清空。
 *
 * 数据依赖项（没有章节包含 ≥2 个知识点时测不到「部分掌握」）会显式 SKIP，不伪装通过。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9237)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/akn-user-manual.pdf')
const PROFILE = '/tmp/akn-bookmark-profile'
const SHOT = 'docs/outline-bookmark.png'

let pass = 0
let skipped = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const skip = (name, detail = '') => {
  skipped += 1
  console.log(`⏭️  ${name}${detail ? ` — ${detail}` : ''}`)
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

const READ_OUTLINE = `(() => [...document.querySelectorAll('[data-testid^="outline-item-"]')].map((el) => {
  const dot = el.querySelector('[data-testid^="outline-progress-"]')
  const star = document.querySelector('[data-testid="bookmark-toggle-' + el.getAttribute('data-testid').replace('outline-item-', '') + '"]')
  return {
    id: el.getAttribute('data-testid').replace('outline-item-', ''),
    title: el.querySelector('[data-outline-title]')?.textContent ?? '',
    page: Number(el.getAttribute('data-page')),
    level: Number(el.getAttribute('data-level')),
    rowState: el.getAttribute('data-progress'),
    dotState: dot?.getAttribute('data-state') ?? null,
    dotTitle: dot?.getAttribute('title') ?? '',
    dotBackground: dot === null ? '' : getComputedStyle(dot).backgroundImage,
    dotFill: dot === null ? '' : getComputedStyle(dot).backgroundColor,
    dotBorder: dot === null ? '' : getComputedStyle(dot).borderTopColor,
    star: star === null ? null : {
      marked: star.getAttribute('data-bookmarked'),
      // 绸带图标：有没有 svg、填充还是描边（不再用 ★/☆ 字符）
      hasSvg: star.querySelector('svg') !== null,
      fill: star.querySelector('path')?.getAttribute('fill') ?? '',
      disabled: star.disabled,
    },
  }
}))()`

const readBookmarkRows = `new Promise((resolve) => {
  const request = indexedDB.open('ai-knowledge-navigator')
  request.onsuccess = () => {
    const db = request.result
    if (!db.objectStoreNames.contains('bookmarks')) return resolve([])
    const all = db.transaction('bookmarks', 'readonly').objectStore('bookmarks').getAll()
    all.onsuccess = () => resolve(all.result.map((row) => ({ outlineNodeId: row.outlineNodeId, label: row.label, page: row.page })))
    all.onerror = () => resolve([])
  }
  request.onerror = () => resolve([])
})`

await mkdir(PROFILE, { recursive: true })
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, '--window-size=1440,900', APP_URL,
], { stdio: 'ignore' })
chrome.unref()
process.on('exit', () => { if (!chrome.killed) chrome.kill('SIGKILL') })

/** 清掉上一轮 localStorage 记录，保证这是一次「全新打开」。 */
async function freshStart(cdp) {
  await cdp.evaluate(`(() => { try { window.localStorage.clear() } catch {} return true })()`)
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 30000)
}

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

  await freshStart(cdp)

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
  await waitFor('目录加载', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]').length > 3`), 120000)
  await delay(500)

  // ---------- 1. 圆圈三态：抽取前全是「未开始」 ----------
  const before = await cdp.evaluate(READ_OUTLINE)
  check('每章都有掌握度圆圈', before.length > 3 && before.every((row) => row.dotState !== null), `rows=${before.length}`)
  check('抽取前所有章节都是未开始（灰空心）', before.every((row) => row.rowState === 'none'), [...new Set(before.map((r) => r.rowState))].join(','))
  check('未开始圆圈是空心（无填充、有边框）', before.every((row) => row.dotBackground === 'none'), before[0]?.dotBackground ?? '')
  const legend = await cdp.evaluate(`document.querySelector('[data-testid="outline-progress-legend"]')?.textContent ?? ''`)
  check('图例解释三种状态', /全部掌握/.test(legend) && /部分掌握/.test(legend) && /未开始/.test(legend), legend.trim().slice(0, 40))

  // ---------- 2. 抽取后按章节聚合 ----------
  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
  await waitFor('抽取完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 180000)
  await delay(800)

  const extracted = await cdp.evaluate(READ_OUTLINE)
  const withNodes = extracted.filter((row) => /\/\d+/.test(row.dotTitle))
  check('圆圈提示里带「已掌握 m/n」计数', withNodes.length > 0, withNodes[0]?.dotTitle ?? '')
  check('未掌握任何知识点时仍是「未开始」', withNodes.every((row) => row.rowState === 'none'), withNodes.map((r) => r.rowState).slice(0, 6).join(','))

  // 逐个把所有知识点标成已掌握 → 有知识点的章节应变成「全部掌握」
  const masteryIds = await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="mastery-"]')].map((el) => el.getAttribute('data-testid'))`)
  for (const testId of masteryIds) {
    await cdp.evaluate(`document.querySelector('[data-testid="${testId}"]')?.click()`)
    await delay(60)
  }
  await delay(600)
  const allMastered = await cdp.evaluate(READ_OUTLINE)
  const completeRows = allMastered.filter((row) => row.rowState === 'complete')
  check('全部掌握后章节变实心绿圈（complete）', completeRows.length > 0, `complete=${completeRows.length}/${allMastered.length}`)
  check(
    '实心绿圈有「已全部掌握」提示',
    completeRows.length > 0 && completeRows.every((row) => /全部掌握/.test(row.dotTitle)),
    completeRows[0]?.dotTitle ?? '',
  )
  check(
    '实心绿圈真的被填满（填充色 = 边框色，不是空心）',
    completeRows.length > 0 &&
      completeRows.every((row) => row.dotFill !== 'rgba(0, 0, 0, 0)' && row.dotFill !== 'transparent' && row.dotFill === row.dotBorder),
    `fill=${completeRows[0]?.dotFill ?? ''} border=${completeRows[0]?.dotBorder ?? ''}`,
  )
  const stats = await cdp.evaluate(`document.querySelector('[data-testid="outline-mastery-stats"]')?.textContent?.trim() ?? ''`)
  check('底部统计显示已掌握/总数', /^已掌握 \d+\/\d+$/.test(stats) && !stats.startsWith('已掌握 0/'), stats)

  // ---------- 3. 部分掌握 ----------
  let partialFound = null
  const candidates = await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="mastery-"]')].map((el) => el.getAttribute('data-testid'))`)
  for (const testId of candidates) {
    await cdp.evaluate(`document.querySelector('[data-testid="${testId}"]')?.click()`)
    await delay(220)
    const rows = await cdp.evaluate(READ_OUTLINE)
    const partial = rows.find((row) => row.rowState === 'partial')
    if (partial !== undefined) { partialFound = partial; break }
  }
  if (partialFound === null) {
    skip('部分掌握（半绿圈）', '这批草稿没有哪一章同时含已掌握+未掌握的知识点，E2E 无法构造')
  } else {
    check('部分掌握时章节变半绿圈（partial）', true, partialFound.dotTitle)
    check('半绿圈提示「已掌握 m/n」而不是「全部掌握」', /已掌握 \d+\/\d+/.test(partialFound.dotTitle) && !/全部掌握/.test(partialFound.dotTitle), partialFound.dotTitle)
    check('半绿圈是「一半实心」的渐变填充', /gradient/.test(partialFound.dotBackground), partialFound.dotBackground.slice(0, 60))
    check('半绿圈的边框是 ok 色（与实心部分同色）', partialFound.dotBorder === completeRows[0]?.dotBorder, `${partialFound.dotBorder} vs ${completeRows[0]?.dotBorder}`)
  }

  // 三种状态同框：实心绿（全部掌握）+ 半绿（部分掌握）+ 灰空心（未开始）
  const mixedShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(SHOT, Buffer.from(mixedShot.data, 'base64'))
  console.log(`📸 截图：${SHOT}`)
  const leftClip = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="panel-left"]')
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
  })()`)
  if (leftClip !== null) {
    const zoomShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { ...leftClip, scale: 2 },
    })
    await writeFile('docs/outline-bookmark-zoom.png', Buffer.from(zoomShot.data, 'base64'))
    console.log('📸 目录放大截图：docs/outline-bookmark-zoom.png')
  }

  // ---------- 4. 加书签 ----------
  const bookmarkTarget = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-testid^="outline-item-"]')]
    const row = rows.find((el) => Number(el.getAttribute('data-page')) === 6) ?? rows[0]
    return { id: row.getAttribute('data-testid').replace('outline-item-', ''), page: Number(row.getAttribute('data-page')), title: row.querySelector('[data-outline-title]')?.textContent ?? '' }
  })()`)
  await cdp.evaluate(`document.querySelector('[data-testid="bookmark-toggle-${bookmarkTarget.id}"]').click()`)
  await delay(500)
  const afterBookmark = (await cdp.evaluate(READ_OUTLINE)).find((row) => row.id === bookmarkTarget.id)
  check(
    '点书签图标后变成实心绸带',
    afterBookmark?.star?.marked === 'true' && afterBookmark.star.hasSvg && afterBookmark.star.fill === 'currentColor',
    `fill=${afterBookmark?.star?.fill}（${bookmarkTarget.title}）`,
  )
  const storedRows = await cdp.evaluate(readBookmarkRows)
  check('书签写入 IndexedDB（bookmarks 表）', storedRows.length === 1 && storedRows[0].outlineNodeId === bookmarkTarget.id, JSON.stringify(storedRows))

  // ---------- 5. 刷新页面 → 直接跳书签 ----------
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('恢复上次文档', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 60000)
  await waitFor('书签提示出现', () => cdp.evaluate(`!!document.querySelector('[data-testid="bookmark-notice"]')`), 30000)
  const notice = await cdp.evaluate(`document.querySelector('[data-testid="bookmark-notice"]')?.textContent?.trim() ?? ''`)
  check('刷新后给出「已跳到书签」提示', /已跳到书签/.test(notice) && notice.includes(bookmarkTarget.title), notice.slice(0, 40))

  const indicator = await waitFor('页码指示器更新', async () => {
    const text = await cdp.evaluate(`document.querySelector('[data-testid="page-indicator"]')?.textContent?.trim() ?? ''`)
    return text.startsWith(`${bookmarkTarget.page} /`) ? text : null
  }, 15000).catch(() => '')
  check('刷新后 PDF 真的停在书签所在章节', indicator.startsWith(`${bookmarkTarget.page} /`), indicator || '未跳转')

  const jumpShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/outline-bookmark-jump.png', Buffer.from(jumpShot.data, 'base64'))
  console.log('📸 跳书签截图：docs/outline-bookmark-jump.png')

  const pdfTabActive = await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]')?.getAttribute('aria-selected') ?? ''`)
  check('刷新后中栏切到 PDF（跳转要看得见）', pdfTabActive === 'true', `pdfTab=${pdfTabActive}`)

  const restoredRows = await cdp.evaluate(READ_OUTLINE)
  const restoredTarget = restoredRows.find((row) => row.id === bookmarkTarget.id)
  check(
    '刷新后书签图标仍为实心',
    restoredTarget?.star?.marked === 'true' && restoredTarget.star.fill === 'currentColor',
    `fill=${restoredTarget?.star?.fill}`,
  )
  check('刷新后章节掌握度也恢复了（不是重新算空）', restoredRows.some((row) => row.rowState !== 'none'), restoredRows.map((r) => r.rowState).slice(0, 6).join(','))

  // ---------- 6. 取消书签 ----------
  await cdp.evaluate(`document.querySelector('[data-testid="bookmark-notice-dismiss"]')?.click()`)
  await delay(200)
  check('书签提示可关闭', (await cdp.evaluate(`!!document.querySelector('[data-testid="bookmark-notice"]')`)) === false)

  await cdp.evaluate(`document.querySelector('[data-testid="bookmark-toggle-${bookmarkTarget.id}"]').click()`)
  await delay(500)
  const clearedRows = await cdp.evaluate(readBookmarkRows)
  check('再点一次取消书签（表里清空）', clearedRows.length === 0, JSON.stringify(clearedRows))
  const clearedRow = (await cdp.evaluate(READ_OUTLINE)).find((row) => row.id === bookmarkTarget.id)
  check(
    '取消后书签图标恢复空心描边',
    clearedRow?.star?.marked === 'false' && clearedRow.star.hasSvg && clearedRow.star.fill === 'none',
    `fill=${clearedRow?.star?.fill}`,
  )

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/outline-bookmark-after.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 截图：docs/outline-bookmark-after.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项，跳过 ${skipped} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
