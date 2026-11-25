/**
 * AI Knowledge Navigator —— DSH 插件（宿主半）。
 *
 * 两件事：
 *  1) 把前端构建产物挂在 DSH Web 的 /akn/ 下（同源 iframe/标签页都能直接打开）；
 *  2) 提供 /api/akn/llm/* 桥接，用 **宿主进程内的 ctx.llm** 调当前配置的模型 ——
 *     因此不需要在本插件里配置任何 API Key，也不会把 Key 暴露给浏览器。
 *
 * 关键 API（读本机已有插件 @rtlcockpit 的宿主半确认）：
 *   ctx.get('llm').prepareCall({ provider, model }, signal)
 *   ctx.get('agentDefaultModel').currentSelection()
 *   ctx.webServer.register({ kind: 'prefix', path, handler })
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'akn'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = resolve(HERE, '..', 'static')
const APP_PREFIX = '/akn'
const API_PREFIX = '/api/akn'
const MAX_BODY_BYTES = 2 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

function json(res, status, body) {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

function fail(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } })
}

/**
 * 把上游的 INVALID_REQUEST / 模型名不支持 翻译成能看懂的中文提示。
 * 这样用户切换模型切错了，看到的是「去模型设置里选对名字」，而不是一坨英文。
 */
export function friendlyLlmError(error) {
  const message = error?.message ?? String(error)
  if (/supported api model names|invalid_request|model name/i.test(message)) {
    return (
      message +
      '\n\n【提示】当前选择的模型名不被 DeepSeek API 支持。请在 DSH 的模型设置里选择精确名 ' +
      'deepseek-flash 或 deepseek-v4-pro（不要选带版本号/显示别名的项）。'
    )
  }
  return message
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    let tooLarge = false
    const chunks = []

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // 超限时不要 destroy：那会让客户端收到 ECONNRESET 而不是干净的 413。
        // 继续把剩余数据读掉（丢弃），等 end 再统一回 413。
        tooLarge = true
        chunks.length = 0
        return
      }
      if (!tooLarge) chunks.push(chunk)
    })

    req.on('end', () => {
      if (tooLarge) {
        rejectPromise(Object.assign(new Error('请求体过大'), { code: 'PAYLOAD_TOO_LARGE', status: 413 }))
        return
      }
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })

    req.on('error', rejectPromise)
  })
}

function isSafeRelativePath(pathname) {
  if (pathname.includes('\0')) return false
  const normalized = normalize(pathname)
  return !normalized.startsWith('..') && !normalized.includes(`..${sep}`)
}

function serveFile(res, filePath, { immutable = false } = {}) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } })
    return
  }
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.statusCode = 200
  res.setHeader('content-type', type)
  res.setHeader(
    'cache-control',
    immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  )
  createReadStream(filePath).pipe(res)
}

async function handleStatic(res, pathname) {
  const rest = decodeURIComponent(pathname.slice(APP_PREFIX.length)) || '/'
  if (rest === '/' || rest === '') {
    serveFile(res, join(STATIC_DIR, 'index.html'))
    return
  }
  if (!isSafeRelativePath(rest)) {
    json(res, 400, { ok: false, error: { code: 'BAD_PATH', message: 'bad path' } })
    return
  }
  const candidate = join(STATIC_DIR, normalize(rest))
  if (candidate.startsWith(STATIC_DIR) && existsSync(candidate) && statSync(candidate).isFile()) {
    serveFile(res, candidate, { immutable: rest.startsWith('/assets/') })
    return
  }
  // SPA 回退；但 /assets/ 下的缺失文件必须真 404，避免把 HTML 当 JS 返回
  if (rest.startsWith('/assets/')) {
    json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'asset not found' } })
    return
  }
  serveFile(res, join(STATIC_DIR, 'index.html'))
}

/* ------------------------------------------------------------------ LLM 桥接 */

function readSelection(ctx) {
  try {
    const service = ctx?.get?.('agentDefaultModel')
    const selection = service?.currentSelection?.()
    if (selection && (selection.provider || selection.model)) return selection
  } catch {
    // 宿主版本差异：拿不到就当不可用
  }
  return null
}

function toRequestMessages(messages) {
  const out = []
  for (const message of messages) {
    const text = typeof message?.content === 'string' ? message.content : ''
    if (text === '') continue
    out.push({ role: 'user', content: [{ type: 'text', text }] })
  }
  return out
}

