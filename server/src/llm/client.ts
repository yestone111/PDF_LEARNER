/**
 * DeepSeek 上游调用（服务端唯一出网口）。
 * 职责：注入 key、超时、最多 2 次指数退避重试、状态码归一化。
 * 不做：业务校验、持久化、prompt 拼装（prompt 在前端 llm/prompts 里统一管理版本）。
 */

import { LlmError, fromUpstreamStatus } from './errors.js'

export interface UpstreamConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly timeoutMs: number
  /** 重试次数（不含首次）：任务书要求最多 2 次。 */
  readonly maxRetries: number
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface ChatPayload {
  readonly messages: readonly ChatMessage[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly jsonMode?: boolean
  readonly stream?: boolean
  /** 透传给上游的 abort 信号（不参与重试判定）。 */
  readonly signal?: AbortSignal
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new LlmError('UPSTREAM_TIMEOUT', 499, '客户端已取消', false))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 指数退避：300ms → 900ms（首次失败后最多再试 2 次）。 */
export function backoffDelay(attempt: number): number {
  return 300 * 3 ** attempt
}

function buildBody(payload: ChatPayload, config: UpstreamConfig): string {
  return JSON.stringify({
    model: config.model,
    messages: payload.messages,
    stream: payload.stream === true,
    temperature: payload.temperature ?? 0.2,
    ...(payload.maxTokens === undefined ? {} : { max_tokens: payload.maxTokens }),
    ...(payload.jsonMode === true ? { response_format: { type: 'json_object' } } : {}),
  })
}

/** 非流式调用：返回上游文本（JSON 模式时就是模型输出的 JSON 字符串）。 */
export async function callChatText(
  payload: ChatPayload,
  config: UpstreamConfig,
): Promise<string> {
  let lastError: LlmError | null = null

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    if (attempt > 0) {
      await sleep(backoffDelay(attempt - 1), payload.signal)
    }

    const timeout = AbortSignal.timeout(config.timeoutMs)
    const signal = payload.signal === undefined ? timeout : AbortSignal.any([timeout, payload.signal])

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: buildBody({ ...payload, stream: false }, config),
        signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const error = fromUpstreamStatus(response.status, text)
        if (error.retryable && attempt < config.maxRetries) {
          lastError = error
          continue
        }
        throw error
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim() === '') {
        throw new LlmError('UPSTREAM_ERROR', 502, '上游返回了空内容')
      }
      return content
    } catch (error) {
      if (error instanceof LlmError && !error.retryable) throw error
      if (error instanceof LlmError) {
        lastError = error
        continue
      }
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        lastError = new LlmError('UPSTREAM_TIMEOUT', 504, `上游超时（>${config.timeoutMs}ms）`, true)
        if (attempt < config.maxRetries) continue
        throw lastError
      }
      lastError = new LlmError(
        'UPSTREAM_ERROR',
        502,
        `网络错误：${error instanceof Error ? error.message : String(error)}`,
        true,
      )
      if (attempt < config.maxRetries) continue
      throw lastError
    }
  }

  throw lastError ?? new LlmError('UPSTREAM_ERROR', 502, '上游调用失败')
}

/** 流式调用：直接返回上游 Response（SSE 透传用），同样带重试与超时。 */
export async function callChatStream(
  payload: ChatPayload,
  config: UpstreamConfig,
): Promise<Response> {
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const signal = payload.signal === undefined ? timeout : AbortSignal.any([timeout, payload.signal])

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
      accept: 'text/event-stream',
    },
    body: buildBody({ ...payload, stream: true }, config),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw fromUpstreamStatus(response.status, text)
  }
  return response
}
