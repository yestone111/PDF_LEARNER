#!/usr/bin/env node
/**
 * Step 6 验收：图谱优先学习流（知识对话框）。
 *
 * 覆盖：点节点 → 对话框；**知识点描述**（不再是原文摘抄）；图表摘抄（caption + 区域截图）；
 *       上下游继续学；掌握状态切换；知识点笔记落库；跳到 PDF 原文。
 * 数据依赖项（图表摘抄、别名、上下游）如果样本里找不到，会显式记为 SKIP，不伪装通过。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9227)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const SHOT_PATH = process.env.AKN_SHOT ?? 'docs/step6-screenshot.png'
const PROFILE = '/tmp/akn-step6-profile'

const failures = []
let passCount = 0
let skipCount = 0

function check(name, ok, detail = '') {
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`
  if (ok) passCount += 1
  else failures.push(line)
  console.log(line)
}

function skip(name, detail = '') {
  skipCount += 1
  console.log(`⏭️  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function waitFor(description, predicate, { timeoutMs = 60000, intervalMs = 200 } = {}) {
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
        const { resolve: ok, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else ok(message.result)
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
    return new Promise((ok, reject) => {
      this.pending.set(id, { resolve: ok, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`页面内执行失败：${detail}`)
    }
    return result.result.value
  }
}

const READ_DIALOG = `(() => {
  const dialog = document.querySelector('[data-testid="learning-dialog"]')
  if (!dialog) return null
  const description = dialog.querySelector('[data-testid="learning-description-text"]')
  return {
    title: document.querySelector('[data-testid="learning-title"]')?.textContent?.trim() ?? '',
    anchorPage: dialog.getAttribute('data-anchor-page'),
    description: description?.textContent?.trim() ?? '',
    hasDescription: !!dialog.querySelector('[data-testid="learning-description"]'),
    aliases: dialog.querySelector('[data-testid="learning-aliases"]')?.textContent?.trim() ?? '',
    // 原文摘抄必须已经删掉：这两样都不该再出现
    hasExcerptBody: !!dialog.querySelector('[data-testid="excerpt-body"]'),
    excerptSegments: dialog.querySelectorAll('[data-seg-start]').length,
    hasAnnotationBar: !!dialog.querySelector('[data-testid="annotation-bar"]'),
    hasPrior: !!dialog.querySelector('[data-testid="learning-prior"]'),
    hasNoteInput: !!dialog.querySelector('[data-testid="learning-note-input"]'),
    hasFigure: !!dialog.querySelector('[data-testid="figure-excerpt"]'),
    figureSrc: dialog.querySelector('[data-testid="figure-image"]')?.getAttribute('src') ?? '',
    hasUpstream: !!dialog.querySelector('[data-testid^="learning-upstream-"]'),
    hasDownstream: !!dialog.querySelector('[data-testid^="learning-downstream-"]'),
  }
})()`

async function openDialogFor(cdp, testId) {
  await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]')?.click()`)
  await delay(150)
  await cdp.evaluate(`document.querySelector('[data-testid="${testId}"]').click()`)
  await waitFor('学习对话框出现', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`))
  await delay(600)
  return cdp.evaluate(READ_DIALOG)
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
    const target = await waitFor('CDP 就绪', async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
        return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null
      } catch {
        return null
      }
    })

    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((ok, reject) => {
      socket.addEventListener('open', ok, { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })

    const cdp = new Cdp(socket)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('DOM.enable')
    await cdp.send('Log.enable')

    const pageErrors = []
    cdp.on('Runtime.exceptionThrown', (params) => pageErrors.push(params.exceptionDetails?.text ?? 'uncaught'))
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error' && params.entry.source !== 'network') {
        pageErrors.push(`${params.entry.source}: ${params.entry.text}`)
      }
    })

    await waitFor('首屏', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`))

    // 默认已经是「知识图谱」视图（图谱优先）
    const defaultTab = await cdp.evaluate(
      `document.querySelector('[data-testid="center-tab-graph"]').getAttribute('aria-selected')`,
    )
    check('默认打开就是知识图谱视图（PDF 保留为另一个 Tab）', defaultTab === 'true', `graph=${defaultTab}`)

    // 打开 PDF + 抽取
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-testid="pdf-input"]',
    })
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
    await waitFor('PDF 就绪', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`))
    await waitFor('图谱视图就绪', () => cdp.evaluate(`!!document.querySelector('[data-testid="graph-pane"]')`))
    await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
    await waitFor('抽取完成', () =>
      cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`),
    { timeoutMs: 120000 })

    const nodeIds = await cdp.evaluate(
      `[...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => el.getAttribute('data-testid'))`,
    )
    check('图谱里有可学习的节点', nodeIds.length > 0, `nodes=${nodeIds.length}`)

    // ---------------- 1. 对话框：知识点描述（取代原文摘抄） ----------------
    let dialog = null
    let currentTestId = nodeIds[0]
    for (const testId of nodeIds.slice(0, 12)) {
      dialog = await openDialogFor(cdp, testId)
      if (dialog !== null && dialog.description.length > 0) {
        currentTestId = testId
        break
      }
    }
    check('点节点 → 打开学习对话框', dialog !== null)
    check('对话框显示知识点标题', dialog.title.length > 0, dialog.title)
    check('对话框有「知识点描述」区块', dialog.hasDescription === true)
    check('描述有正文（不是空壳）', dialog.description.length > 0, `chars=${dialog.description.length}`)
    check(
      '描述是概念解释而不是原文摘抄（没有页码分段）',
      dialog.hasExcerptBody === false && dialog.excerptSegments === 0,
      `excerptBody=${dialog.hasExcerptBody}, segments=${dialog.excerptSegments}`,
    )
    check('划选标注条已随摘抄一起移除', dialog.hasAnnotationBar === false)
    check(
      '描述不是标题的复读（内容确实解释了知识点）',
      dialog.description !== dialog.title && dialog.description.length > 8,
      `title=${dialog.title.slice(0, 16)} / desc=${dialog.description.slice(0, 24)}…`,
    )
    check('学习骨架仍在（先修 / 笔记输入）', dialog.hasPrior && dialog.hasNoteInput)

    if (dialog.aliases === '') skip('描述下方显示别名', '该节点的抽取结果没有别名')
    else check('描述下方显示别名', /^别名：/.test(dialog.aliases), dialog.aliases)

    const dialogShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile('docs/learning-dialog.png', Buffer.from(dialogShot.data, 'base64'))
    console.log('📸 对话框截图：docs/learning-dialog.png')

    // ---------------- 2. 图表摘抄 ----------------
    let figureFound = null
    for (const testId of nodeIds.slice(0, 14)) {
      const candidate = await openDialogFor(cdp, testId)
      if (candidate !== null && candidate.hasFigure) {
        figureFound = candidate
        break
      }
    }
    if (figureFound === null) {
      skip('图表摘抄', '这批节点附近没有 caption，未触发图表块')
    } else {
      check('节点带图表块（caption + 区域）', true)
      const hasImage = figureFound.figureSrc.startsWith('data:image/png')
      check('图表区域渲染成 PNG（按 caption 估算区域）', hasImage, hasImage ? 'data:image/png' : '未渲染出图，已降级提示')
    }

    // 回到有描述的那个节点继续
    dialog = await openDialogFor(cdp, currentTestId)

    // ---------------- 3. 顺着图谱继续学 ----------------
    const navigable = dialog.hasUpstream || dialog.hasDownstream
    if (navigable) {
      const chipTestId = await cdp.evaluate(`(() => {
        const el = document.querySelector('[data-testid^="learning-upstream-"], [data-testid^="learning-downstream-"]')
        return el?.getAttribute('data-testid') ?? ''
      })()`)
      const titleBefore = await cdp.evaluate(
        `document.querySelector('[data-testid="learning-title"]').textContent.trim()`,
      )
      await cdp.evaluate(`document.querySelector('[data-testid="${chipTestId}"]').click()`)
      await waitFor('对话框切换到相邻知识点', async () => {
        const title = await cdp.evaluate(
          `document.querySelector('[data-testid="learning-title"]').textContent.trim()`,
        )
        return title !== titleBefore
      })
      check('点上下游条目可在对话框内继续学习', true, chipTestId.split('-').slice(-1)[0].slice(0, 8))
    } else {
      skip('上下游继续学', '当前节点没有可见的上下游边')
    }

    // ---------------- 4. 掌握状态切换 ----------------
    dialog = await openDialogFor(cdp, currentTestId)
    const nodeDomId = currentTestId.replace('graph-node-', '')
    const masteryBefore = await cdp.evaluate(
      `document.querySelector('[data-testid="graph-node-${nodeDomId}"]')?.getAttribute('data-mastery') ?? ''`,
    )
    await cdp.evaluate(`document.querySelector('[data-testid="learning-toggle-mastery"]').click()`)
    await delay(500)
    const masteryAfter = await cdp.evaluate(
      `document.querySelector('[data-testid="graph-node-${nodeDomId}"]')?.getAttribute('data-mastery') ?? ''`,
    )
    check('对话框里可以切换掌握状态', masteryBefore !== masteryAfter && masteryAfter !== '', `${masteryBefore} → ${masteryAfter}`)

    await cdp.evaluate(`document.querySelector('[data-testid="learning-toggle-doubt"]').click()`)
    await delay(400)
    const doubtState = await cdp.evaluate(
      `document.querySelector('[data-testid="learning-dialog"]')?.getAttribute('data-mastery') ?? ''`,
    )
    check('对话框提供独立的「? 有疑问」按钮（不需要循环点击）', doubtState === 'doubt', doubtState)
    await cdp.evaluate(`document.querySelector('[data-testid="learning-toggle-doubt"]').click()`)
    await delay(300)

    // ---------------- 5. 知识点笔记落库 ----------------
    await cdp.evaluate(`document.querySelector('[data-testid="learning-note-input"]').focus()`)
    await cdp.send('Input.insertText', { text: '我的理解：注意力就是加权求和。' })
    await cdp.evaluate(`document.querySelector('[data-testid="learning-note-save"]').click()`)
    await delay(600)
    const noteHint = await cdp.evaluate(
      `document.querySelector('[data-testid="learning-hint"]')?.textContent?.trim() ?? ''`,
    )
    check('知识点笔记可保存', noteHint.includes('笔记已保存'), noteHint)

    const noteRows = await cdp.evaluate(`new Promise((resolve) => {
      const request = indexedDB.open('ai-knowledge-navigator')
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('notes', 'readonly')
        const all = tx.objectStore('notes').getAll()
        all.onsuccess = () => resolve(all.result.length)
      }
      request.onerror = () => resolve(0)
    })`)
    check('笔记写入 IndexedDB（notes 表）', noteRows > 0, `rows=${noteRows}`)

    // ---------------- 6. 跳到 PDF 原文 ----------------
    const anchorPage = await cdp.evaluate(
      `document.querySelector('[data-testid="learning-dialog"]').getAttribute('data-anchor-page')`,
    )
    await cdp.evaluate(`document.querySelector('[data-testid="learning-jump-pdf"]').click()`)
    await delay(900)
    const jumped = await cdp.evaluate(`(() => ({
      dialogClosed: !document.querySelector('[data-testid="learning-dialog"]'),
      pdfTab: document.querySelector('[data-testid="center-tab-pdf"]').getAttribute('aria-selected'),
      pageExists: !!document.querySelector('.page[data-page-number="${anchorPage}"]'),
    }))()`)
    check('点「跳到 PDF 原文」关闭对话框并切到 PDF', jumped.dialogClosed && jumped.pdfTab === 'true',
      `closed=${jumped.dialogClosed}, pdfTab=${jumped.pdfTab}`)
    check('锚点页在 PDF 里存在', anchorPage === '' ? true : jumped.pageExists, `page=${anchorPage || 'none'}`)

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(SHOT_PATH, Buffer.from(shot.data, 'base64'))
    console.log(`📸 截图：${SHOT_PATH}`)

    check('页面全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 200))
  } finally {
    cleanup()
    await delay(150)
  }

  console.log(`\n通过 ${passCount} 项，失败 ${failures.length} 项，跳过 ${skipCount} 项`)
  if (failures.length > 0) {
    console.log(failures.join('\n'))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('❌ 验收脚本异常：', error)
  process.exitCode = 1
})
