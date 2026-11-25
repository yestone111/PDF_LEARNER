import { config } from 'dotenv'

/**
 * 环境变量加载。
 * 只从 server/ 目录读取（pnpm --filter 会把 cwd 设为包目录），
 * 读取顺序：.env.local 优先，.env 兜底。
 */
export function loadEnv(): void {
  config({ path: ['.env.local', '.env'], quiet: true })
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return raw.trim() === '1' || raw.trim().toLowerCase() === 'true'
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name]
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback
}

export interface ServerEnv {
  readonly port: number
  readonly maxRequestBytes: number
  readonly deepseekApiKey: string
  readonly deepseekBaseUrl: string
  readonly deepseekModel: string
  /** 上游超时（毫秒）。 */
  readonly llmTimeoutMs: number
  /** 重试次数（不含首次），任务书要求最多 2 次。 */
  readonly llmMaxRetries: number
  /** 本地 mock 上游：只在显式 LLM_MOCK=1 时启用，且响应会带 x-akn-mock 头。 */
  readonly llmMock: boolean
  /** 让 mock 返回非法 JSON，用于验证 zod 拦截与 failed 状态。 */
  readonly llmMockBrokenJson: boolean
}

/** 必须在 loadEnv() 之后调用。 */
export function getEnv(): ServerEnv {
  const deepseekApiKey = readString('DEEPSEEK_API_KEY', '')
  return {
    port: readInt('PORT', 8787),
    maxRequestBytes: readInt('MAX_REQUEST_BYTES', 2 * 1024 * 1024),
    deepseekApiKey,
    deepseekBaseUrl: readString('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    deepseekModel: readString('DEEPSEEK_MODEL', 'deepseek-chat'),
    llmTimeoutMs: readInt('LLM_TIMEOUT_MS', 300_000),
    llmMaxRetries: Math.min(readInt('LLM_MAX_RETRIES', 2), 2),
    llmMock: readBool('LLM_MOCK', false),
    llmMockBrokenJson: readBool('LLM_MOCK_BROKEN_JSON', false),
  }
}
