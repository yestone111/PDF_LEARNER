import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { getEnv, loadEnv } from './env.js'
import { createLlmRoutes } from './llm/routes.js'

loadEnv()
const env = getEnv()

/**
 * Hono 代理服务（Step 0 只实现健康检查）。
 * 职责边界：LLM 转发、密钥保管、流式透传。不做任何业务持久化。
 * 后续 Step 3 在此挂载：
 *   POST /api/llm/chat     —— SSE 流式透传
 *   POST /api/llm/extract  —— 结构化抽取（非流式，JSON）
 */
const app = new Hono()

app.route(
  '/api/llm',
  createLlmRoutes({
    maxRequestBytes: env.maxRequestBytes,
    mock: env.llmMock,
    mockBrokenJson: env.llmMockBrokenJson,
    upstream: {
      apiKey: env.deepseekApiKey,
      baseUrl: env.deepseekBaseUrl,
      model: env.deepseekModel,
      timeoutMs: env.llmTimeoutMs,
      maxRetries: env.llmMaxRetries,
    },
  }),
)

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'akn-server',
    version: '0.1.0',
    time: new Date().toISOString(),
    llmConfigured: env.deepseekApiKey !== '',
    llmMock: env.llmMock,
  }),
)

app.notFound((c) =>
  c.json(
    {
      ok: false,
      error: { code: 'NOT_FOUND', message: `未实现的路由：${c.req.method} ${c.req.path}` },
    },
    404,
  ),
)

app.onError((error, c) => {
  console.error('[akn-server] 未捕获错误：', error)
  return c.json(
    { ok: false, error: { code: 'INTERNAL', message: '服务端内部错误' } },
    500,
  )
})

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[akn-server] 已启动：http://127.0.0.1:${info.port}`)
  if (env.llmMock) {
    console.warn('[akn-server] ⚠ LLM_MOCK=1：正在使用本地 mock 上游，所有 LLM 响应都会标记 x-akn-mock=1')
  } else if (env.deepseekApiKey === '') {
    console.warn('[akn-server] 未检测到 DEEPSEEK_API_KEY：/api/llm/* 会返回 503（不会伪造结果）')
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
