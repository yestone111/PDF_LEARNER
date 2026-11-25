/**
 * 单元质量闸门（PICA：前缀连贯性 + 条件新颖性）。
 *
 * 两道判据（均为**确定性**实现，不依赖模型自评）：
 *
 *  1) 前缀连贯性 prefix coherence
 *     每个单元的前置（depends_on 的上游）必须排在学习路径的**前缀**里。
 *     同时检查层级单调：前置单元的 cognitiveLevel 不得高于后继单元。
 *     违反 → 记为 violation（循环依赖会让整条链无法排，同样记为 violation）。
 *
 *  2) 条件新颖性 conditional novelty
 *     相对已接受前缀，必须带来至少一个新增：新概念 / 新关系 / 新的条件化信息。
 *     判定：标题归一化重复、或摘要与某个更早单元高度相似（Jaccard ≥ 0.85）→ 新颖性为 0，
 *     合并进更早的那个单元（**不丢弃**），并记录原因。
 *
 * 只做判定与排序，不修改节点数据；调用方据此做合并与统计。
 */

import { normalizeTitle } from './merge'

export interface GateNode {
  readonly id: string
  readonly title: string
  readonly titleNorm?: string
  readonly summary: string
  readonly cognitiveLevel: number
  readonly priorKnowledge: readonly string[]
}

export interface GateEdge {
  readonly sourceId: string
  readonly targetId: string
  readonly relationType: string
}

export interface GateViolation {
  readonly kind: 'prefix' | 'level' | 'cycle'
  readonly nodeId: string
  readonly detail: string
}

export interface GateResult {
  /** 学习路径顺序（层级 → 拓扑深度 → 标题），只含接受的单元。 */
  readonly order: readonly string[]
  readonly violations: readonly GateViolation[]
  /** 因新颖性为 0 被合并的单元 → 合并进哪个单元。 */
  readonly mergedByNovelty: ReadonlyMap<string, string>
  readonly accepted: readonly string[]
}

const NOVELTY_SIMILARITY_THRESHOLD = 0.85

/** 只有这些关系表达「学习先后」，参与前缀连贯与层级单调；belongs_to 是分类，不约束顺序。 */
const ORDER_RELATIONS = new Set(['depends_on', 'extends', 'implements', 'triggers'])

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,.;:!?()[\]{}"'“”‘’、，。；：！？（）【】《》/\\|-]+/)
      .filter((token) => token.length > 0),
  )
}

export function jaccard(a: string, b: string): number {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

/**
 * 计算学习路径顺序并做两道闸门判定。
 *
 * @param nodes 可见单元（通常是同一视图里的节点）
 * @param edges 它们之间的关系
 */
export function gateUnits(nodes: readonly GateNode[], edges: readonly GateEdge[]): GateResult {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const keyOf = (node: GateNode): string => node.titleNorm ?? normalizeTitle(node.title)

  const outgoing = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const node of nodes) {
    outgoing.set(node.id, [])
    indegree.set(node.id, 0)
  }
  const seenPairs = new Set<string>()
  for (const edge of edges) {
    if (!byId.has(edge.sourceId) || !byId.has(edge.targetId)) continue
    if (edge.sourceId === edge.targetId) continue
    if (!ORDER_RELATIONS.has(edge.relationType)) continue
    const pair = `${edge.sourceId}->${edge.targetId}`
    if (seenPairs.has(pair)) continue
    seenPairs.add(pair)
    outgoing.get(edge.sourceId)?.push(edge.targetId)
    indegree.set(edge.targetId, (indegree.get(edge.targetId) ?? 0) + 1)
  }

  const violations: GateViolation[] = []

  // 拓扑序 + 贪心：每一步都在「当前就绪（前置已满足）」的节点里取认知层级最低的。
  // 这保证依赖一定在前，同时尽量先学简单的（SCoP 层级）。
  const ready = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
  const pending = new Map(indegree)
  const order: string[] = []
  const position = new Map<string, number>()
  while (ready.length > 0) {
    let bestIndex = 0
    for (let index = 1; index < ready.length; index += 1) {
      const candidate = byId.get(ready[index]!)
      const best = byId.get(ready[bestIndex]!)
      if (candidate === undefined) continue
      if (best === undefined) { bestIndex = index; continue }
      if (
        candidate.cognitiveLevel < best.cognitiveLevel ||
        (candidate.cognitiveLevel === best.cognitiveLevel && candidate.title.localeCompare(best.title) < 0)
      ) {
        bestIndex = index
      }
    }
    const id = ready.splice(bestIndex, 1)[0]!
    position.set(id, order.length)
    order.push(id)
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (pending.get(next) ?? 0) - 1
      pending.set(next, remaining)
      if (remaining === 0) ready.push(next)
    }
  }

  const cyclic = nodes.filter((node) => !position.has(node.id))
  for (const node of cyclic) {
    violations.push({
      kind: 'cycle',
      nodeId: node.id,
      detail: '处在循环依赖里，无法确定学习顺序',
    })
  }

  // 1) 前缀连贯：每条边 source 必须排在 target 之前；2) 层级单调
  for (const edge of edges) {
    if (!ORDER_RELATIONS.has(edge.relationType)) continue
    const source = byId.get(edge.sourceId)
    const target = byId.get(edge.targetId)
    if (source === undefined || target === undefined || source.id === target.id) continue
    const sourcePos = position.get(source.id)
    const targetPos = position.get(target.id)
    if (sourcePos === undefined || targetPos === undefined) continue
    if (sourcePos > targetPos) {
      violations.push({
        kind: 'prefix',
        nodeId: target.id,
        detail: `前置「${source.title}」排在了它后面`,
      })
    }
    if (source.cognitiveLevel > target.cognitiveLevel) {
      violations.push({
        kind: 'level',
        nodeId: target.id,
        detail: `前置「${source.title}」层级 ${source.cognitiveLevel} 高于本单元 ${target.cognitiveLevel}`,
      })
    }
  }

  // 3) 条件新颖性：摘要高度相似或标题重复 → 合并进更早的单元
  const mergedByNovelty = new Map<string, string>()
  const accepted: string[] = []
  const acceptedKeys = new Map<string, string>()
  for (const id of order) {
    const node = byId.get(id)
    if (node === undefined) continue
    const key = keyOf(node)
    const earlierId = acceptedKeys.get(key)
    if (earlierId !== undefined) {
      mergedByNovelty.set(id, earlierId)
      continue
    }
    let duplicateOf: string | null = null
    for (const earlier of accepted) {
      const other = byId.get(earlier)
      if (other === undefined) continue
      if (node.summary !== '' && other.summary !== '' && jaccard(node.summary, other.summary) >= NOVELTY_SIMILARITY_THRESHOLD) {
        duplicateOf = earlier
        break
      }
    }
    if (duplicateOf !== null) {
      mergedByNovelty.set(id, duplicateOf)
      continue
    }
    acceptedKeys.set(key, id)
    accepted.push(id)
  }

  return { order, violations, mergedByNovelty, accepted }
}
