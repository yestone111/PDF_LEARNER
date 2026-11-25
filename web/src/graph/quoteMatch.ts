/**
 * 高亮 → 知识节点的匹配（模块三：点击已有高亮 → 关联节点闪烁定位）。
 *
 * 匹配策略：把两边文本归一（去空白/标点/大小写）后做「互相包含」判断，且要求较短一方 ≥ 12 字符。
 * 这是启发式，所以 UI 必须说明「按原文匹配」；匹配不到时给出明确空态，绝不乱闪。
 */

import type { KnowledgeNode } from '../domain'

export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\p{S}]/gu, '')
}

const MIN_OVERLAP = 12

export function findNodeByText(
  nodes: readonly KnowledgeNode[],
  text: string,
): KnowledgeNode | null {
  const target = normalizeForMatch(text)
  if (target.length < MIN_OVERLAP) return null

  let best: KnowledgeNode | null = null
  let bestLength = 0

  for (const node of nodes) {
    const candidates = [node.title, node.anchor?.quote ?? '', ...node.aliases]
    for (const candidate of candidates) {
      const normalized = normalizeForMatch(candidate)
      if (normalized.length < MIN_OVERLAP) continue
      const overlaps = target.includes(normalized) || normalized.includes(target)
      if (overlaps && normalized.length > bestLength) {
        best = node
        bestLength = normalized.length
      }
    }
  }

  return best
}
