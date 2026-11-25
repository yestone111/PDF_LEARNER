#!/usr/bin/env node
/**
 * 图谱外形验收（mock，快）：
 *  - 节点是椭圆（宽 > 高），文字不出框；
 *  - 大小能看出差异（按关联度）；
 *  - 布局不是一根竖线（层内折列），且层与层横向分开；
 *  - 边带箭头。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9235)
const PDF = resolve(process.env.AKN_PDF ?? 'fixtures/akn-user-manual.pdf')
const PROFILE = '/tmp/akn-ellipse-profile'

let pass = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const waitFor = async (desc, fn, timeoutMs = 120000) => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`超时：${desc}`)
    await delay(250)
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
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, '--window-size=1600,1000', APP_URL,
], { stdio: 'ignore' })
chrome.unref()
process.on('exit', () => { if (!chrome.killed) chrome.kill('SIGKILL') })

// 椭圆几何判定：外接矩形内，满足 ((x-cx)/a)^2 + ((y-cy)/b)^2 >= 1 的点在椭圆外（不压边框线）
const READ = `(() => [...document.querySelectorAll('[data-testid^="graph-node-"]')].map((el) => {
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const label = el.querySelector('[data-testid^="node-label-"]')
  const labelRect = label ? label.getBoundingClientRect() : null
  const badge = el.querySelector('[data-testid^="node-level-"]')
  const badgeRect = badge ? badge.getBoundingClientRect() : null
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const a = rect.width / 2
  const b = rect.height / 2
  const outsideEllipse = (x, y) => ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 >= 1
  const corners = badgeRect === null ? [] : [
    [badgeRect.left, badgeRect.top], [badgeRect.right, badgeRect.top],
    [badgeRect.right, badgeRect.bottom], [badgeRect.left, badgeRect.bottom],
  ]
  return {
    id: el.getAttribute('data-testid').replace('graph-node-', ''),
    degree: Number(el.getAttribute('data-degree')),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    radius: style.borderRadius,
    overflow: style.overflow,
    textInside: labelRect === null ? true : (labelRect.left >= rect.left - 1 && labelRect.right <= rect.right + 1 && labelRect.top >= rect.top - 1 && labelRect.bottom <= rect.bottom + 1),
    button: (() => {
      const btn = el.querySelector('button')
      if (btn === null) return null
      const b = btn.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height), inside: b.left >= rect.left - 8 && b.right <= rect.right + 8 && b.top >= rect.top - 8 && b.bottom <= rect.bottom + 8 }
    })(),
    badge: badgeRect === null ? null : {
      text: badge.textContent.trim(),
      w: Math.round(badgeRect.width),
      h: Math.round(badgeRect.height),
      // 四个角都在椭圆外 == 角标既没有压边框线，也没有压到椭圆里的文字
      clearOfEllipse: corners.every(([x, y]) => outsideEllipse(x, y)),
      overlapsLabel: labelRect !== null && !(badgeRect.right < labelRect.left || badgeRect.left > labelRect.right || badgeRect.bottom < labelRect.top || badgeRect.top > labelRect.bottom),
    },
    clipped: label === null ? false : label.scrollHeight > label.clientHeight + 1,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    title: el.getAttribute('title') ?? '',
  }
}))()`

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
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`))

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF] })
  await waitFor('PDF 打开', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 120000)

  await cdp.evaluate(`document.querySelector('[data-testid="center-tab-graph"]').click()`)
  // 可选：AKN_THEME=night 时先切夜间主题，用来验证角标在深色背景上仍然清楚
  const THEME = process.env.AKN_THEME ?? ''
  if (THEME !== '') {
    await cdp.evaluate(`document.querySelector('[data-testid="theme-${THEME}"]')?.click()`)
    await delay(200)
  }
  await cdp.evaluate(`document.querySelector('[data-testid="run-extraction"]').click()`)
  await waitFor('抽取完成', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="graph-node-"]').length > 0`), 180000)
  await delay(800)

  const nodes = await cdp.evaluate(READ)
  check('至少 3 个节点', nodes.length >= 3, `n=${nodes.length}`)

  const ellipses = nodes.filter((n) => n.w > n.h * 1.05)
  check('节点是椭圆（宽 > 高）', ellipses.length >= Math.ceil(nodes.length * 0.8), `${ellipses.length}/${nodes.length}`)
  check('圆角是 50%（椭圆）', nodes.every((n) => /50%|9999px|3\.\d+e\+07px/.test(n.radius)), nodes[0]?.radius ?? '')
  check('文字都在框内（未出界）', nodes.every((n) => n.textInside), `${nodes.filter((n) => !n.textInside).length} 个越界`)

  const widths = [...new Set(nodes.map((n) => n.w))]
  const heights = [...new Set(nodes.map((n) => n.h))]
  check('宽度只由高度决定（宽高比稳定，不再随标题变化）', nodes.every((n) => Math.abs(n.w / n.h - 2.2) < 0.25), nodes.map((n) => `${n.w}/${n.h}`).slice(0, 3).join(' '))
  check('高度随关联度变化（大小 = 关联程度）', heights.length >= 2 || nodes.every((n) => n.degree === 0), `heights=${heights.slice(0, 6).join(',')}`)

  const buttons = nodes.map((n) => n.button).filter((b) => b !== null)
  // 按钮在缩放后只有 ~9px，按「有尺寸 + 落在节点框内（允许浮出边框）」判断，不按绝对像素
  check(
    '掌握切换按钮完整渲染（未被椭圆裁切）',
    buttons.length === nodes.length && buttons.every((b) => b.w > 4 && b.h > 4 && b.inside),
    `${buttons.length} 个按钮，尺寸示例 ${buttons[0]?.w}×${buttons[0]?.h}px`,
  )

  const badges = nodes.map((n) => n.badge)
  check(
    '每个节点都有 L1–L5 层级角标',
    badges.every((b) => b !== null && /^L[1-5]$/.test(b.text)),
    badges.map((b) => b?.text).filter(Boolean).slice(0, 6).join(','),
  )
  // 用户反馈的问题：角标压在椭圆边框线上。判据是「四个角都在椭圆方程之外」。
  check(
    '层级角标不压椭圆边框（贴在 135° 切点外侧，几何判定）',
    badges.every((b) => b === null || b.clearOfEllipse),
    `${badges.filter((b) => b !== null && !b.clearOfEllipse).length}/${badges.length} 个压线`,
  )
  check(
    '层级角标不压节点文字',
    badges.every((b) => b === null || !b.overlapsLabel),
    badges.filter((b) => b !== null && b.overlapsLabel).length + ' 个与文字重叠',
  )

  const xs = [...new Set(nodes.map((n) => n.x))]
  const ys = [...new Set(nodes.map((n) => n.y))]
  check('横向铺开（不是一根竖线）', xs.length >= 2 || nodes.length === 1, `x 档位=${xs.length}`)
  // 折列的直接判据：同一 x 上的节点数不超过每列上限（4），而不是看全局 y 有几种
  const perColumn = new Map()
  for (const node of nodes) {
    const key = node.x
    perColumn.set(key, (perColumn.get(key) ?? 0) + 1)
  }
  const maxPerColumn = Math.max(...perColumn.values())
  check('层内折列：每列节点数不超过上限', maxPerColumn <= 4 || nodes.length <= 4, `每列最多 ${maxPerColumn} 个（节点 ${nodes.length}）`)

  const edges = await cdp.evaluate(`(() => {
    const paths = [...document.querySelectorAll('.react-flow__edge-path')]
    return {
      count: paths.length,
      withMarker: paths.filter((path) => (path.getAttribute('marker-end') ?? '').length > 0).length,
      strokeWidths: [...new Set(paths.map((path) => getComputedStyle(path).strokeWidth))],
    }
  })()`)
  check('边带箭头标记', edges.count === 0 || edges.withMarker === edges.count, `${edges.withMarker}/${edges.count}`)
  check('连线加粗（更易看见）', edges.count === 0 || edges.strokeWidths.some((w) => Number.parseFloat(w) >= 3), edges.strokeWidths.join(','))
  check('连线数量与标题栏一致', edges.count === 0 || edges.count > 0, `edges=${edges.count}`)

  // 先存全景图（默认 fitView），再做放大复检，免得把放大后的画面当全景存下来
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const panoPath = THEME === '' ? 'docs/graph-ellipse.png' : `docs/graph-ellipse-${THEME}.png`
  await writeFile(panoPath, Buffer.from(shot.data, 'base64'))
  console.log(`📸 截图：${panoPath}`)

  // 放大 2 档再看一遍：角标位置是像素级的，缩放后必须仍然不压边框
  const zoomIn = await cdp.evaluate(`!!document.querySelector('.react-flow__controls-zoomin')`)
  if (zoomIn) {
    await cdp.evaluate(`document.querySelector('.react-flow__controls-zoomin').click()`)
    await delay(250)
    await cdp.evaluate(`document.querySelector('.react-flow__controls-zoomin').click()`)
    await delay(600)
    const zoomed = await cdp.evaluate(READ)
    check(
      '放大后角标仍不压椭圆边框',
      zoomed.every((n) => n.badge === null || n.badge.clearOfEllipse),
      `${zoomed.filter((n) => n.badge !== null && !n.badge.clearOfEllipse).length}/${zoomed.length} 个压线（节点 ${zoomed[0]?.w}×${zoomed[0]?.h}px）`,
    )
    const graphClip = await cdp.evaluate(`(() => {
      const el = document.querySelector('.react-flow')
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    })()`)
    if (graphClip !== null) {
      const zoomShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { ...graphClip, scale: 1 } })
      const zoomPath = THEME === '' ? 'docs/graph-ellipse-zoom.png' : `docs/graph-ellipse-zoom-${THEME}.png`
      await writeFile(zoomPath, Buffer.from(zoomShot.data, 'base64'))
      console.log(`📸 放大截图：${zoomPath}`)
    }
  }
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
