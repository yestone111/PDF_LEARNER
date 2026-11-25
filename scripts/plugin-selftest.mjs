#!/usr/bin/env node
/**
 * DSH 插件自测：用一个「假 ctx」跑真实 HTTP 请求，验证：
 *  - /akn/ 静态托管（index、assets、缺失资源 404）
 *  - /api/akn/llm/* 桥接（status / extract / chat SSE / 413 / 无模型 503）
 *
 * 假 ctx 的接口形状来自本机真实插件 @rtlcockpit 的宿主半与 DSH 包：
 *  ctx.get('llm').prepareCall({provider, model}, signal) → { config, stream(options) }
 *  ctx.get('agentDefaultModel').currentSelection() → { provider, model }
 *  ctx.webServer.register({ kind:'prefix', path, handler })
 */

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginUrl = pathToFileURL(join(root, 'plugin/lib/index.js')).href

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

function makeFakeCtx({ selection = { provider: 'deepseek', model: 'deepseek-v4-pro' }, text = '模型输出示例' } = {}) {
  const routes = []
  const seenConfigs = []
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          async prepareCall(config) {
            seenConfigs.push(config)
            return {
              config: { ...config },
              async *stream() {
                yield { type: 'text-delta', text }
                yield { type: 'finish', reason: { kind: 'stop' } }
              },
            }
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => selection }
      }
      return undefined
    },
    effect(fn) {
      fn()
    },
    webServer: {
      register(entry) {
        routes.push(entry)
        return () => {}
      },
    },
  }
  return { ctx, routes, seenConfigs }
}

async function start(routes) {
  const handler = routes[0].handler
  const server = createServer((req, res) => handler(req, res))
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const port = server.address().port
  return { server, base: `http://127.0.0.1:${port}` }
}

function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const { ctx, routes, seenConfigs } = makeFakeCtx()
const module = await import(pluginUrl)
check('插件导出 name/inject/apply', module.name === 'akn' && module.inject.includes('webServer') && typeof module.apply === 'function')
module.apply(ctx, {})

check('注册了 /akn 与 /api/akn 两个前缀路由', routes.length === 2, routes.map((r) => r.path).join(' , '))

const { server, base } = await start(routes)
try {
  const index = await fetch(`${base}/akn/`)
  const html = await index.text()
  check('GET /akn/ 返回应用首页', index.status === 200 && html.includes('/akn/assets/'), `status=${index.status}`)
  check('首页 content-type 是 HTML', (index.headers.get('content-type') ?? '').includes('text/html'))

  const bundleName = /\/akn\/(assets\/[^"]+\.js)/.exec(html)?.[1]
  check('首页引用了带 /akn/ 前缀的 bundle', bundleName !== undefined, bundleName ?? '')

  const asset = await fetch(`${base}/akn/${bundleName}`)
  check('GET /akn/assets/*.js 返回 JS', asset.status === 200 && (asset.headers.get('content-type') ?? '').includes('javascript'))
  check('assets 使用长缓存头', (asset.headers.get('cache-control') ?? '').includes('immutable'))

  const missing = await fetch(`${base}/akn/assets/does-not-exist.js`)
  check('缺失的 assets 返回 404（不会回退成 HTML）', missing.status === 404)

  const status = await (await fetch(`${base}/api/akn/llm/status`)).json()
  check('status 报告已配置模型（继承宿主）', status.configured === true && status.model === 'deepseek-v4-pro', JSON.stringify(status))
  check('status 明确 mock=false（不是假数据）', status.mock === false)

  const health = await (await fetch(`${base}/api/akn/health`)).json()
  check('health 返回 llmConfigured=true', health.ok === true && health.llmConfigured === true, health.model ?? '')

  const extract = await (await post(base, '/api/akn/llm/extract', {
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
    promptVersion: 'chunk-extract@1',
    stage: 'chunk_extract',
    maxTokens: 320,
  })).json()
  check('extract 返回模型文本', extract.ok === true && extract.content === '模型输出示例', extract.content)
  check('extract 回传 provider/model', extract.provider === 'deepseek' && extract.model === 'deepseek-v4-pro')
  check('maxTokens 被传给宿主（输出有上限，不再自由发挥）', seenConfigs.some((config) => config.maxTokens === 320), JSON.stringify(seenConfigs[0] ?? {}))

  const chatRes = await post(base, '/api/akn/llm/chat', { messages: [{ role: 'user', content: 'hi' }] })
  const sse = await chatRes.text()
  check('chat 返回 SSE', (chatRes.headers.get('content-type') ?? '').includes('text/event-stream'))
  check('chat 帧格式兼容前端解析器', sse.includes('data: {"choices":[{"delta":{"content":"模型输出示例"}}]}'))
  check('chat 以 [DONE] 收尾', sse.trim().endsWith('data: [DONE]'))

  const big = await post(base, '/api/akn/llm/extract', JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(3 * 1024 * 1024) }] }))
  check('超大请求体返回 413', big.status === 413, `status=${big.status}`)

  const bad = await post(base, '/api/akn/llm/extract', { nope: true })
  check('缺 messages 返回 400', bad.status === 400)

  const unknown = await fetch(`${base}/api/akn/nope`)
  check('未知 API 返回 404', unknown.status === 404)

  const staticUnknown = await fetch(`${base}/akn/nope/route`)
  check('未知前端路径回退到 index.html', staticUnknown.status === 200 && (await staticUnknown.text()).includes('/akn/assets/'))
} finally {
  server.close()
}

// 没有选择模型时：503 NO_MODEL（而不是偷偷用别的 key）
const { ctx: ctx2, routes: routes2 } = makeFakeCtx({ selection: null })
const module2 = await import(pluginUrl)
module2.apply(ctx2, {})
const { server: server2, base: base2 } = await start(routes2)
try {
  const res = await post(base2, '/api/akn/llm/extract', { messages: [{ role: 'user', content: 'hi' }] })
  const body = await res.json()
  check('宿主未选模型时返回 503 NO_MODEL', res.status === 503 && body.error.code === 'NO_MODEL', JSON.stringify(body.error))
} finally {
  server2.close()
}

// 空输出：模型只回 finish、不给正文 → 应返回 503 NO_OUTPUT（而不是 ok:true content:''）
const { ctx: ctx3, routes: routes3 } = makeFakeCtx({ text: '' })
const module3 = await import(pluginUrl)
module3.apply(ctx3, {})
const { server: server3, base: base3 } = await start(routes3)
try {
  const res = await post(base3, '/api/akn/llm/extract', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })
  const body = await res.json()
  check('模型空输出时返回 503 NO_OUTPUT（不再假装成功）', res.status === 503 && body.error.code === 'NO_OUTPUT', JSON.stringify(body.error))
} finally {
  server3.close()
}

// 错误翻译：模型名不被支持时应给出中文提示
if (typeof module.friendlyLlmError === 'function') {
  const translated = module.friendlyLlmError(new Error('The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed DeepSeek-V41-Flash. INVALID_REQUEST'))
  check('INVALID_REQUEST 被翻译成中文提示', translated.includes('模型名不被 DeepSeek API 支持') && translated.includes('deepseek-flash'), translated.slice(0, 60))
  check('普通错误原样保留', module.friendlyLlmError(new Error('超时')) === '超时')
} else {
  check('导出 friendlyLlmError', false, '未导出')
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
