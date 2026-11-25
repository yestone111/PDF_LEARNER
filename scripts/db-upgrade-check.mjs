#!/usr/bin/env node
/**
 * IndexedDB 迁移验收：v1（没有 bookmarks 表）→ 当前版本（DB_VERSION=2）。
 *
 * 做法：先在一个空 profile 里手工建出「v1 结构 + 一条老数据」，再打开应用，
 * 让应用自己去升级数据库，然后校验：
 *   1) 应用能正常启动（升级没把它打挂）；
 *   2) bookmarks 表被创建出来；
 *   3) v1 里的老数据还在（不是删库重建）。
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const APP_URL = process.env.AKN_APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.AKN_CDP_PORT ?? 9241)
const PROFILE = '/tmp/akn-db-upgrade-profile'
const PDF_PATH = resolve(process.env.AKN_PDF ?? 'fixtures/akn-user-manual.pdf')
// IndexedDB 在 about:blank（不透明源）里被禁用，所以先停在同源的普通路径上建 v1 库
const BLANK_SAME_ORIGIN = `${new URL(APP_URL).origin}/robots.txt`

let pass = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const waitFor = async (desc, fn, timeoutMs = 30000) => {
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

/** v1 的 store 声明（与 database.ts 里 v2 之前的 TABLE_STORES 一致，只是没有 bookmarks）。 */
const V1_STORES = {
  documents: 'id, name, status, createdAt',
  pdfFiles: 'id, documentId',
  outlineNodes: 'id, documentId, parentId, page, [documentId+order]',
  knowledgeNodes:
    'id, documentId, parentId, chapterId, scope, importance, mastery, sourceChunkId, [documentId+scope], [documentId+chapterId]',
  knowledgeEdges: 'id, documentId, sourceId, targetId, relationType, [documentId+sourceId]',
  highlights: 'id, documentId, nodeId',
  notes: 'id, documentId, highlightId, nodeId, createdAt',
  chunks: 'id, documentId, order, [documentId+order]',
  extractionCaches: 'key, documentId, stage, status, promptVersion, updatedAt',
  chatThreads: 'id, documentId, updatedAt',
  chatMessages: 'id, threadId, documentId, role, createdAt, [threadId+createdAt]',
  noteDocs: 'id, documentId, updatedAt',
  noteImages: 'id, noteDocId, documentId, createdAt',
  syncConfigs: 'id, target, enabled',
}

await mkdir(PROFILE, { recursive: true })
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, '--window-size=1200,800', BLANK_SAME_ORIGIN,
], { stdio: 'ignore' })
chrome.unref()
process.on('exit', () => { if (!chrome.killed) chrome.kill('SIGKILL') })

try {
  const target = await waitFor('CDP 就绪', async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch { return null }
  })
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, reject) => {
    socket.addEventListener('open', ok, { once: true })
    socket.addEventListener('error', () => reject(new Error('ws failed')), { once: true })
  })
  const cdp = new Cdp(socket)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable')

  // 1) 在空白页里造一个 v1 库 + 一条老数据
  const created = await cdp.evaluate(`new Promise((resolve) => {
    const request = indexedDB.open('ai-knowledge-navigator', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      const stores = ${JSON.stringify(V1_STORES)}
      for (const [name, spec] of Object.entries(stores)) {
        const parts = spec.split(',').map((item) => item.trim())
        const store = db.createObjectStore(name, { keyPath: parts[0] })
        for (const index of parts.slice(1)) {
          if (index.startsWith('[')) {
            const keys = index.slice(1, -1).split('+').map((item) => item.trim())
            store.createIndex(index, keys)
          } else {
            store.createIndex(index, index)
          }
        }
      }
      const docs = request.transaction.objectStore('documents')
      docs.add({ id: 'v1-doc', name: 'v1-probe.pdf', pageCount: 3, sizeBytes: 1, fileId: 'v1-file', status: 'uploaded', createdAt: 1, updatedAt: 1 })
    }
    request.onsuccess = () => { request.result.close(); resolve({ ok: true }) }
    request.onerror = () => resolve({ ok: false, error: String(request.error) })
  })`)
  check('先造出 v1 数据库（没有 bookmarks 表）', created.ok === true, JSON.stringify(created))

  const v1Stores = await cdp.evaluate(`new Promise((resolve) => {
    const request = indexedDB.open('ai-knowledge-navigator')
    request.onsuccess = () => {
      const names = [...request.result.objectStoreNames]
      request.result.close()
      resolve(names)
    }
    request.onerror = () => resolve([])
  })`)
  check('v1 里确实还没有 bookmarks', !v1Stores.includes('bookmarks'), `stores=${v1Stores.length}`)

  // 2) 打开应用，让它自己升级
  await cdp.send('Page.navigate', { url: APP_URL })
  await waitFor('应用加载', () => cdp.evaluate(`!!document.querySelector('[data-testid="pdf-input"]')`), 60000)
  // Dexie 是懒打开：真正触发升级要等第一次读写数据库（这里用「打开 PDF」触发）
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="pdf-input"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [PDF_PATH] })
  await waitFor('目录加载（数据库已读写）', () => cdp.evaluate(`document.querySelectorAll('[data-testid^="outline-item-"]').length > 3`), 120000)
  await delay(300)

  const after = await cdp.evaluate(`new Promise((resolve) => {
    const request = indexedDB.open('ai-knowledge-navigator')
    request.onsuccess = () => {
      const db = request.result
      const names = [...db.objectStoreNames]
      const docs = db.transaction('documents', 'readonly').objectStore('documents').get('v1-doc')
      docs.onsuccess = () => { db.close(); resolve({ version: db.version, names, oldDoc: docs.result ?? null }) }
      docs.onerror = () => { db.close(); resolve({ version: db.version, names, oldDoc: null }) }
    }
    request.onerror = () => resolve({ version: 0, names: [], oldDoc: null })
  })`)

  check('应用启动后数据库被升级到 v2', after.version >= 2, `version=${after.version} · stores=${after.names.length}`)
  check('bookmarks 表已创建', after.names.includes('bookmarks'), after.names.filter((name) => name === 'bookmarks').join(''))
  check('v1 的老数据还在（不是删库重建）', after.oldDoc !== null && after.oldDoc.name === 'v1-probe.pdf', JSON.stringify(after.oldDoc ?? null))
  const errorShown = await cdp.evaluate(`document.body?.innerText?.includes('升级') || document.body?.innerText?.includes('error') ? document.body.innerText.slice(0, 120) : ''`)
  check('页面没有出现升级相关报错', errorShown === '', errorShown)
} finally {
  if (!chrome.killed) chrome.kill('SIGKILL')
  await delay(150)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
