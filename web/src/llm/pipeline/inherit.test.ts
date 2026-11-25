import { describe, expect, it } from 'vitest'

import { inheritUnderstandingFields } from './inherit'

import type { KnowledgeNode } from '../../domain'

function node(partial: Partial<KnowledgeNode> & { id: string; titleNorm: string }): KnowledgeNode {
  return {
    documentId: 'doc',
    parentId: null,
    chapterId: null,
    scope: 'global',
    title: partial.titleNorm,
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
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

const elaboration = { analogy: '像地图', contrast: '不是目录', why: '先看结构', misconception: '不是背诵' }

describe('inheritUnderstandingFields · 图表节点', () => {
  it('全局图表节点从同名章节节点继承 figure（否则全局图里跳不动）', () => {
    const figure = {
      kind: 'caption_only' as const,
      label: 'Figure 1',
      caption: 'Figure 1: 主界面三栏布局示意',
      page: 6,
      rects: [],
    }
    const globals = [node({ id: 'g1', titleNorm: 'figure1', title: 'Figure 1' })]
    const chapters = [node({ id: 'c1', titleNorm: 'figure1', scope: 'chapter', figure })]
    const [result] = inheritUnderstandingFields(globals, chapters)
    expect(result?.figure).toEqual(figure)
  })

  it('全局节点已有 figure 时不覆盖', () => {
    const own = { kind: 'caption_only' as const, label: 'Table 2', caption: 'Table 2: 参数', page: 4, rects: [] }
    const globals = [node({ id: 'g1', titleNorm: 'table2', title: 'Table 2', figure: own })]
    const chapters = [
      node({
        id: 'c1',
        titleNorm: 'table2',
        scope: 'chapter',
        figure: { ...own, caption: 'Table 2: 旧 caption' },
      }),
    ]
    const [result] = inheritUnderstandingFields(globals, chapters)
    expect(result?.figure).toEqual(own)
  })
})

describe('inheritUnderstandingFields', () => {
  it('全局节点缺精细加工时从同名章节节点继承', () => {
    const globals = [node({ id: 'g1', titleNorm: 'attention' })]
    const chapters = [node({ id: 'c1', titleNorm: 'attention', scope: 'chapter', elaboration })]
    const [result] = inheritUnderstandingFields(globals, chapters)
    expect(result?.elaboration).toEqual(elaboration)
  })

  it('全局节点已有内容时不覆盖', () => {
    const own = { analogy: '自己的', contrast: '', why: '', misconception: '' }
    const globals = [node({ id: 'g1', titleNorm: 'attention', elaboration: own })]
    const chapters = [node({ id: 'c1', titleNorm: 'attention', scope: 'chapter', elaboration })]
    const [result] = inheritUnderstandingFields(globals, chapters)
    expect(result?.elaboration).toEqual(own)
  })

  it('先修知识为空时继承', () => {
    const globals = [node({ id: 'g1', titleNorm: 'attention' })]
    const chapters = [node({ id: 'c1', titleNorm: 'attention', scope: 'chapter', priorKnowledge: ['softmax'] })]
    const [result] = inheritUnderstandingFields(globals, chapters)
    expect(result?.priorKnowledge).toEqual(['softmax'])
  })

  it('找不到同名章节节点时原样返回', () => {
    const globals = [node({ id: 'g1', titleNorm: 'unknown' })]
    const [result] = inheritUnderstandingFields(globals, [])
    expect(result?.elaboration).toBeNull()
  })
})
