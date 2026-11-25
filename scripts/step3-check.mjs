#!/usr/bin/env node
/**
 * Step 3 验收：LLM 代理 + map-reduce 抽取 + zod 校验 + 缓存 + 两级图谱（mock 上游）。
 *
 * 前置：`LLM_MOCK=1 pnpm dev`（没有 DeepSeek key 时用本地 mock 验证链路；结果会带 Mock 标识）
 * 断网/重复验证：脚本通过 /api/llm/mock-stats 统计真实调用次数，第二次抽取必须 0 次新增。
 * 篡改上游：AKN_EXPECT_FAIL=1（配合 LLM_MOCK_BROKEN_JSON=1）验证 zod 拦截后不产生任何节点。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_URL ?? 'http://127.0.0.1:5173/'
const API_BASE = process.env.AKN_API ?? 'http://127.0.0.1:8787'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9224)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const SHOT_PATH = process.env.AKN_SHOT ?? 'docs/step3-screenshot.png'
const PROFILE = '/tmp/akn-step3-profile'
const EXPECT_FAIL = process.env.AKN_EXPECT_FAIL === '1'

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

async function mockStats() {
  const response = await fetch(`${API_BASE}/api/llm/mock-stats`)
  return response.json()
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
    if (result.exceptionDetails) throw new Error(`页面内执行失败：${result.exceptionDetails.text}`)
    return result.result.value
  }
}

const READ_GRAPH = `(() => ({
  counts: document.querySelector('[data-testid="graph-counts"]')?.textContent?.trim() ?? '',
  nodes: document.querySelectorAll('[data-testid^="graph-node-"]').length,
  edges: document.querySelectorAll('.react-flow__edge').length,
  mockBadge: !!document.querySelector('[data-testid="graph-mock-badge"]'),
  error: document.querySelector('[data-testid="graph-error"]')?.textContent?.trim() ?? null,
  empty: !!document.querySelector('[data-testid="graph-empty"]'),
  mode: document.querySelector('[data-testid="graph-mode"]')?.textContent?.trim() ?? '',
  runLabel: document.querySelector('[data-testid="run-extraction"]')?.textContent?.trim() ?? '',
}))()`

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
    cdp.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails?.text ?? 'uncaught')
    })
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error' && params.entry.source !== 'network') {
        pageErrors.push(`${params.entry.source}: ${params.entry.text}`)
      }
    })

    await waitFor('首屏', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`))

    // 打开 PDF
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-testid="pdf-input"]',
    })
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
    await waitFor('PDF 就绪', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`))

    // 切到图谱
    await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
    await waitFor('图谱视图出现', () => cdp.evaluate(`!!document.querySelector('[data-testid="graph-pane"]')`))
    let graph = await cdp.evaluate(READ_GRAPH)
    check('未抽取时是明确空态', graph.empty === true, graph.counts)

    const before = await mockStats()

    // 第一次抽取
    await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
    if (EXPECT_FAIL) {
      await waitFor('失败态出现', () =>
        cdp.evaluate(`!!document.querySelector('[data-testid="graph-error"]')`),
        { timeoutMs: 90000 },
      )
      graph = await cdp.evaluate(READ_GRAPH)
      check('上游返回非法 JSON → 不产生任何节点（禁假数据）', graph.nodes === 0, `nodes=${graph.nodes}`)
      check('错误被显式展示', graph.error !== null, String(graph.error).slice(0, 90))
      check('失败时不会渲染半成品图', graph.empty === true)
      const failedCaches = await (await fetch(`${API_BASE}/api/llm/mock-stats`)).json()
      check('失败仍计入了上游调用（不是静默跳过）', failedCaches.extractCalls + failedCaches.repairCalls > before.extractCalls + before.repairCalls)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      await writeFile(SHOT_PATH.replace('.png', '-failed.png'), Buffer.from(shot.data, 'base64'))
      console.log(`📸 失败态截图：${SHOT_PATH.replace('.png', '-failed.png')}`)
      check('页面无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 150))
      return
    }

    await waitFor('抽取完成并出现节点', () =>
      cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`),
    { timeoutMs: 120000 })

    graph = await cdp.evaluate(READ_GRAPH)
    check('抽取后节点出现', graph.nodes > 0, `nodes=${graph.nodes}`)
    check('有向边带标签渲染', graph.edges > 0, `edges=${graph.edges}`)
    check('标注了 Mock 上游（不冒充真实模型）', graph.mockBadge === true)

    const afterFirst = await mockStats()
    const firstCalls = afterFirst.extractCalls + afterFirst.repairCalls - (before.extractCalls + before.repairCalls)
    check('第一次抽取发生了真实上游调用（mock 计数增加）', firstCalls > 0, `calls=+${firstCalls}`)

    // 第二次抽取：必须全部命中缓存，0 次新增调用
    await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
    await waitFor('第二次抽取完成', async () => {
      const label = await cdp.evaluate(
        `document.querySelector('[data-testid="run-extraction"]')?.textContent?.trim() ?? ''`,
      )
      return label.includes('AI 抽取全局图谱')
    })
    await delay(600)
    const afterSecond = await mockStats()
    const secondCalls = afterSecond.extractCalls + afterSecond.repairCalls - (afterFirst.extractCalls + afterFirst.repairCalls)
    check('重复抽取 0 次新增加上游调用（命中缓存）', secondCalls === 0, `calls=+${secondCalls}`)

    const graphAgain = await cdp.evaluate(READ_GRAPH)
    check('重复抽取不改变图谱规模', graphAgain.nodes === graph.nodes, `${graph.nodes} → ${graphAgain.nodes}`)

    // 点节点 → 学习对话框（新交互）：上下游 + 掌握状态
    await cdp.evaluate(`document.querySelector('[data-testid^="graph-node-"]').click()`)
    await waitFor('学习对话框出现', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`))
    const dialogText = await cdp.evaluate(`document.querySelector('[data-testid="learning-dialog"]').textContent`)
    check('学习对话框展示前置依赖/后置影响', dialogText.includes('前置依赖') && dialogText.includes('后置影响'))

    const nodeTestId = await cdp.evaluate(
      `document.querySelector('[data-testid^="graph-node-"]').getAttribute('data-testid')`,
    )
    const beforeColor = await cdp.evaluate(
      `getComputedStyle(document.querySelector('[data-testid="${nodeTestId}"]')).backgroundColor`,
    )
    await cdp.evaluate(`document.querySelector('[data-testid="learning-toggle-mastery"]').click()`)
    await delay(500)
    const afterColor = await cdp.evaluate(
      `getComputedStyle(document.querySelector('[data-testid="${nodeTestId}"]')).backgroundColor`,
    )
    const afterMastery = await cdp.evaluate(
      `document.querySelector('[data-testid="${nodeTestId}"]').getAttribute('data-mastery')`,
    )
    check('掌握状态切换 → 颜色改变且状态为 mastered', beforeColor !== afterColor && afterMastery === 'mastered', `${beforeColor} → ${afterColor}`)
    const rgb = afterColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0]
    check('已掌握是绿系（绿通道 > 红通道）', rgb[1] > rgb[0], afterColor)

    // 节点 → PDF 跳转（选一个真有锚点的节点）
    let jumped = false
    const nodeIds = await cdp.evaluate(
      `[...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => el.getAttribute('data-testid'))`,
    )
    for (const testId of nodeIds.slice(0, 8)) {
      await cdp.evaluate(`document.querySelector('[data-testid="${testId}"]').click()`)
      await delay(250)
      const anchorPage = await cdp.evaluate(
        `document.querySelector('[data-testid="learning-dialog"]')?.getAttribute('data-anchor-page') ?? ''`,
      )
      console.log(`   debug ${testId}: anchorPage=${anchorPage}`)
      if (anchorPage === '') {
        await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]')?.click()`)
        continue
      }
      await cdp.evaluate(`document.querySelector('[data-testid="learning-jump-pdf"]').click()`)
      await delay(900)
      const tabSelected = await cdp.evaluate(
        `document.querySelector('[data-testid="center-tab-pdf"]').getAttribute('aria-selected')`,
      )
      const indicator = await cdp.evaluate(
        `document.querySelector('[data-testid="page-indicator"]')?.textContent?.trim() ?? ''`,
      )
      await waitFor('PDF 页已跳转', () =>
        cdp.evaluate(`document.querySelectorAll('.page[data-page-number]').length >= 1`),
      )
      console.log(`   debug jump: tab=${tabSelected} indicator=${indicator}`)
      check(
        `节点 → 切到 PDF 并跳到第 ${anchorPage} 页`,
        tabSelected === 'true' && indicator.startsWith(`${anchorPage} /`),
        `indicator=${indicator}`,
      )
      jumped = true
      break
    }
    check('至少有一个节点带原文锚点可跳转', jumped)

    // 刷新后图谱从 IndexedDB 恢复
    await cdp.send('Page.reload', { ignoreCache: false })
    await delay(1500)
    await waitFor('刷新后 PDF 恢复', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`))
    await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
    await waitFor('刷新后图谱节点恢复', () =>
      cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`),
    )
    const restored = await cdp.evaluate(READ_GRAPH)
    check('刷新后图谱规模一致（从 IndexedDB 恢复）', restored.nodes === graph.nodes, `${graph.nodes} → ${restored.nodes}`)
    const masteryRestored = await cdp.evaluate(
      `document.querySelector('[data-testid="${nodeTestId}"]')?.getAttribute('data-mastery') ?? ''`,
    )
    check('刷新后掌握状态持久化', masteryRestored === 'mastered', `mastery=${masteryRestored}`)

    // 章节子图：目录点击 → 章节模式 → 开启拆解（应全部命中缓存）
    await cdp.evaluate(`document.querySelector('[data-testid="center-tab-pdf"]').click()`)
    await delay(300)
    await cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]')[3].click()`)
    await delay(400)
    await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
    await waitFor('章节模式生效', () =>
      cdp.evaluate(`(document.querySelector('[data-testid="graph-mode"]')?.textContent ?? '').includes('章节：')`),
    )
    const chapterMode = await cdp.evaluate(READ_GRAPH)
    check('目录选中章节后图谱进入章节模式', chapterMode.mode.includes('章节：'), chapterMode.mode)
    check('章节模式按钮文案为「AI 开启拆解」', chapterMode.runLabel.includes('开启拆解'), chapterMode.runLabel)

    const beforeChapter = await mockStats()
    await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
    await waitFor('章节拆解产出节点', () =>
      cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`),
    { timeoutMs: 90000 })
    await delay(500)
    const afterChapter = await mockStats()
    const chapterCalls = afterChapter.extractCalls + afterChapter.repairCalls - (beforeChapter.extractCalls + beforeChapter.repairCalls)
    check('章节子图复用全局抽取的块缓存（0 次新增调用）', chapterCalls === 0, `calls=+${chapterCalls}`)
    const chapterGraph = await cdp.evaluate(READ_GRAPH)
    check('章节子图有节点（不含目录节点）', chapterGraph.nodes > 0, `nodes=${chapterGraph.nodes}`)
    // 目录不是知识点：章节视图里不应再出现「章节根」这种合成节点
    const neutralCount = await cdp.evaluate(
      `[...document.querySelectorAll('[data-testid^="graph-node-"]')].filter((el) => el.getAttribute('data-importance-source') === 'none').length`,
    )
    check('章节视图不含目录/章节根节点', neutralCount === 0, `neutral=${neutralCount}`)

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
