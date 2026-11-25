import { describe, expect, it } from 'vitest'

import { collectConcepts, computeChapterProgress } from './chapterProgress'

import type { KnowledgeNode, OutlineNode } from '../domain'

const outline = (): OutlineNode[] => [
  chapter('c1', null, 1, 2, '1 这是什么'),
  chapter('c1-1', 'c1', 0, 3, '1.1 三个问题'),
  chapter('c1-2', 'c1', 1, 5, '1.2 不做什么'),
  chapter('c2', null, 2, 8, '2 安装'),
  // 没有页码的章节：应继承子章节的起始页
  chapter('c2-1', 'c2', 0, null, '2.1 环境'),
  chapter('c2-1-1', 'c2-1', 0, 9, '2.1.1 Node'),
]

function chapter(
  id: string,
  parentId: string | null,
  order: number,
  page: number | null,
  title: string,
): OutlineNode {
  return {
    id,
    documentId: 'doc',
    parentId,
    order,
    level: parentId === null ? 1 : 2,
    title,
    page,
    predictedImportance: null,
    importanceSource: 'none',
    graphBuilt: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function node(id: string, page: number | null, mastery: 'mastered' | 'unmastered', chapterId: string | null = null): KnowledgeNode {
  return {
    id,
    documentId: 'doc',
    parentId: null,
    chapterId,
    scope: chapterId === null ? 'global' : 'chapter',
    title: id,
    titleNorm: id,
    aliases: [],
    summary: '',
    difficulty: 3,
    importance: 3,
    importanceSource: 'llm',
    cognitiveLevel: 1,
    unitKind: 'concept',
    priorKnowledge: [],
    elaboration: null,
    selfCheck: '',
    mastery,
    anchor:
      page === null
        ? null
        : { page, quote: 'q', rects: [] },
    sourceChunkId: null,
    figure: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('computeChapterProgress', () => {
  it('没有知识点时所有章节都是 none（灰色空心圈）', () => {
    const progress = computeChapterProgress(outline(), [])
    expect([...progress.values()].every((item) => item.state === 'none' && item.total === 0)).toBe(true)
  })

  it('按锚点页码归到「当前章」（起始页最大、层级最深）', () => {
    const progress = computeChapterProgress(outline(), [
      node('a', 3, 'unmastered'), // 1.1 起始页 3
      node('b', 6, 'unmastered'), // 1.2 起始页 5
      node('c', 10, 'unmastered'), // 2.1.1 起始页 9（父章节继承 9）
    ])
    expect(progress.get('c1-1')).toEqual({ state: 'none', total: 1, mastered: 0 })
    expect(progress.get('c1-2')).toEqual({ state: 'none', total: 1, mastered: 0 })
    expect(progress.get('c2-1-1')).toEqual({ state: 'none', total: 1, mastered: 0 })
    // 父章节拿到整棵子树的合计
    expect(progress.get('c1')).toEqual({ state: 'none', total: 2, mastered: 0 })
    expect(progress.get('c2-1')).toEqual({ state: 'none', total: 1, mastered: 0 })
    expect(progress.get('c2')).toEqual({ state: 'none', total: 1, mastered: 0 })
  })

  it('部分掌握 → partial；全掌握 → complete', () => {
    const progress = computeChapterProgress(outline(), [
      node('a', 3, 'mastered'),
      node('b', 6, 'unmastered'),
      node('c', 9, 'mastered'),
      node('d', 10, 'mastered'),
    ])
    expect(progress.get('c1')).toMatchObject({ state: 'partial', total: 2, mastered: 1 })
    expect(progress.get('c1-1')).toMatchObject({ state: 'complete', total: 1, mastered: 1 })
    expect(progress.get('c2-1-1')).toMatchObject({ state: 'complete', total: 2, mastered: 2 })
    expect(progress.get('c2')).toMatchObject({ state: 'complete', total: 2, mastered: 2 })
  })

  it('章节子图节点按 chapterId 归属，不重复计数', () => {
    const progress = computeChapterProgress(outline(), [
      node('a', 3, 'mastered', 'c1'),
      node('b', 4, 'mastered', 'c1'),
    ])
    expect(progress.get('c1')).toMatchObject({ state: 'complete', total: 2, mastered: 2 })
    // 不会因为页码落在 1.1 再算一次
    expect(progress.get('c1-1')).toMatchObject({ total: 0 })
  })

  it('第一章之前（如标题页）的节点不计入任何章节', () => {
    const progress = computeChapterProgress(outline(), [node('title-page', 1, 'mastered')])
    expect([...progress.values()].every((item) => item.total === 0)).toBe(true)
  })

  it('没有页码且没有 chapterId 的节点不计入', () => {
    const progress = computeChapterProgress(outline(), [node('orphan', null, 'mastered')])
    expect([...progress.values()].every((item) => item.total === 0)).toBe(true)
  })
})

describe('collectConcepts', () => {
  const withNorm = (base: KnowledgeNode, scope: 'global' | 'chapter', titleNorm: string, parentId: string | null): KnowledgeNode => ({
    ...base,
    scope,
    titleNorm,
    parentId,
  })

  it('同一 titleNorm 的全局节点与章节细化节点折成 1 个概念', () => {
    const concepts = collectConcepts([
      withNorm(node('g1', 3, 'unmastered'), 'global', 'attention', null),
      withNorm(node('c1-a', 3, 'unmastered', 'c1'), 'chapter', 'attention', 'g1'),
      withNorm(node('c1-b', 4, 'unmastered', 'c1'), 'chapter', 'attention', 'g1'),
    ])
    expect(concepts).toHaveLength(1)
  })

  it('任一记录已掌握 ⇒ 概念已掌握（① ② 两个视图里学都算）', () => {
    const concepts = collectConcepts([
      withNorm(node('g1', 3, 'unmastered'), 'global', 'attention', null),
      withNorm(node('c1-a', 3, 'mastered', 'c1'), 'chapter', 'attention', 'g1'),
    ])
    expect(concepts[0]?.mastered).toBe(true)
  })

  it('不同 titleNorm 是不同概念；章节归属取章节记录的 chapterId', () => {
    const concepts = collectConcepts([
      withNorm(node('g1', 3, 'unmastered'), 'global', 'a', null),
      withNorm(node('c1-x', 6, 'mastered', 'c1'), 'chapter', 'b', 'g1'),
    ])
    expect(concepts).toHaveLength(2)
    const chapterConcept = concepts.find((item) => item.key === 'b')
    expect(chapterConcept).toMatchObject({ chapterId: 'c1', page: 6, mastered: true })
    expect(concepts.find((item) => item.key === 'a')?.chapterId).toBe(null)
  })
})
