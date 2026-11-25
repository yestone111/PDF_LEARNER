/**
 * API 基址。
 *
 * 同一份前端代码要跑在两种形态下：
 *  1) 独立运行：Vite 代理 /api → Hono(8787)；
 *  2) 作为 DSH 插件嵌入：由插件内的进程内 LLM 桥接提供 /api/akn/*。
 * 构建时用 VITE_API_BASE 指定，运行时零判断，避免两套分支逻辑。
 */

const raw = import.meta.env.VITE_API_BASE
const base = (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '/api').replace(/\/$/, '')

export const API_BASE = base
export const LLM_API_BASE = `${base}/llm`
export const HEALTH_API_URL = `${base}/health`
