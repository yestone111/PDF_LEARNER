#!/usr/bin/env node
/**
 * 笔记贴图验收：系统截图 / 本地图片怎么进笔记。
 *
 * 覆盖三条入口 + 一条守卫 + 导出 + 持久化：
 *  1) Ctrl/Cmd+V 粘贴（合成 ClipboardEvent + DataTransfer，和真实粘贴同一条 path）
 *  2) 拖拽图片进编辑器（DragEvent drop）
 *  3) 工具栏「本地图片」文件选择（CDP setFileInputFiles 真实选文件）
 *  4) 超过 8MB 的图片被拒绝，并给出提示（不把笔记撑爆）
 *  5) Markdown 导出包含图片（小图内联 base64），刷新后仍在
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9247)
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/akn-user-manual.pdf')
const IMAGE_PATH = resolve('fixtures/note-screenshot.png')
const PROFILE = '/tmp/akn-note-image-profile'

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

const READ_IMAGES = `(() => {
  const images = [...document.querySelectorAll('[data-testid="note-editor"] img[data-graph-image]')]
  return {
    count: images.length,
    alts: images.map((el) => el.getAttribute('alt') ?? ''),
    srcPrefixes: images.map((el) => (el.getAttribute('src') ?? '').slice(0, 22)),
    hint: document.querySelector('[data-testid="notes-hint"]')?.textContent?.trim() ?? '',
  }
})()`

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

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__noteWrites = []
      const originalPut = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value, key) {
        try {
          if (this.name === 'noteDocs') {
            const json = JSON.stringify(value?.tiptapJson ?? {})
            window.__noteWrites.push({
              images: (json.match(/graphImage/g) ?? []).length,
              title: value?.title ?? '',
              documentId: value?.documentId ?? '',
              stack: (new Error().stack ?? '').split('\\n').slice(1, 5).join(' | '),
            })
          }
        } catch (error) {
          window.__noteWrites.push({ error: String(error) })
        }
        return originalPut.apply(this, arguments)
      }
    })()`,
  })

  await cdp.evaluate(`(() => { try { window.localStorage.clear() } catch {} return true })()`)
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 30000)

  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
  await waitFor('PDF 打开', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 120000)

  await cdp.evaluate(`document.querySelector('[data-testid="tab-notes"]').click()`)
  await waitFor('笔记编辑器', () => cdp.evaluate(`!!document.querySelector('[data-testid="note-editor"]')`), 30000)
  await delay(400)

  // 页面内构造一张 64×32 的 PNG 并转成 File（真实截图粘贴也是 File）
  const makeShot = (name) => `fetch(await new Promise((resolve) => { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#834a20'; ctx.fillRect(0, 0, 64, 32); ctx.fillStyle = '#fbf4e4'; ctx.fillRect(8, 8, 48, 16); canvas.toBlob((blob) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob) }, 'image/png') })).then((r) => r.blob()).then((blob) => new File([blob], '${name}', { type: 'image/png' }))`

  // ---------- 1. Ctrl/Cmd+V 粘贴 ----------
  const pasted = await cdp.evaluate(`(async () => {
    const file = await ${makeShot('shot.png')}
    const data = new DataTransfer()
    data.items.add(file)
    const editor = document.querySelector('[data-testid="note-editor"]')
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    editor.dispatchEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 500))
    return true
  })()`)
  check('合成粘贴事件已派发', pasted === true)
  let images = await waitFor('粘贴后出现图片', async () => {
    const state = await cdp.evaluate(READ_IMAGES)
    return state.count >= 1 ? state : null
  }, 8000)
  check('Ctrl/Cmd+V 粘贴截图 → 笔记里出现图片', images.count === 1, `count=${images.count}`)
  check('图片以 data URL 存在本地（不上传）', images.srcPrefixes.every((prefix) => prefix.startsWith('data:image/png')), images.srcPrefixes.join(','))
  check('粘贴的图片标注为「粘贴的截图」', images.alts[0] === '粘贴的截图', images.alts[0] ?? '')

  // ---------- 2. 拖拽 ----------
  await cdp.evaluate(`(async () => {
    const file = await ${makeShot('drop.png')}
    const data = new DataTransfer()
    data.items.add(file)
    const editor = document.querySelector('[data-testid="note-editor"]')
    const rect = editor.getBoundingClientRect()
    const x = Math.round(rect.left + rect.width / 2)
    const y = Math.round(rect.top + Math.min(40, rect.height / 2))
    // ProseMirror 的 handleDrop 需要能算出落点，真实拖拽一定带坐标
    editor.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true, clientX: x, clientY: y }))
    editor.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: x, clientY: y }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    return true
  })()`)
  images = await waitFor('拖拽后出现第二张图', async () => {
    const state = await cdp.evaluate(READ_IMAGES)
    return state.count >= 2 ? state : null
  }, 8000)
  check('拖拽图片进编辑器 → 插入成功', images.count === 2, `count=${images.count}`)
  check('拖入的图片标注为「拖入的图片」', images.alts.includes('拖入的图片'), images.alts.join(' / '))

  // ---------- 3. 工具栏「本地图片」 ----------
  const doc = await cdp.send('DOM.getDocument', { depth: -1 })
  const fileInput = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-testid="note-image-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [IMAGE_PATH] })
  images = await waitFor('选文件后出现第三张图', async () => {
    const state = await cdp.evaluate(READ_IMAGES)
    return state.count >= 3 ? state : null
  }, 8000)
  check('工具栏「本地图片」选文件 → 插入成功', images.count === 3, `count=${images.count}`)
  check('本地图片用文件名做说明', images.alts.includes('note-screenshot.png'), images.alts.join(' / '))

  // 等防抖保存（600ms）落库，再测守卫
  await delay(1200)

  // ---------- 4. 超大图片守卫 ----------
  await cdp.evaluate(`(async () => {
    const big = new File([new Uint8Array(9 * 1024 * 1024)], 'huge.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(big)
    const editor = document.querySelector('[data-testid="note-editor"]')
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    return true
  })()`)
  const afterHuge = await cdp.evaluate(READ_IMAGES)
  check('超过 8MB 的图片被拒绝，并给出提示', afterHuge.count === 3 && /超过 8MB/.test(afterHuge.hint), afterHuge.hint || '无提示')

  // ---------- 5. Markdown 导出 ----------
  await cdp.evaluate(`document.querySelector('[data-testid="export-markdown"]').click()`)
  await waitFor('导出预览', () => cdp.evaluate(`!!document.querySelector('[data-testid="export-modal"]')`), 8000)
  const markdown = await cdp.evaluate(`document.querySelector('[data-testid="markdown-preview"]')?.textContent ?? ''`)
  check('Markdown 导出包含三张图片', (markdown.match(/!\[[^\]]*\]\(/g) ?? []).length >= 3, `${(markdown.match(/!\[[^\]]*\]\(/g) ?? []).length} 张`)
  check('小图内联为 base64（不依赖外部文件）', markdown.includes('data:image/png;base64'), markdown.slice(0, 80))
  await cdp.evaluate(`document.querySelector('[data-testid="export-close"]').click()`)
  await delay(200)

  // ---------- 6. 刷新后仍在 ----------
  await cdp.send('Page.reload', { ignoreCache: false })
  await waitFor('恢复文档', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-viewer"]')`), 60000)
  await cdp.evaluate(`document.querySelector('[data-testid="tab-notes"]').click()`)
  const restored = await waitFor('笔记恢复', async () => {
    const state = await cdp.evaluate(READ_IMAGES)
    return state.count === 3 ? state : null
  }, 15000).catch(() => cdp.evaluate(READ_IMAGES))
  check('刷新后三张图片仍在（存在本机 IndexedDB）', restored.count === 3, `count=${restored.count}`)
  if (restored.count !== 3) {
    const diag = await cdp.evaluate(`new Promise((resolve) => {
      const request = indexedDB.open('ai-knowledge-navigator')
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('noteDocs', 'readonly').objectStore('noteDocs').getAll()
        tx.onsuccess = () => {
          const docs = tx.result
          const images = docs.flatMap((doc) => JSON.stringify(doc.tiptapJson ?? {}).match(/graphImage/g) ?? [])
          resolve({
            docs: docs.length,
            imageNodes: images.length,
            status: document.querySelector('[data-testid="notes-save-status"]')?.textContent?.trim() ?? '',
            editorHtml: (document.querySelector('[data-testid="note-editor"]')?.innerHTML ?? '').slice(0, 200),
          })
        }
        tx.onerror = () => resolve({ error: String(tx.error) })
      }
      request.onerror = () => resolve({ error: 'open' })
    })`)
    console.log('   持久化诊断:', JSON.stringify(diag))
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile('docs/note-image.png', Buffer.from(shot.data, 'base64'))
  console.log('📸 截图：docs/note-image.png')
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
