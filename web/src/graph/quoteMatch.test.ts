import { describe, expect, it } from 'vitest'

import { findNodeByText, normalizeForMatch } from './quoteMatch'

import type { KnowledgeNode } from '../domain'

function node(partial: Partial<KnowledgeNode> & { id: string; title: string }): KnowledgeNode {
  return {
    documentId: 'doc-1',
    parentId: null,
    chapterId: null,
    scope: 'global',
    titleNorm: partial.title.toLowerCase(),
    aliases: [],
    summary: '',
    difficulty: 3,
    cognitiveLevel: 1,
    unitKind: 'concept',
    priorKnowledge: [],
    elaboration: null,
    selfCheck: '',
    importance: 3,
    importanceSource: 'llm',
    mastery: 'unmastered',
    anchor: null,
    sourceChunkId: null,
    figure: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

const nodes: KnowledgeNode[] = [
  node({
    id: 'n1',
    title: 'Scaled Dot-Product Attention',
    anchor: { page: 4, quote: 'scaled dot-product attention', rects: [] },
  }),
  node({
    id: 'n2',
    title: 'Multi-Head Attention',
    anchor: { page: 5, quote: 'multi-head attention allows the model', rects: [] },
  }),
]

describe('normalizeForMatch', () => {
  it('去掉标点、空白、大小写差异', () => {
    expect(normalizeForMatch('Scaled Dot-Product  Attention!')).toBe('scaleddotproductattention')
  })
})

describe('findNodeByText', () => {
  it('高亮文本包含节点 quote → 命中对应节点', () => {
    const hit = findNodeByText(nodes, 'we call our particular attention "scaled dot-product attention" (Figure 2)')
    expect(hit?.id).toBe('n1')
  })

  it('节点 quote 包含高亮文本（更长的 quote）也能命中', () => {
    const hit = findNodeByText(nodes, 'multi-head attention allows the model to jointly')
    expect(hit?.id).toBe('n2')
  })

  it('重叠部分太短（<12 字符）不命中，避免乱闪', () => {
    expect(findNodeByText(nodes, 'attention')).toBeNull()
  })

  it('完全无关 → null（UI 给空态提示）', () => {
    expect(findNodeByText(nodes, 'training data and batching strategy')).toBeNull()
  })

  it('多个候选命中时取重叠更长者', () => {
    const hit = findNodeByText(nodes, 'scaled dot-product attention scaled dot-product attention multi-head attention allows the model')
    expect(hit?.id).toBe('n2')
  })
})
