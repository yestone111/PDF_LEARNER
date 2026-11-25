import { describe, expect, it } from 'vitest'

import { buildChunks, estimateTokens, repairSplitAttention } from './chunking'

import type { ChunkDraft } from './chunking'

import type { PageText } from './chunking'
import type { OutlineNode } from '../../domain/types'

const T0 = 1_700_000_000_000

function outlineNode(partial: Partial<OutlineNode> & { id: string; title: string; page: number }): OutlineNode {
  return {
    documentId: 'doc-1',
    parentId: null,
    order: 0,
    level: 1,
    predictedImportance: null,
    importanceSource: 'none',
    graphBuilt: false,
    createdAt: T0,
    updatedAt: T0,
    ...partial,
  }
}

const outline: OutlineNode[] = [
  outlineNode({ id: 'ch1', title: 'Intro', page: 1 }),
  outlineNode({ id: 'ch2', title: 'Model', page: 3 }),
  outlineNode({ id: 'ch2-1', title: 'Attention', page: 3, level: 2, parentId: 'ch2' }),
  outlineNode({ id: 'ch3', title: 'Training', page: 6 }),
]

function page(pageNumber: number, words: number): PageText {
  return { page: pageNumber, text: Array.from({ length: words }, (_, i) => `word${i}`).join(' ') }
}

describe('repairSplitAttention（分割注意修复）', () => {
  const chunk = (text: string, overrides: Partial<ChunkDraft> = {}): ChunkDraft => ({
    outlineNodeId: 'ch1',
    pageStart: 1,
    pageEnd: 1,
    order: 0,
    ...overrides,
    // 文本与派生字段以本次传入为准，避免被 overrides 覆盖
    text,
    charCount: text.length,
    tokenEstimate: estimateTokens(text),
  })

  it('块尾是「例如」引导语 → 与下一块合并', () => {
    const chunks = [chunk('注意力机制的定义如下：例如', { pageStart: 1, pageEnd: 1 }), chunk('比如查询和键做点积。', { pageStart: 1, pageEnd: 2, order: 1 })]
    const repaired = repairSplitAttention(chunks, 1400)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]?.text).toContain('比如查询和键做点积')
    expect(repaired[0]?.pageEnd).toBe(2)
  })

  it('下一块以图注开头且上一块提到该图 → 合并', () => {
    const chunks = [chunk('如图 3 所示，编码器由多层堆叠。', { pageStart: 3, pageEnd: 3 }), chunk('图 3：编码器结构示意。', { pageStart: 3, pageEnd: 4, order: 1 })]
    expect(repairSplitAttention(chunks, 1400)).toHaveLength(1)
  })

  it('普通边界不合并', () => {
    const chunks = [chunk('第一段讲注意力。', { pageStart: 1, pageEnd: 1 }), chunk('第二段讲位置编码。', { pageStart: 2, pageEnd: 2, order: 1 })]
    expect(repairSplitAttention(chunks, 1400)).toHaveLength(2)
  })

  it('跨章节不合并（保住章节子图的缓存对齐）', () => {
    const chunks = [
      chunk('第一章结尾：例如', { outlineNodeId: 'ch1', pageStart: 1, pageEnd: 1 }),
      chunk('第二章开头。', { outlineNodeId: 'ch2', pageStart: 2, pageEnd: 2, order: 1 }),
    ]
    expect(repairSplitAttention(chunks, 1400)).toHaveLength(2)
  })

  it('合并后超过预算 1.5 倍则不合并（块太大同样伤认知）', () => {
    const long = '例'.repeat(2000)
    const chunks = [chunk(`${long}例如`, { pageStart: 1, pageEnd: 1 }), chunk(long, { pageStart: 2, pageEnd: 2, order: 1 })]
    expect(repairSplitAttention(chunks, 1400)).toHaveLength(2)
  })
})

describe('estimateTokens', () => {
  it('英文约 4 字符/token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('中文按 1 字/token（宁可高估）', () => {
    expect(estimateTokens('注意力机制')).toBe(5)
  })

  it('空字符串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('buildChunks', () => {
  it('无页面时返回空数组', () => {
    expect(buildChunks([], outline)).toEqual([])
  })

  it('按章节边界对齐（每章一个块）', () => {
    const pages = [page(1, 40), page(2, 40), page(3, 40), page(4, 40), page(5, 40), page(6, 40), page(7, 40)]
    const chunks = buildChunks(pages, outline, 5000)
    // 1-2 → ch1，3-5 → ch2-1（更深层章节），6-7 → ch3
    expect(chunks.map((chunk) => chunk.outlineNodeId)).toEqual(['ch1', 'ch2-1', 'ch3'])
    expect(chunks.map((chunk) => [chunk.pageStart, chunk.pageEnd])).toEqual([
      [1, 2],
      [3, 5],
      [6, 7],
    ])
    expect(chunks.map((chunk) => chunk.order)).toEqual([0, 1, 2])
  })

  it('超长章节按页切成多块（不跨越章节）', () => {
    const pages = [page(3, 400), page(4, 400), page(5, 400)]
    const chunks = buildChunks(pages, outline, 150)
    expect(chunks.length).toBe(3)
    expect(chunks.every((chunk) => chunk.outlineNodeId === 'ch2-1')).toBe(true)
  })

  it('块文本是页面文本的拼接，tokenEstimate 与 charCount 一致可追溯', () => {
    const pages = [page(1, 10), page(2, 10)]
    const chunks = buildChunks(pages, outline, 5000)
    expect(chunks[0].charCount).toBe(chunks[0].text.length)
    expect(chunks[0].tokenEstimate).toBe(estimateTokens(chunks[0].text))
  })

  it('没有 outline 时全部归到 null 章节，仍然能切块', () => {
    const chunks = buildChunks([page(1, 20)], [], 5000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].outlineNodeId).toBeNull()
  })
})
