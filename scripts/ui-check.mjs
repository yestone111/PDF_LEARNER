#!/usr/bin/env node
/**
 * Step 1 交互验收脚本（无头 Chrome + DevTools Protocol，零第三方依赖）。
 *
 * 为什么不用「人眼看截图」：任务书 Step 1 要求「证明三栏渲染、Tab 切换、拖拽可用」。
 * 截图只能证明渲染，证明不了交互。这里用 CDP 真实派发鼠标/键盘事件，
 * 把「拖了多少像素 → 实际宽度多少 → 是否被 clamp」全部断言出来，可重复执行。
 *
 * 用法：
 *   1) 先启动 `pnpm dev`（5173 + 8787）
 *   2) node scripts/ui-check.mjs
 * 环境变量：AKN_URL / AKN_CDP_PORT / AKN_SHOT
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9222)
const SHOT_PATH = process.env.AKN_SHOT ?? 'docs/step1-screenshot.png'
const USER_DATA_DIR = process.env.AKN_CHROME_PROFILE ?? '/tmp/akn-ui-check-profile'

const failures = []
const passes = []

function check(name, ok, detail = '') {
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`
  if (ok) passes.push(line)
  else failures.push(line)
  console.log(line)
}

async function waitFor(description, predicate, { timeoutMs = 15000, intervalMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`超时等待：${description}`)
    await delay(intervalMs)
  }
}

/* ------------------------------------------------------------------ CDP 客户端 */

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

/* ------------------------------------------------------------------ 页面探针 */

const READ_GEOMETRY = `(() => {
  const box = (selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: Math.round(rect.width), height: Math.round(rect.height) }
  }
  const grid = document.querySelector('[data-testid="layout-grid"]')
  const root = document.querySelector('[data-testid="layout-root"]')
  const rightElement = document.querySelector('[data-testid="panel-right"]')
  return {
    rightHidden: rightElement === null || rightElement.offsetParent === null,
    rightCollapsedAttr: rightElement?.getAttribute('data-collapsed') ?? null,
    gridColumns: grid === null ? '' : getComputedStyle(grid).gridTemplateColumns,
    left: box('[data-testid="panel-left"]'),
    center: box('[data-testid="panel-center"]'),
    right: box('[data-testid="panel-right"]'),
    splitterLeft: box('[data-testid="splitter-left"]'),
    splitterRight: box('[data-testid="splitter-right"]'),
    gridScrollWidth: grid ? grid.scrollWidth : 0,
    gridClientWidth: grid ? grid.clientWidth : 0,
    rootClientWidth: root ? root.clientWidth : 0,
    persisted: localStorage.getItem('akn.ui'),
  }
})()`

