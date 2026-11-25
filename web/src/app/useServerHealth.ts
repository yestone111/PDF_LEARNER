import { useEffect, useState } from 'react'
import { z } from 'zod'

import { HEALTH_API_URL } from '../lib/apiBase'

/** 与 server/src/index.ts 的 /api/health 响应保持同步。 */
const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  time: z.string(),
  llmConfigured: z.boolean(),
})

export type ServerHealth = z.infer<typeof HealthResponseSchema>

export type ServerHealthState =
  | { status: 'loading' }
  | { status: 'ready'; data: ServerHealth }
  | { status: 'error'; message: string }

/**
 * 后端连通性探针。
 * 保留在 UI 顶栏的原因：它同时证明「前端 → /api 同源代理 → Hono」整条链路通，
 * 是每次改动后最廉价的一次端到端自检。
 */
export function useServerHealth(): ServerHealthState {
  const [state, setState] = useState<ServerHealthState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()

    const check = async (): Promise<void> => {
      try {
        const response = await fetch(HEALTH_API_URL, { signal: controller.signal })
        if (!response.ok) throw new Error(`健康检查返回 HTTP ${response.status}`)
        const parsed = HealthResponseSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('健康检查响应不符合约定 schema')
        setState({ status: 'ready', data: parsed.data })
      } catch (error) {
        if (controller.signal.aborted) return
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void check()
    return () => controller.abort()
  }, [])

  return state
}
