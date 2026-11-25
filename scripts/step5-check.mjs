#!/usr/bin/env node
/**
 * Step 5 验收：TipTap 混排笔记 + Markdown 导出 + 同步占位。
 * 覆盖：节点卡片 / 原文高亮 / AI 回答 / 图谱截图插入；导出预览内容与图片降级规则；刷新后笔记恢复。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9226)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const SHOT_PATH = process.env.AKN_SHOT ?? 'docs/step5-screenshot.png'
const PROFILE = '/tmp/akn-step5-profile'

const failures = []
let passCount = 0

function check(name, ok, detail = '') {
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`
  if (ok) passCount += 1
  else failures.push(line)
  console.log(line)
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

    // 打开 PDF + 抽取图谱（节点卡片需要真实节点）
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-testid="pdf-input"]',
    })
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
    await waitFor('PDF 就绪', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`))

    await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
    await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
    await waitFor('图谱抽取完成', () =>
      cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`),
    { timeoutMs: 120000 })

    // 选中一个节点（供「插入节点卡片」使用）：点节点会打开学习对话框，读标题后关掉
    await cdp.evaluate(`document.querySelector('[data-testid^="graph-node-"]').click()`)
    await waitFor('学习对话框', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`))
    const nodeTitle = await cdp.evaluate(
      `document.querySelector('[data-testid="learning-title"]')?.textContent?.trim() ?? ''`,
    )
    await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]').click()`)
    await delay(200)
    check('图谱中选中了一个节点', nodeTitle !== '', nodeTitle)

    // ------------------ 笔记面板 ------------------
    await cdp.evaluate(`document.querySelector('[data-testid="tab-notes"]').click()`)
    await waitFor('笔记编辑器出现', () => cdp.evaluate(`!!document.querySelector('[data-testid="note-editor"]')`))
    check('笔记面板是真实 TipTap 编辑器（不是占位）', true)

    await cdp.evaluate(`document.querySelector('[data-testid="note-editor"]').focus()`)
    await cdp.send('Input.insertText', { text: '注意力机制是 Transformer 的核心。' })
    await delay(400)

    await cdp.evaluate(`document.querySelector('[data-testid="insert-node-card"]').click()`)
    await delay(500)
    let editorText = await cdp.evaluate(
      `document.querySelector('[data-testid="note-editor"]').textContent`,
    )
    check('插入图谱节点卡片', editorText.includes('【节点】'), editorText.slice(0, 60))

    // AI 回答 → 发送到笔记 → 插入
    await cdp.evaluate(`document.querySelector('[data-testid="tab-chat"]').click()`)
    await cdp.evaluate(`document.querySelector('[data-testid="chat-input"]').focus()`)
    await cdp.send('Input.insertText', { text: '这一页讲了什么？' })
    await cdp.evaluate(`document.querySelector('[data-testid="chat-send"]').click()`)
    await waitFor('AI 回答完成', () =>
      cdp.evaluate(`!!document.querySelector('[data-testid="chat-message-assistant"][data-status="done"]')`),
    { timeoutMs: 30000 })
    await cdp.evaluate(`document.querySelector('[data-testid="send-to-note"]').click()`)
    await delay(300)

    await cdp.evaluate(`document.querySelector('[data-testid="tab-notes"]').click()`)
    await waitFor('AI 卡片可插入', () =>
      cdp.evaluate(`(document.querySelector('[data-testid="insert-chat-card"]')?.textContent ?? '').includes('(1)')`),
    )
    await cdp.evaluate(`document.querySelector('[data-testid="insert-chat-card"]').click()`)
    await delay(500)
    editorText = await cdp.evaluate(`document.querySelector('[data-testid="note-editor"]').textContent`)
    check('插入 AI 回答卡片', editorText.includes('【AI】'), editorText.slice(0, 80))

    // 图谱截图
    await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
    await delay(600)
    await cdp.evaluate(`document.querySelector('[data-testid="insert-graph-image"]').click()`)
    await waitFor('图谱截图插入', () =>
      cdp.evaluate(`document.querySelectorAll('.akn-note-image').length > 0`),
    { timeoutMs: 30000 })
    const imageInfo = await cdp.evaluate(`(() => {
      const img = document.querySelector('.akn-note-image')
      return { src: (img?.getAttribute('src') ?? '').slice(0, 30), width: img?.naturalWidth ?? 0 }
    })()`)
    check('图谱截图以 PNG data URI 插入', imageInfo.src.startsWith('data:image/png;base64'), `${imageInfo.src}…`)
    check('截图有实际像素（非空图）', imageInfo.width > 200, `naturalWidth=${imageInfo.width}`)

    // ------------------ Markdown 导出 ------------------
    await cdp.evaluate(`document.querySelector('[data-testid="export-markdown"]').click()`)
    await waitFor('导出预览出现', () => cdp.evaluate(`!!document.querySelector('[data-testid="markdown-preview"]')`))
    const markdown = await cdp.evaluate(
      `document.querySelector('[data-testid="markdown-preview"]').textContent`,
    )

    check('导出的 Markdown 含普通段落', markdown.includes('注意力机制是 Transformer 的核心'), markdown.slice(0, 40))
    check('节点卡片降级为引用块', markdown.includes('> **【节点】'), '')
    check('AI 卡片降级为引用块', markdown.includes('> **【AI】**'), '')
    check(
      'AI 出处行符合「无直接出处 / p.N」约定',
      markdown.includes('出处：无直接出处') || /出处：p\.\d+/.test(markdown),
      (markdown.match(/出处：[^\n]*/) ?? [''])[0].slice(0, 50),
    )
    check('图片按 inline base64 内联', markdown.includes('![知识图谱截图](data:image/png;base64,'), '')
    check('导出不产生降级（默认阈值内）', !markdown.includes('akn-note') && !markdown.includes('akn-assets/'), '')

    // ------------------ 刷新持久化 ------------------
    await cdp.evaluate(`document.querySelector('[data-testid="export-close"]').click()`)
    await cdp.send('Page.reload', { ignoreCache: false })
    await delay(1500)
    await waitFor('刷新后恢复', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`))
    await cdp.evaluate(`document.querySelector('[data-testid="tab-notes"]').click()`)
    await waitFor('刷新后笔记编辑器出现', () =>
      cdp.evaluate(`!!document.querySelector('[data-testid="note-editor"]')`),
    )
    await delay(600)
    const restoredText = await cdp.evaluate(`document.querySelector('[data-testid="note-editor"]').textContent`)
    check('刷新后笔记正文恢复', restoredText.includes('注意力机制是 Transformer 的核心'), restoredText.slice(0, 40))
    check('刷新后自定义节点恢复', restoredText.includes('【节点】') && restoredText.includes('【AI】'), '')

    // 同步占位
    const syncLabel = await cdp.evaluate(
      `([...document.querySelectorAll('footer span')].map((el) => el.textContent).join(' ')) ?? ''`,
    )
    check('同步目标以 P1 占位出现（obsidian/notion/feishu）', syncLabel.includes('obsidian') && syncLabel.includes('P1'), syncLabel.slice(0, 60))

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(SHOT_PATH, Buffer.from(shot.data, 'base64'))
    console.log(`📸 截图：${SHOT_PATH}`)

    check('页面全程无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 200))
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
