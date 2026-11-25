/**
 * 全局节点继承「理解性字段」。
 *
 * reduce 阶段只看到标题与摘要，写不出类比/例子（也不该让它只看标题就编）。
 * 而 chunk 阶段读的是原文、能写出这些，所以把同名章节节点上的
 * `elaboration` / `priorKnowledge` 补到全局节点上（不覆盖已有值）。
 */

import type { Elaboration, KnowledgeNode } from '../../domain'

export function inheritUnderstandingFields(
  globals: readonly KnowledgeNode[],
  chapters: readonly KnowledgeNode[],
): KnowledgeNode[] {
  const byNorm = new Map<string, KnowledgeNode[]>()
  for (const node of chapters) {
    const bucket = byNorm.get(node.titleNorm) ?? []
    bucket.push(node)
    byNorm.set(node.titleNorm, bucket)
  }

  return globals.map((node) => {
    const candidates = byNorm.get(node.titleNorm) ?? []
    const source = candidates.find((candidate) => candidate.elaboration !== null) ?? candidates[0]
    if (source === undefined) return node
    const elaboration: Elaboration | null = node.elaboration ?? source.elaboration
    // 图表占位节点的 caption/页码只有 chunk 阶段看得见；reduce 常常只回标题。
    // 不把 figure 继承过来的话，全局图里这类节点就既没有 figure 也画不出下划线（跳不动）。
    // 注意不能只看 source：同名候选里可能先挑到「有精细加工但没有 figure」的那个。
    const figure = node.figure ?? candidates.find((candidate) => candidate.figure !== null)?.figure ?? null
    const selfCheck = node.selfCheck !== '' ? node.selfCheck : source.selfCheck
    const priorKnowledge =
      node.priorKnowledge.length > 0 ? node.priorKnowledge : source.priorKnowledge
    if (
      elaboration === node.elaboration &&
      priorKnowledge === node.priorKnowledge &&
      selfCheck === node.selfCheck &&
      figure === node.figure
    ) {
      return node
    }
    return { ...node, elaboration, priorKnowledge, selfCheck, figure }
  })
}