async function main() {
  await mkdir(USER_DATA_DIR, { recursive: true })
  const chrome = spawn(
    process.env.AKN_CHROME_BIN ?? 'google-chrome',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--hide-scrollbars',
      `--user-data-dir=${USER_DATA_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--window-size=1440,900',
      APP_URL,
    ],
    { stdio: 'ignore', detached: false },
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
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
    })

    const cdp = new Cdp(socket)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')

    /** 真实收集页面侧异常：未捕获异常 + 非网络的 error 级日志。 */
    const pageErrors = []
    cdp.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails?.text ?? 'uncaught exception')
    })
    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry
      if (entry?.level === 'error' && entry.source !== 'network') {
        pageErrors.push(`${entry.source}: ${entry.text}`)
      }
    })

    await waitFor('应用首屏渲染完成', () =>
      cdp.evaluate(`document.querySelector('[data-testid="panel-left"]') !== null`),
    )
    // 等 ResizeObserver + 健康检查跑完，避免读到中间态
    await delay(600)

    const mouse = (type, x, y, pressed) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: pressed ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1,
        pointerType: 'mouse',
      })

    const dragBy = async (geometry, side, deltaX) => {
      const splitter = side === 'left' ? geometry.splitterLeft : geometry.splitterRight
      const startX = Math.round(splitter.x + splitter.width / 2)
      const startY = Math.round(splitter.y + splitter.height / 2)
      await mouse('mouseMoved', startX, startY, false)
      await mouse('mousePressed', startX, startY, true)
      const steps = 8
      for (let step = 1; step <= steps; step += 1) {
        await mouse('mouseMoved', startX + (deltaX * step) / steps, startY, true)
        await delay(16)
      }
      await mouse('mouseReleased', startX + deltaX, startY, false)
      await delay(120)
    }

    /* -------------------------------------------------- 1. 三栏渲染 */
    let geometry = await cdp.evaluate(READ_GEOMETRY)
    check(
      '三栏渲染：左 260 / 中 ≥360 / 右 380',
      geometry.left.width === 260 && geometry.right.width === 380 && geometry.center.width >= 360,
      `left=${geometry.left.width} center=${geometry.center.width} right=${geometry.right.width}`,
    )
    check(
      '初始无横向溢出',
      geometry.gridScrollWidth <= geometry.gridClientWidth + 1,
      `scrollWidth=${geometry.gridScrollWidth} clientWidth=${geometry.gridClientWidth}`,
    )

    /* -------------------------------------------------- 2. Tab 切换 */
    const tabState = () =>
      cdp.evaluate(`(() => ({
        activeChat: document.querySelector('[data-testid="tab-chat"]').getAttribute('aria-selected'),
        activeNotes: document.querySelector('[data-testid="tab-notes"]').getAttribute('aria-selected'),
        hasChatPane: !!document.querySelector('[data-testid="pane-chat"]'),
        hasNotesPane: !!document.querySelector('[data-testid="pane-notes"]'),
      }))()`)

    let tabs = await tabState()
    check(
      '默认 Tab = AI 伴读',
      tabs.activeChat === 'true' && tabs.hasChatPane && !tabs.hasNotesPane,
      `chat=${tabs.activeChat} notes=${tabs.activeNotes}`,
    )

    await cdp.evaluate(`document.querySelector('[data-testid="tab-notes"]').click()`)
    await delay(150)
    tabs = await tabState()
    check(
      '点击「笔记」→ 切到笔记面板',
      tabs.activeNotes === 'true' && tabs.hasNotesPane && !tabs.hasChatPane,
      `chat=${tabs.activeChat} notes=${tabs.activeNotes}`,
    )

    await cdp.evaluate(`document.querySelector('[data-testid="tab-chat"]').click()`)
    await delay(150)
    tabs = await tabState()
    check('点回「AI 伴读」→ 恢复聊天面板', tabs.activeChat === 'true' && tabs.hasChatPane)

    // 停回笔记 Tab，让截图同时能看出 Tab 样式（后面会再切回）
    await cdp.evaluate(`document.querySelector('[data-testid="tab-notes"]').click()`)
    await delay(120)

    /* -------------------------------------------------- 3. 拖拽 */
    geometry = await cdp.evaluate(READ_GEOMETRY)
    await dragBy(geometry, 'left', 120)
    geometry = await cdp.evaluate(READ_GEOMETRY)
    check(
      '向左拖 120px → 左栏 260+120=380',
      Math.abs(geometry.left.width - 380) <= 2,
      `left=${geometry.left.width}`,
    )

    geometry = await cdp.evaluate(READ_GEOMETRY)
    await dragBy(geometry, 'left', -1000)
    geometry = await cdp.evaluate(READ_GEOMETRY)
    check('继续拖到极限 → 左栏被最小宽度 200 兜住', geometry.left.width === 200, `left=${geometry.left.width}`)

    geometry = await cdp.evaluate(READ_GEOMETRY)
    await dragBy(geometry, 'right', -150)
    geometry = await cdp.evaluate(READ_GEOMETRY)
    check(
      '右分隔条向左拖 150px → 右栏 380+150=530',
      Math.abs(geometry.right.width - 530) <= 2,
      `right=${geometry.right.width}`,
    )

    geometry = await cdp.evaluate(READ_GEOMETRY)
    await dragBy(geometry, 'right', 2000)
    geometry = await cdp.evaluate(READ_GEOMETRY)
    check('右栏被最小宽度 320 兜住', geometry.right.width === 320, `right=${geometry.right.width}`)

    /* -------------------------------------------------- 4. 键盘微调 */
    await cdp.evaluate(`document.querySelector('[data-testid="splitter-left"]').focus()`)
    const pressRight = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
          type,
          key: 'ArrowRight',
          code: 'ArrowRight',
          windowsVirtualKeyCode: 39,
          nativeVirtualKeyCode: 39,
        })
      }
      await delay(80)
    }
    await pressRight()
    await pressRight()
    geometry = await cdp.evaluate(READ_GEOMETRY)
    check(
      '分隔条聚焦后按两次 → = +32px（200 → 232）',
      geometry.left.width === 232,
      `left=${geometry.left.width}`,
    )

    /* -------------------------------------------------- 5. 窄窗口重钳制 */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await delay(500)
    geometry = await cdp.evaluate(READ_GEOMETRY)
    check(
      '窗口收窄到 900px 后自动重钳制，无横向溢出',
      geometry.gridScrollWidth <= geometry.gridClientWidth + 1 && geometry.center.width >= 360,
      `scrollWidth=${geometry.gridScrollWidth} clientWidth=${geometry.gridClientWidth} center=${geometry.center.width}`,
    )
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await delay(400)

    /* -------------------------------------------------- 6. 持久化 */
    const beforeReload = await cdp.evaluate(READ_GEOMETRY)
    check(
      '宽度已写入 localStorage(akn.ui)',
      typeof beforeReload.persisted === 'string' && beforeReload.persisted.includes('panelWidths'),
      String(beforeReload.persisted).slice(0, 80),
    )

    await cdp.send('Page.reload', { ignoreCache: false })
    await delay(1200)
    await waitFor('刷新后重新渲染', () =>
      cdp.evaluate(`document.querySelector('[data-testid="layout-grid"]') !== null`),
    )
    await delay(500)
    const afterReload = await cdp.evaluate(READ_GEOMETRY)
    check(
      '刷新后栏宽与 Tab 选择原样恢复',
      afterReload.left.width === beforeReload.left.width &&
        afterReload.right.width === beforeReload.right.width,
      `left ${beforeReload.left.width}→${afterReload.left.width} / right ${beforeReload.right.width}→${afterReload.right.width}`,
    )
    check(
      '刷新后仍停在「笔记」Tab',
      (await cdp.evaluate(
        `document.querySelector('[data-testid="tab-notes"]').getAttribute('aria-selected')`,
      )) === 'true',
    )

    /* -------------------------------------------------- 7. 重置栏宽（回到默认） */
    await cdp.evaluate(`document.querySelector('[data-testid="reset-widths"]').click()`)
    await delay(250)
    const afterReset = await cdp.evaluate(READ_GEOMETRY)
    check(
      '点击「重置栏宽」→ 回到默认 260 / 380',
      afterReset.left.width === 260 && afterReset.right.width === 380,
      `left=${afterReset.left.width} right=${afterReset.right.width}`,
    )

    /* -------------------------------------------------- 8. 右栏折叠 */
    await cdp.evaluate(`document.querySelector('[data-testid="reset-widths"]').click()`)
    await delay(250)
    const expanded = await cdp.evaluate(READ_GEOMETRY)
    await cdp.evaluate(`document.querySelector('[data-testid="toggle-right-dock"]').click()`)
    await delay(350)
    const collapsed = await cdp.evaluate(READ_GEOMETRY)
    check('点「隐藏伴读」→ 右栏收起（display:none）', collapsed.rightHidden === true && collapsed.right.width === 0,
      `hidden=${collapsed.rightHidden} right=${collapsed.right.width}`)
    check('右栏收起后中栏变宽', collapsed.center.width > expanded.center.width + 100,
      `center ${expanded.center.width} → ${collapsed.center.width}`)
    check('右栏收起后右侧分隔条也移除', collapsed.splitterRight === null)
    check('右栏收起后网格只剩三列', collapsed.gridColumns.split(' ').length === 3, collapsed.gridColumns)
    const toggleState = await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid="toggle-right-dock"]')
      return { pressed: button?.getAttribute('aria-pressed') ?? '', text: button?.textContent?.trim() ?? '' }
    })()`)
    check('顶部开关变成「显示伴读」且 aria-pressed=true', toggleState.pressed === 'true' && toggleState.text.includes('显示伴读'), JSON.stringify(toggleState))
    check('收起后出现贴边展开按钮', await cdp.evaluate(`!!document.querySelector('[data-testid="right-dock-expand"]')`))
    const collapsedShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile('docs/right-dock-collapsed.png', Buffer.from(collapsedShot.data, 'base64'))
    console.log('📸 收起状态截图：docs/right-dock-collapsed.png')

    await cdp.send('Page.reload', { ignoreCache: false })
    await delay(1200)
    await waitFor('刷新后重新渲染', () => cdp.evaluate(`document.querySelector('[data-testid="layout-grid"]') !== null`))
    await delay(400)
    const afterReloadCollapsed = await cdp.evaluate(READ_GEOMETRY)
    check('刷新后仍保持收起（持久化）', afterReloadCollapsed.rightHidden === true, `hidden=${afterReloadCollapsed.rightHidden}`)

    await cdp.evaluate(`document.querySelector('[data-testid="right-dock-expand"]').click()`)
    await delay(350)
    const expandedAgain = await cdp.evaluate(READ_GEOMETRY)
    check('点贴边按钮 → 右栏恢复（宽度仍是 380）', expandedAgain.rightHidden === false && expandedAgain.right.width === 380,
      `right=${expandedAgain.right.width}`)
    check('展开后右侧分隔条回来', expandedAgain.splitterRight !== null)

    /* -------------------------------------------------- 9. 截图（默认视图） */
    await cdp.evaluate(`document.querySelector('[data-testid="tab-chat"]').click()`)
    await delay(200)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await delay(400)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(SHOT_PATH, Buffer.from(shot.data, 'base64'))
    console.log(`📸 截图已保存：${SHOT_PATH}`)

    check(
      '页面全程无未捕获异常 / 无 error 级控制台日志',
      pageErrors.length === 0,
      pageErrors.length === 0 ? '' : JSON.stringify(pageErrors).slice(0, 160),
    )
  } finally {
    cleanup()
    await delay(150)
  }

  console.log(`\n通过 ${passes.length} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    console.log(failures.join('\n'))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('❌ 验收脚本异常：', error)
  process.exitCode = 1
})
