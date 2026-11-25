/**
 * LLM 客户端（前端唯一出网口）。
 *
 * 硬约束（任务书 §4）：业务代码不得出现 fetch 到 LLM 域名的代码。
 * 这个文件里只有 `/api/llm/*` 这种同源路径，密钥永远不经过浏览器。
 */

import { z } from 'zod'

import { LLM_API_BASE } from '../lib/apiBase'

import type { ExtractionStage } from '../domain/enums'

export type LlmErrorCode =
  | 'MISSING_API_KEY'
  | 'BAD_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_RATE_LIMIT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'NETWORK'
  | 'ABORTED'

export class LlmClientError extends Error {
  readonly code: LlmErrorCode
  readonly status: number

  constructor(code: LlmErrorCode, status: number, message: string) {
    super(message)
    this.name = 'LlmClientError'
    this.code = code
    this.status = status
  }
}

const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
})

const ExtractResponseSchema = z.object({
  ok: z.literal(true),
  content: z.string(),
  mock: z.boolean(),
  promptVersion: z.string(),
})

const StreamChunkSchema = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().optional() }).optional() })).optional(),
})

export interface LlmStatus {
  readonly configured: boolean
  readonly mock: boolean
  readonly model: string
  readonly maxRetries: number
  readonly timeoutMs: number
}

export type PromptMessageInput = { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }

async function parseError(response: Response): Promise<LlmClientError> {
  const text = await response.text().catch(() => '')
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(text))
    if (parsed.success) {
      return new LlmClientError(parsed.data.error.code as LlmErrorCode, response.status, parsed.data.error.message)
    }
  } catch {
    // 非 JSON 错误体：走兜底
  }
  return new LlmClientError(
    response.status >= 500 ? 'UPSTREAM_ERROR' : 'BAD_REQUEST',
    response.status,
    text.slice(0, 300) || `HTTP ${response.status}`,
  )
}

export async function fetchLlmStatus(signal?: AbortSignal): Promise<LlmStatus> {
  const response = await fetch(`${LLM_API_BASE}/status`, { signal })
  if (!response.ok) throw await parseError(response)
  const json = (await response.json()) as Record<string, unknown>
  return {
    configured: json.configured === true,
    mock: json.mock === true,
    model: typeof json.model === 'string' ? json.model : '',
    maxRetries: typeof json.maxRetries === 'number' ? json.maxRetries : 0,
    timeoutMs: typeof json.timeoutMs === 'number' ? json.timeoutMs : 0,
  }
}

export interface ExtractionCall {
  readonly stage: ExtractionStage
  readonly promptVersion: string
  readonly messages: readonly PromptMessageInput[]
  readonly maxTokens?: number
  readonly temperature?: number
  readonly signal?: AbortSignal
}

/** 结构化抽取调用：返回模型原始文本，**校验不在这里**（由 pipeline 过 zod）。 */
export async function requestExtraction(
  call: ExtractionCall,
): Promise<{ content: string; mock: boolean }> {
  let response: Response
  try {
    response = await fetch(`${LLM_API_BASE}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: call.messages,
        promptVersion: call.promptVersion,
        stage: call.stage,
        maxTokens: call.maxTokens,
        temperature: call.temperature,
      }),
      signal: call.signal,
    })
  } catch (error) {
    if (call.signal?.aborted === true) throw new LlmClientError('ABORTED', 499, '请求已取消')
    throw new LlmClientError('NETWORK', 0, error instanceof Error ? error.message : '网络错误')
  }

  if (!response.ok) throw await parseError(response)

  const parsed = ExtractResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new LlmClientError('UPSTREAM_ERROR', 502, '代理返回结构不符合约定')
  }
  return { content: parsed.data.content, mock: parsed.data.mock }
}

/** 流式对话：逐块 yield 文本增量。 */
export async function* streamChat(
  messages: readonly PromptMessageInput[],
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  let response: Response
  try {
    response = await fetch(`${LLM_API_BASE}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true) throw new LlmClientError('ABORTED', 499, '请求已取消')
    throw new LlmClientError('NETWORK', 0, error instanceof Error ? error.message : '网络错误')
  }

  if (!response.ok) throw await parseError(response)
  const body = response.body
  if (body === null) throw new LlmClientError('UPSTREAM_ERROR', 502, '响应没有可读流')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')

        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') return
          let json: unknown
          try {
            json = JSON.parse(payload)
          } catch {
            continue
          }
          const chunk = StreamChunkSchema.safeParse(json)
          if (!chunk.success) continue
          const delta = chunk.data.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta !== '') yield delta
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