function splitSystem(messages) {
  const system = messages
    .filter((message) => message?.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .filter((text) => text !== '')
    .join('\n\n')
  const rest = messages.filter((message) => message?.role !== 'system')
  return { system, rest }
}

async function prepareCall(ctx, messages, signal, maxTokens) {
  const llm = ctx?.get?.('llm')
  if (llm === null || llm === undefined || typeof llm.prepareCall !== 'function') {
    throw Object.assign(new Error('宿主未提供 ctx.llm（当前 profile 没有 LLM 服务）'), {
      code: 'NO_LLM',
      status: 503,
    })
  }
  const selection = readSelection(ctx)
  if (selection === null) {
    throw Object.assign(new Error('宿主没有可用的默认模型（agentDefaultModel 未选中）'), {
      code: 'NO_MODEL',
      status: 503,
    })
  }

  const callConfig = { provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort) callConfig.reasoningEffort = selection.reasoningEffort
  // 关键：把请求里的 maxTokens 传给宿主（LlmCallConfig 支持）。
  // 不传的话模型没有输出上限，「整理这一章」/抽取会自由发挥，写到停不下来才慢。
  const cap = Number(maxTokens)
  if (Number.isFinite(cap) && cap > 0) callConfig.maxTokens = cap

  // 非流式调用没有外部 signal 时加一个兜底超时，避免请求永久挂住
  const effectiveSignal = signal ?? AbortSignal.timeout(300000)
  const prepared = await llm.prepareCall(callConfig, effectiveSignal)
  const { system, rest } = splitSystem(messages)
  const options = { ...prepared.config, messages: toRequestMessages(rest), signal: effectiveSignal }
  if (system !== '') options.system = system

  return { prepared, options, selection }
}

/** 非流式：把 text-delta 拼成完整文本。 */
async function completeOnce(ctx, messages, signal, maxTokens) {
  const { prepared, options, selection } = await prepareCall(ctx, messages, signal, maxTokens)
  let text = ''
  let failure = null
  for await (const chunk of prepared.stream(options)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
      failure = chunk.reason?.failure?.message ?? '模型调用失败'
    }
  }
  if (failure !== null) {
    throw Object.assign(new Error(friendlyLlmError(new Error(failure))), { code: 'LLM_ERROR', status: 502 })
  }
  if (text.trim() === '') {
    throw Object.assign(new Error('模型没有产出正文（可能只回了推理 chunk），请重试'), { code: 'NO_OUTPUT', status: 503 })
  }
  return { text, selection }
}

async function handleExtract(ctx, req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch (error) {
    if (error?.code === 'PAYLOAD_TOO_LARGE') {
      fail(res, 413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${MAX_BODY_BYTES} 字节`)
      return
    }
    fail(res, 400, 'BAD_REQUEST', '请求体不是合法 JSON')
    return
  }

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    fail(res, 400, 'BAD_REQUEST', 'messages 必填')
    return
  }

  try {
    const { text, selection } = await completeOnce(ctx, body.messages, undefined, body.maxTokens)
    json(res, 200, {
      ok: true,
      content: text,
      mock: false,
      promptVersion: String(body.promptVersion ?? 'unknown'),
      provider: selection.provider,
      model: selection.model,
    })
  } catch (error) {
    fail(res, error?.status ?? 502, error?.code ?? 'LLM_ERROR', friendlyLlmError(error))
  }
}

async function handleChat(ctx, req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch (error) {
    if (error?.code === 'PAYLOAD_TOO_LARGE') {
      fail(res, 413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${MAX_BODY_BYTES} 字节`)
      return
    }
    fail(res, 400, 'BAD_REQUEST', '请求体不是合法 JSON')
    return
  }

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    fail(res, 400, 'BAD_REQUEST', 'messages 必填')
    return
  }

  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('x-akn-mode', 'in-process')

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  const writeFrame = (text) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  }

  try {
    const { prepared, options } = await prepareCall(ctx, body.messages, controller.signal, body.maxTokens)
    for await (const chunk of prepared.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') writeFrame(chunk.text)
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
        const message = chunk.reason?.failure?.message ?? '模型调用失败'
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: { code: 'LLM_ERROR', message } })}\n\n`)
        }
      }
    }
  } catch (error) {
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          error: { code: error?.code ?? 'LLM_ERROR', message: error?.message ?? String(error) },
        })}\n\n`,
      )
    }
  } finally {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
}

function handleApi(ctx, req, res, pathname) {
  if (req.method === 'GET' && pathname === `${API_PREFIX}/health`) {
    const selection = readSelection(ctx)
    json(res, 200, {
      ok: true,
      service: 'akn-plugin',
      version: '0.1.0',
      time: new Date().toISOString(),
      llmConfigured: selection !== null,
      llmMock: false,
      provider: selection?.provider ?? null,
      model: selection?.model ?? null,
    })
    return
  }

  if (req.method === 'GET' && pathname === `${API_PREFIX}/llm/status`) {
    const selection = readSelection(ctx)
    json(res, 200, {
      ok: true,
      configured: selection !== null,
      mock: false,
      model: selection?.model ?? '',
      provider: selection?.provider ?? '',
      maxRetries: 0,
      timeoutMs: 0,
      mode: 'in-process',
    })
    return
  }

  if (req.method === 'POST' && pathname === `${API_PREFIX}/llm/extract`) {
    void handleExtract(ctx, req, res)
    return
  }

  if (req.method === 'POST' && pathname === `${API_PREFIX}/llm/chat`) {
    void handleChat(ctx, req, res)
    return
  }

  fail(res, 404, 'NOT_FOUND', 'not found')
}

/* ------------------------------------------------------------------ 插件入口 */

export function apply(ctx, pluginConfig) {
  const config = pluginConfig ?? {}

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname

      if (pathname.startsWith(API_PREFIX)) {
        if (config.requireBrowserAuth === true) {
          const connection = ctx?.get?.('connection')
          if (typeof connection?.requestRejection === 'function') {
            try {
              const rejection = connection.requestRejection({ headers: req.headers })
              if (rejection !== undefined) {
                fail(res, rejection, 'UNAUTHENTICATED', '需要 DSH 浏览器会话：请先在 dsh web 页面登录后再打开')
                return
              }
            } catch {
              // 宿主版本差异：不因鉴权探测失败而阻断
            }
          }
        }
        handleApi(ctx, req, res, pathname)
        return
      }

      if (pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`)) {
        await handleStatic(res, pathname)
        return
      }

      fail(res, 404, 'NOT_FOUND', 'not found')
    } catch (error) {
      fail(res, 500, 'INTERNAL', error?.message ?? String(error))
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: APP_PREFIX, handler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
}
