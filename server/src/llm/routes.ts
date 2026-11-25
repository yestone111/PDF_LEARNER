/**
 * LLM 代理路由。
 * 只做：注入 key、超时/重试、错误归一、413 保护、SSE 透传。
 * 不做：业务持久化、prompt 拼装、zod 校验（都在前端 llm/ 层，保证「未过 zod 不落库」）。
 */

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'

import { callChatStream, callChatText, type ChatMessage, type UpstreamConfig } from './client.js'
import { LlmError, toErrorResponse } from './errors.js'
import {
  mockChatAnswer,
  mockChunkExtraction,
  mockChapterSummary,
  mockNodeEnrich,
  mockGlobalReduce,
  mockStats,
  mockStreamChunks,
} from './mock.js'

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
})

const ExtractRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1),
  promptVersion: z.string().min(1),
  stage: z.enum(['chunk_extract', 'global_reduce', 'json_repair', 'node_enrich', 'chapter_summary']),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32000).optional(),
})

const ChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
})

export interface LlmRouteOptions {
  readonly maxRequestBytes: number
  readonly mock: boolean
  readonly mockBrokenJson: boolean
  readonly upstream: UpstreamConfig
}

function requireKey(options: LlmRouteOptions): void {
  if (options.mock) return
  if (options.upstream.apiKey.trim() === '') {
    throw new LlmError('MISSING_API_KEY', 503, '服务端未配置 DEEPSEEK_API_KEY（server/.env.local）', false)
  }
}

export function createLlmRoutes(options: LlmRouteOptions): Hono {
  const routes = new Hono()

  // 超长请求：直接 413，不把上游的错误透传出去（任务书 §4 明确要求）
  routes.use(
    '/chat',
    bodyLimit({
      maxSize: options.maxRequestBytes,
      onError: (c) =>
        c.json(
          { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: `请求体超过 ${options.maxRequestBytes} 字节` } },
          413,
        ),
    }),
  )
  routes.use(
    '/extract',
    bodyLimit({
      maxSize: options.maxRequestBytes,
      onError: (c) =>
        c.json(
          { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: `请求体超过 ${options.maxRequestBytes} 字节` } },
          413,
        ),
    }),
  )

  routes.get('/status', (c) =>
    c.json({
      ok: true,
      configured: options.upstream.apiKey.trim() !== '',
      mock: options.mock,
      model: options.upstream.model,
      maxRetries: options.upstream.maxRetries,
      timeoutMs: options.upstream.timeoutMs,
    }),
  )

  routes.get('/mock-stats', (c) => c.json({ ok: true, ...mockStats }))

  routes.post('/extract', async (c) => {
    try {
      const json = await c.req.json().catch(() => null)
      const parsed = ExtractRequestSchema.safeParse(json)
      if (!parsed.success) {
        throw new LlmError(
          'BAD_REQUEST',
          400,
          `请求体不合法：${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        )
      }

      const body = parsed.data

      if (options.mock) {
        if (body.stage === 'json_repair') mockStats.repairCalls += 1
        else mockStats.extractCalls += 1

        const prompt = body.messages.map((message) => message.content).join('\n')
        const content = options.mockBrokenJson
          ? '{"stage":"chunk_extract","nodes":[{"title":"","importance":99}],"edges":[]}'
          : body.stage === 'chapter_summary'
            ? mockChapterSummary(prompt)
            : body.stage === 'node_enrich'
              ? mockNodeEnrich(prompt)
            : body.stage === 'global_reduce'
              ? mockGlobalReduce(prompt)
            : mockChunkExtraction(prompt)

        return c.json({ ok: true, content, mock: true, promptVersion: body.promptVersion })
      }

      requireKey(options)
      const content = await callChatText(
        {
          messages: body.messages as ChatMessage[],
          temperature: body.temperature,
          maxTokens: body.maxTokens ?? 4096,
          jsonMode: true,
        },
        options.upstream,
      )
      return c.json({ ok: true, content, mock: false, promptVersion: body.promptVersion })
    } catch (error) {
      const { status, body } = toErrorResponse(error)
      return c.json(body, status as 400)
    }
  })

  routes.post('/chat', async (c) => {
    try {
      const json = await c.req.json().catch(() => null)
      const parsed = ChatRequestSchema.safeParse(json)
      if (!parsed.success) {
        throw new LlmError('BAD_REQUEST', 400, '请求体不合法：messages 必填')
      }
      const body = parsed.data

      if (options.mock) {
        mockStats.chatCalls += 1
        const prompt = body.messages.map((message) => message.content).join('\n')
        const answer = mockChatAnswer(prompt)
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of mockStreamChunks(answer)) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`),
              )
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-akn-mock': '1',
          },
        })
      }

      requireKey(options)
      const upstream = await callChatStream(
        { messages: body.messages as ChatMessage[], temperature: body.temperature },
        options.upstream,
      )

      return new Response(upstream.body, {
        headers: {
          'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-akn-mock': '0',
        },
      })
    } catch (error) {
      const { status, body } = toErrorResponse(error)
      return c.json(body, status as 400)
    }
  })

  return routes
}
