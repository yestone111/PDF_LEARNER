/**
 * 上游错误归一化。
 * 目标：前端永远只看到 `{ code, message }` 这一套，不需要理解 DeepSeek 的错误格式。
 */

export type LlmErrorCode =
  | 'MISSING_API_KEY'
  | 'BAD_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_RATE_LIMIT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'MOCK_ONLY'

export class LlmError extends Error {
  readonly code: LlmErrorCode
  readonly status: number
  readonly retryable: boolean

  constructor(code: LlmErrorCode, status: number, message: string, retryable = false) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/** 把上游 HTTP 状态映射成本项目的错误码（同时决定「要不要重试」）。 */
export function fromUpstreamStatus(status: number, body: string): LlmError {
  const trimmed = body.slice(0, 300)
  if (status === 401 || status === 403) {
    return new LlmError('MISSING_API_KEY', 500, `上游拒绝了凭证（${status}），请检查 DEEPSEEK_API_KEY`, false)
  }
  if (status === 429) {
    return new LlmError('UPSTREAM_RATE_LIMIT', 429, `上游限流：${trimmed}`, true)
  }
  if (status === 408) {
    return new LlmError('UPSTREAM_TIMEOUT', 504, `上游超时：${trimmed}`, true)
  }
  if (status >= 500) {
    return new LlmError('UPSTREAM_UNAVAILABLE', 502, `上游不可用（${status}）：${trimmed}`, true)
  }
  return new LlmError('UPSTREAM_ERROR', 502, `上游错误（${status}）：${trimmed}`, false)
}

export function toErrorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof LlmError) {
    return {
      status: error.status,
      body: { ok: false, error: { code: error.code, message: error.message } },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { ok: false, error: { code: 'INTERNAL', message } } }
}
