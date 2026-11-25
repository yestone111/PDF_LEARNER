import { describe, expect, it } from 'vitest'

import { annotateSummary } from './summaryKeywords'

const nodes = [
  { id: 'n1', title: 'Multi-Head Attention', aliases: ['多头注意力'] },
  { id: 'n2', title: 'Positional Encoding', aliases: [] },
]

function joined(segments: ReturnType<typeof annotateSummary>): string {
  return segments.map((segment) => segment.text).join('')
}

describe('annotateSummary（速览关键词联动）', () => {
  it('命中标题时切成关键词段，且能拼回原文', () => {
    const summary = '本章先讲 Multi-Head Attention，再讲 Positional Encoding。'
    const segments = annotateSummary(summary, nodes)
    expect(joined(segments)).toBe(summary)
    const keywords = segments.filter((segment) => segment.nodeId !== null)
    expect(keywords.map((segment) => segment.nodeId)).toEqual(['n1', 'n2'])
  })

  it('别名也能命中', () => {
    const segments = annotateSummary('这里说的多头注意力其实是一个别名。', nodes)
    expect(segments.some((segment) => segment.nodeId === 'n1')).toBe(true)
  })

  it('大小写与全角差异不影响命中', () => {
    const segments = annotateSummary('先看 MULTI-HEAD ATTENTION 这一节。', nodes)
    expect(segments.some((segment) => segment.nodeId === 'n1')).toBe(true)
  })

  it('重叠时取更长的关键词（标题优先于短别名）', () => {
    const overlapping = [
      { id: 'long', title: 'Multi-Head Attention', aliases: [] },
      { id: 'short', title: 'Attention', aliases: [] },
    ]
    const segments = annotateSummary('Multi-Head Attention 是关键。', overlapping)
    const keywords = segments.filter((segment) => segment.nodeId !== null)
    expect(keywords).toHaveLength(1)
    expect(keywords[0]!.nodeId).toBe('long')
  })

  it('没有命中时返回整段普通文本', () => {
    const segments = annotateSummary('这段没有任何知识点名称。', nodes)
    expect(segments).toEqual([{ text: '这段没有任何知识点名称。', nodeId: null }])
  })

  it('忽略单字关键词，避免误命中', () => {
    const segments = annotateSummary('注意力很重要。', [{ id: 'x', title: '力', aliases: [] }])
    expect(segments.every((segment) => segment.nodeId === null)).toBe(true)
  })
})
