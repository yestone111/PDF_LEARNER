#!/usr/bin/env node
/**
 * 插件实境验收：在「运行中的 DSH」里打开 /akn/，用宿主当前模型（真实 DeepSeek）跑一次完整抽取。
 * 这是唯一能证明「不配 Key 也能用真实模型」的验证。
 *
 * 用法：node scripts/plugin-live-check.mjs [appUrl]
 * 默认 http://127.0.0.1:3080/akn/
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:3080/akn/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9229)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/attention-is-all-you-need.pdf')
const SHOT = process.env.AKN_SHOT ?? 'docs/plugin-live.png'
const PROFILE = '/tmp/akn-live-profile'

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function waitFor(desc, fn, timeoutMs = 300000) {
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
    this.socket = socket; this.id = 1; this.pending = new Map(); this.listeners = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve: ok, reject } = this.pending.get(message.id); this.pending.delete(message.id)
        message.error ? reject(new Error(message.error.message)) : ok(message.result)
      } else if (typeof message.method === 'string') {
        for (const cb of this.listeners.get(message.method) ?? []) cb(message.params)
      }
    })
  }
  on(m, cb) { const l = this.listeners.get(m) ?? []; l.push(cb); this.listeners.set(m, l) }
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
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('Log.enable')
  const errors = []
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.text ?? 'uncaught'))
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error' && p.entry.source !== 'network') errors.push(p.entry.text) })

  await waitFor('插件页面加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 60000)
  check('DSH 里能打开 /akn/ 页面', true, APP_URL)

  const health = await cdp.evaluate(`fetch('/api/akn/health').then(r => r.json())`)
  check('浏览器同源访问 /api/akn/health 成功', health?.ok === true)
  check('确认走宿主进程内模型（非 mock）', health?.llmMock === false && health?.llmConfigured === true, `${health?.provider}/${health?.model}`)

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
  await waitFor('PDF 打开', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 120000)
  check('本地 PDF 在插件页里能打开', true)

  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  const started = Date.now()
  await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)

  const outcome = await waitFor('真实模型抽取结束', async () => {
    const state = await cdp.evaluate(`(() => ({
      nodes: document.querySelectorAll('[data-testid^="graph-node-"]').length,
      running: (document.querySelector('[data-testid="extraction-progress"]')?.textContent ?? '').length > 0,
      error: document.querySelector('[data-testid="graph-error"]')?.textContent?.trim() ?? null,
      hint: document.querySelector('[data-testid="graph-empty"]') !== null,
    }))()`)
    if (state.nodes > 0) return { kind: 'nodes', ...state }
    if (state.error !== null) return { kind: 'error', ...state }
    return null
  }, 1200000)

  const seconds = Math.round((Date.now() - started) / 1000)
  if (outcome.kind === 'nodes') {
    check('真实 DeepSeek 抽出知识点', true, `nodes=${outcome.nodes} · 用时 ${seconds}s`)
    const mapped = await cdp.evaluate(`(() => [...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => ({
      title: el.textContent.trim(), difficulty: el.getAttribute('data-difficulty'), degree: el.getAttribute('data-degree'), mastery: el.getAttribute('data-mastery')
    })))().slice(0, 3)`)
    console.log('   抽样节点:', JSON.stringify(mapped))

    const visuals = await cdp.evaluate(`(() => [...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => ({
      difficulty: Number(el.getAttribute('data-difficulty')),
      degree: Number(el.getAttribute('data-degree')),
      width: Math.round(el.getBoundingClientRect().width),
      height: Math.round(el.getBoundingClientRect().height),
      fill: getComputedStyle(el).backgroundColor,
      mastery: el.getAttribute('data-mastery'),
    })))()`)
    check(
      '真实模型产出了掌握难度（1–5）',
      visuals.length > 0 && visuals.every((item) => item.difficulty >= 1 && item.difficulty <= 5),
      `difficulty=${[...new Set(visuals.map((item) => item.difficulty))].join(',')}`,
    )
    const degrees = visuals.map((item) => item.degree)
    const heights = visuals.map((item) => item.height)
    if (degrees.every((degree) => degree === 0)) {
      check('无依赖边时高度一致（尺寸由关联度驱动）', new Set(heights).size === 1, `height=${heights[0] ?? 0}px`)
    } else {
      check('高度随关联程度变化', new Set(heights).size > 1, `heights=${[...new Set(heights)].slice(0, 6).join(',')}`)
    }

    const edgeInfo = await cdp.evaluate(`(() => ({
      count: document.querySelectorAll('.react-flow__edge').length,
      labels: [...new Set([...document.querySelectorAll('.react-flow__edge-text')].map((el) => el.textContent))].slice(0, 8),
    }))()`)
    check('全局视图有依赖边（章节边已提升到全局）', edgeInfo.count > 0, `edges=${edgeInfo.count}`)
    check('出现了框架边（属于 / 依赖等语义关系）', edgeInfo.labels.length > 0, edgeInfo.labels.join(' / '))
    check(
      '模型搭出了总纲结构（存在 belongs_to「属于」边）',
      edgeInfo.labels.some((label) => label.includes('属于')),
      edgeInfo.labels.join(' / '),
    )

    // 打开第一个节点看「知识点描述」（对话框正文已从原文摘抄改成描述）
    const firstNode = await cdp.evaluate(`document.querySelector('[data-testid^="graph-node-"]')?.getAttribute('data-testid') ?? ''`)
    if (firstNode !== '') {
      await cdp.evaluate(`document.querySelector('[data-testid="${firstNode}"]').click()`)
      await waitFor('学习对话框', () => cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`), 30000)
      await delay(1200)
      const dialogState = await cdp.evaluate(`(() => ({
        description: (document.querySelector('[data-testid="learning-description-text"]')?.textContent ?? '').trim(),
        hasExcerpt: !!document.querySelector('[data-testid="excerpt-body"]'),
      }))()`)
      check(
        '真实模型给出的知识点描述能显示（且已无原文摘抄）',
        dialogState.description.length > 0 && dialogState.hasExcerpt === false,
        `chars=${dialogState.description.length}`,
      )

    const cognitive = await cdp.evaluate(`(() => ({
      levels: [...document.querySelectorAll('[data-testid^="node-level-"]')].map((el) => el.textContent.trim()),
      path: document.querySelectorAll('[data-testid^="path-item-"]').length,
      prior: document.querySelector('[data-testid="learning-prior"]')?.textContent ?? '',
      elaboration: !!document.querySelector('[data-testid="learning-elaboration"]'),
      gate: document.querySelector('[data-testid="graph-gate"]')?.textContent?.trim() ?? '',
    }))()`)
    check('真实模型产出了认知层级', cognitive.levels.length > 0 && cognitive.levels.every((level) => /^L[1-5]$/.test(level)), [...new Set(cognitive.levels)].join(','))
    check('学习路径清单可见', cognitive.path > 0, `${cognitive.path} 步`)
    check('对话框显示先修知识', cognitive.prior.includes('先修'), cognitive.prior.slice(0, 30))
    check('认知层级分布不止 L1（校准生效）', new Set(cognitive.levels).size >= 2, [...new Set(cognitive.levels)].join(','))

    // 自测题：逐个节点找带 selfCheck 的节点（路径条目只高亮，不再弹详情，所以点图谱节点）
    let sawSelfCheck = false
    const pathIds = await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="path-item-"]')].map((el) => el.getAttribute('data-testid').replace('path-item-', ''))`)
    for (const pathId of pathIds.slice(0, 8)) {
      if (await cdp.evaluate(`!!document.querySelector('[data-testid="learning-dialog"]')`)) {
        await cdp.evaluate(`document.querySelector('[data-testid="learning-close"]').click()`)
        await delay(150)
      }
      await cdp.evaluate(`document.querySelector('[data-testid="graph-node-${pathId}"]').click()`)
      await delay(300)
      if (await cdp.evaluate(`!!document.querySelector('[data-testid="learning-selfcheck"]')`)) {
        sawSelfCheck = true
        break
      }
    }
    check('真实模型产出了自测题', sawSelfCheck)
      console.log('   描述开头:', JSON.stringify(dialogState.description.slice(0, 60)))
    }
  } else {
    check('真实 DeepSeek 抽取成功', false, `失败：${outcome.error}`)
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(SHOT, Buffer.from(shot.data, 'base64'))
  console.log(`📸 截图：${SHOT}`)
  check('页面无未捕获异常', errors.length === 0, JSON.stringify(errors).slice(0, 200))
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
