/**
 * 大规模文档的「两阶段汇总」分批计划。
 *
 * 为什么需要：reduce 一次性塞进几百个节点时，
 *  - 输出会被 maxTokens 截断 → JSON 非法（真实大文档失败的主因之一）；
 *  - 单次调用耗时可能超过超时。
 * 做法：节点太多时先分批汇总（每批 ≤ batchSize），再把各批结果做最终汇总。
 */

export interface ReducePlan {
  /** 每批的节点下标。只有一项时表示「直接单次汇总」。 */
  readonly batches: readonly (readonly number[])[]
  /** 是否需要在批次结果之上再做一次最终汇总。 */
  readonly needsFinal: boolean
  /** 因超出上限被丢弃的节点数（按重要度排序后截断）。 */
  readonly dropped: number
}

export const REDUCE_LIMITS = {
  /** 单次汇总最多喂多少节点；超过则分批。 */
  batchSize: 80,
  /** 最多分几批（再多的节点按重要度截断）。 */
  maxBatches: 3,
} as const

export function planReduceBatches(
  count: number,
  options: { batchSize?: number; maxBatches?: number } = {},
): ReducePlan {
  const batchSize = Math.max(1, options.batchSize ?? REDUCE_LIMITS.batchSize)
  const maxBatches = Math.max(1, options.maxBatches ?? REDUCE_LIMITS.maxBatches)
  const capacity = batchSize * maxBatches
  const kept = Math.min(count, capacity)
  const dropped = Math.max(0, count - kept)

  if (kept === 0) return { batches: [], needsFinal: false, dropped }
  if (kept <= batchSize) {
    return { batches: [Array.from({ length: kept }, (_, index) => index)], needsFinal: false, dropped }
  }

  const batches: number[][] = []
  for (let start = 0; start < kept; start += batchSize) {
    const end = Math.min(start + batchSize, kept)
    batches.push(Array.from({ length: end - start }, (_, index) => start + index))
  }
  return { batches, needsFinal: batches.length > 1, dropped }
}
