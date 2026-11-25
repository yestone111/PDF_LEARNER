#!/usr/bin/env node
/**
 * Step 2 验收：PDF 上传 → outline → 跳页 → 高亮+备注 → 刷新恢复。
 * 无头 Chrome + CDP，真实注入文件 / 真实划选 / 真实点击，零第三方依赖。
 *
 * 用法：先 `pnpm dev`，再 `node scripts/step2-check.mjs`
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9223)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const SHOT_PATH = process.env.AKN_SHOT ?? 'docs/step2-screenshot.png'
const PROFILE = '/tmp/akn-step2-profile'

const failures = []
let passCount = 0

function check(name, ok, detail = '') {
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`
  if (ok) passCount += 1
  else failures.push(line)
  console.log(line)
}

async function waitFor(description, predicate, { timeoutMs = 20000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`超时等待：${description}`)
    await delay(intervalMs)
  }
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
        return
      }
      if (typeof message.method === 'string') {
        for (const callback of this.listeners.get(message.method) ?? []) callback(message.params)
      }
    })
  }
  on(method, callback) {
    const list = this.listeners.get(method) ?? []
    list.push(callback)
    this.listeners.set(method, list)
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`页面内执行失败：${result.exceptionDetails.text ?? 'unknown'}`)
    }
    return result.result.value
  }
}

async function main() {
  await mkdir(PROFILE, { recursive: true })
  const chrome = spawn(
    'google-chrome',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--window-size=1440,900',
      APP_URL,
    ],
    { stdio: 'ignore' },
  )

  const cleanup = () => {
    if (!chrome.killed) chrome.kill('SIGKILL')
  }
  process.on('exit', cleanup)

  try {
    const target = await waitFor('Chrome DevTools 端口就绪', async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
        const targets = await response.json()
        return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null
      } catch {
        return null
      }
    })

    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true })
      socket.addEventListener('error', () => rejectOpen(new Error('CDP 连接失败')), { once: true })
    })

    const cdp = new Cdp(socket)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('DOM.enable')
    await cdp.send('Log.enable')

    const pageErrors = []
    cdp.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails?.text ?? 'uncaught exception')
    })
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error' && params.entry.source !== 'network') {
        pageErrors.push(`${params.entry.source}: ${params.entry.text}`)
      }
    })

    await waitFor('首屏渲染', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`))
    check(
      '初始为空态（未打开 PDF）',
      await cdp.evaluate(`!!document.querySelector('[data-testid="pdf-empty"]')`),
    )

    /* ---------------- 1. 注入 PDF 文件 ---------------- */
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-testid="pdf-input"]',
    })
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })

    await waitFor('PDF 解析完成并出现 viewer', () =>
      cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`),
    )
    check('PDF 打开后出现 viewer', true)

    // 默认视图是「知识图谱」，划选/滚动要在 PDF 视图里做
    await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]').click()`)
    await delay(400)

    await waitFor('页面绘制完成', () =>
      cdp.evaluate(`document.querySelectorAll('.page[data-page-number]').length >= 15`),
    )
    const pageCount = await cdp.evaluate(`document.querySelectorAll('.page[data-page-number]').length`)
    check('页面容器数量 = 15（无双份 viewer）', pageCount === 15, `pages=${pageCount}`)

    const canvasCount = await cdp.evaluate(`document.querySelectorAll('.page canvas').length`)
    check('画布已渲染（非空白）', canvasCount >= 1, `canvas=${canvasCount}`)

    /* ---------------- 2. outline ---------------- */
    const outline = await cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-testid^="outline-item-"]')]
      return items.map((el) => ({
        title: el.textContent.trim(),
        page: el.getAttribute('data-page'),
        level: Number(el.getAttribute('data-level')),
      }))
    })()`)
    check('outline 来自真实书签（≥8 条）', outline.length >= 8, `items=${outline.length}`)
    const levels = new Set(outline.map((item) => item.level))
    check('outline 呈现多级层级', levels.has(1) && levels.has(2), `levels=${[...levels].join(',')}`)
    const withPage = outline.filter((item) => item.page !== '').length
    check('绝大多数条目解析出页码', withPage >= outline.length - 1, `${withPage}/${outline.length}`)

    /* ---------------- 3. 点击目录跳页 ---------------- */
    // 选一个「页码 ≥ 5 的一级章节」，确保跳转是真的滚动了很远（而不是本来就停在第一页）
    let targetIndex = outline.findIndex((item) => item.level === 1 && Number(item.page) >= 5)
    if (targetIndex < 0) targetIndex = outline.findIndex((item) => item.level === 1 && item.page !== '')
    check('存在可点击的一级章节', targetIndex >= 0, `index=${targetIndex}`)
    if (targetIndex < 0) throw new Error('目录里没有任何可跳转的一级章节')
    const targetTitle = outline[targetIndex].title
    const targetPage = Number(outline[targetIndex].page)
    await cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]')[${targetIndex}].click()`)
    await delay(700)
    const indicator = await cdp.evaluate(
      `document.querySelector('[data-testid="page-indicator"]').textContent.trim()`,
    )
    check(
      `点击「${targetTitle}」→ 页码指示器变为 ${targetPage}`,
      indicator.startsWith(`${targetPage} /`),
      `indicator=${indicator}`,
    )

    const targetNearTop = await cdp.evaluate(`(() => {
      const viewer = document.querySelector('[data-testid="pdf-viewer"]')
      const page = document.querySelector('.page[data-page-number="${targetPage}"]')
      if (!viewer || !page) return null
      return Math.round(page.getBoundingClientRect().top - viewer.getBoundingClientRect().top)
    })()`)
    check(
      `第 ${targetPage} 页确实滚动到视口顶部附近`,
      targetNearTop !== null && targetNearTop > -600 && targetNearTop < 200,
      `pageTop-viewerTop=${targetNearTop}`,
    )

    /* ---------------- 4. 划选文本 → 高亮 + 备注 ---------------- */
    await waitFor('文本层就绪', () =>
      cdp.evaluate(`document.querySelectorAll('.page[data-page-number="${targetPage}"] .textLayer span').length > 5`),
    )

    const rects = await cdp.evaluate(`(() => {
      const spans = [...document.querySelectorAll('.page[data-page-number="${targetPage}"] .textLayer span')]
        .filter((el) => el.textContent.trim().length > 2)
      const selected = spans.slice(0, 3).map((el) => {
        const rect = el.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, text: el.textContent }
      })
      return selected
    })()`)
    check('取到可划选的文本行', rects.length >= 2, `spans=${rects.length}`)

    const startX = Math.round(rects[0].left + 2)
    const endX = Math.round(rects[Math.min(2, rects.length - 1)].right - 2)
    const y = Math.round((rects[0].top + rects[0].bottom) / 2)

    const mouse = (type, x, yPos, pressed) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y: yPos,
        button: 'left',
        buttons: pressed ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1,
        pointerType: 'mouse',
      })

    await mouse('mouseMoved', startX, y, false)
    await mouse('mousePressed', startX, y, true)
    for (let step = 1; step <= 12; step += 1) {
      await mouse('mouseMoved', startX + ((endX - startX) * step) / 12, y, true)
      await delay(18)
    }
    await mouse('mouseReleased', endX, y, false)

    const tipShown = await waitFor('划选后出现确认气泡', () =>
      cdp.evaluate(`!!document.querySelector('[data-testid="highlight-tip"]')`),
    ).catch(() => false)
    check('划选文本后弹出高亮确认气泡', tipShown === true)

    if (tipShown) {
      await cdp.evaluate(`document.querySelector('[data-testid="highlight-comment-input"]').focus()`)
      await cdp.send('Input.insertText', { text: '注意力的核心公式（CDP 自动验收）' })
      await cdp.evaluate(`document.querySelector('[data-testid="highlight-emoji-💡"]').click()`)
      await cdp.evaluate(`document.querySelector('[data-testid="highlight-confirm"]').click()`)
      await delay(800)

      const countText = await cdp.evaluate(
        `document.querySelector('[data-testid="highlight-count"]').textContent.trim()`,
      )
      check('高亮条数变为 1', countText.includes('1'), `count=${countText}`)
      const parts = await cdp.evaluate(`document.querySelectorAll('.Highlight__part').length`)
      check('页面上渲染出高亮色块', parts >= 1, `parts=${parts}`)
    }

    /* ---------------- 5. 刷新后恢复 ---------------- */
    await cdp.send('Page.reload', { ignoreCache: false })
    await delay(1500)
    await waitFor('刷新后自动恢复文档', () =>
      cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`),
    )
    await waitFor('刷新后重新渲染页面', () =>
      cdp.evaluate(`document.querySelectorAll('.page[data-page-number]').length >= 15`),
    )
    const afterReload = await cdp.evaluate(`(() => ({
      count: document.querySelector('[data-testid="highlight-count"]').textContent.trim(),
      outlineItems: document.querySelectorAll('[data-testid^="outline-item-"]').length,
      docName: document.querySelector('[data-testid="document-name"]').textContent.trim(),
      pages: document.querySelectorAll('.page[data-page-number]').length,
    }))()`)
    check('刷新后高亮数据从 IndexedDB 恢复', afterReload.count.includes('1'), afterReload.count)
    check('刷新后目录仍在（无需重新解析）', afterReload.outlineItems >= 8, `items=${afterReload.outlineItems}`)
    check('刷新后文档名恢复', afterReload.docName.includes('attention'), afterReload.docName)
    check('刷新后页数仍为 15', afterReload.pages === 15, `pages=${afterReload.pages}`)

    // 刷新后默认落在「知识图谱」视图（图谱优先），先切回 PDF 再验证高亮。
    await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]').click()`)
    await delay(400)

    // 高亮只在其所在页被渲染时才挂到 DOM（pdf.js 懒渲染，属正常行为）。
    // 所以先滚到高亮所在页，再断言色块出现。
    await cdp.evaluate(`(() => {
      const page = document.querySelector('.page[data-page-number="${targetPage}"]')
      if (page) page.scrollIntoView({ block: 'start' })
    })()`)
    await waitFor('滚到高亮所在页后色块重新挂载', () =>
      cdp.evaluate(`document.querySelectorAll('.Highlight__part').length >= 1`),
    )
    const partsAfterScroll = await cdp.evaluate(`document.querySelectorAll('.Highlight__part').length`)
    check('刷新后高亮色块在原页重新渲染', partsAfterScroll >= 1, `parts=${partsAfterScroll}`)

    /* ---------------- 6. 备注持久化：点开高亮看内容 ---------------- */
    await cdp.evaluate(`document.querySelectorAll('.Highlight__part')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await delay(500)
    const editorValue = await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-testid="comment-editor-input"]')
      return input ? input.value : null
    })()`)
    check(
      '点击高亮可查看已保存的备注',
      typeof editorValue === 'string' && editorValue.includes('注意力的核心公式'),
      `value=${editorValue}`,
    )

    /* ---------------- 7. 截图 + 错误 ---------------- */
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(SHOT_PATH, Buffer.from(shot.data, 'base64'))
    console.log(`📸 截图：${SHOT_PATH}`)

    check(
      '页面全程无未捕获异常',
      pageErrors.length === 0,
      pageErrors.length === 0 ? '' : JSON.stringify(pageErrors).slice(0, 200),
    )
  } finally {
    cleanup()
    await delay(150)
  }

  console.log(`\n通过 ${passCount} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    console.log(failures.join('\n'))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('❌ 验收脚本异常：', error)
  process.exitCode = 1
})
