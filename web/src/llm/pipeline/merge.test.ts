import { describe, expect, it } from 'vitest'

import { mergeNodeDrafts, normalizeTitle, splitParenthetical } from './merge'

import type { LlmNodeDraft } from '../../domain/types'

function draft(partial: Partial<LlmNodeDraft> & { title: string }): LlmNodeDraft {
  return {
    aliases: [],
    summary: '',
    importance: 3,
    quote: '',
    page: null,
    parentTitle: null,
    figure: null,
    isChapterRoot: false,
    ...partial,
  }
}

describe('normalizeTitle', () => {
  it('大小写、空格、标点、全角都被归一', () => {
    expect(normalizeTitle('Multi-Head  Attention')).toBe('multiheadattention')
    expect(normalizeTitle('Ｍｕｌｔｉ－Ｈｅａｄ Attention')).toBe('multiheadattention')
  })

  it('不做语义后缀剥离（避免误合）', () => {
    expect(normalizeTitle('Transformer')).not.toBe(normalizeTitle('Transformer 模型'))
  })
})

describe('splitParenthetical', () => {
  it('括号补充变成别名', () => {
    const result = splitParenthetical('Multi-Head Attention (MHA)')
    expect(result.title).toBe('Multi-Head Attention')
    expect(result.aliases).toEqual(['MHA'])
  })

  it('没有括号时原样返回', () => {
    expect(splitParenthetical('Positional Encoding')).toEqual({
      title: 'Positional Encoding',
      aliases: [],
    })
  })
})

describe('mergeNodeDrafts', () => {
  it('同名节点合并：重要度取最大、别名并集、摘要取最长', () => {
    const merged = mergeNodeDrafts({
      entries: [
        { draft: draft({ title: 'Attention', importance: 3, summary: '短' }), chunkId: 'c1' },
        { draft: draft({ title: 'attention', importance: 5, summary: '更长的摘要内容' }), chunkId: 'c2' },
      ],
    })
    expect(merged).toHaveLength(1)
    expect(merged[0].importance).toBe(5)
    expect(merged[0].summary).toBe('更长的摘要内容')
    expect(merged[0].chunkId).toBe('c1')
  })

  it('不同标题不合并（不做模糊猜测）', () => {
    const merged = mergeNodeDrafts({
      entries: [
        { draft: draft({ title: 'Attention' }), chunkId: null },
        { draft: draft({ title: 'Self-Attention' }), chunkId: null },
      ],
    })
    expect(merged).toHaveLength(2)
  })

  it('LLM 的 merges 声明可以合并别名，并采用 canonical 标题', () => {
    const merged = mergeNodeDrafts({
      entries: [
        { draft: draft({ title: 'Transformer 模型', importance: 4 }), chunkId: null },
        { draft: draft({ title: 'Transformer', importance: 5 }), chunkId: null },
      ],
      merges: [{ canonical: 'Transformer', aliases: ['Transformer 模型'] }],
    })
    expect(merged).toHaveLength(1)
    expect(merged[0].title).toBe('Transformer')
    expect(merged[0].importance).toBe(5)
    expect(merged[0].aliases).toContain('Transformer 模型')
  })

  it('空标题不会生成节点', () => {
    const merged = mergeNodeDrafts({ entries: [{ draft: draft({ title: '   ' }), chunkId: null }] })
    expect(merged).toHaveLength(0)
  })

  it('quote 为空时不带页码污染；有 quote 时取该条目的页码', () => {
    const merged = mergeNodeDrafts({
      entries: [
        { draft: draft({ title: 'X', quote: '', page: 9 }), chunkId: null },
        { draft: draft({ title: 'X', quote: 'real quote', page: 4 }), chunkId: null },
      ],
    })
    expect(merged[0].quote).toBe('real quote')
    expect(merged[0].page).toBe(4)
  })

  it('figure 取第一个非空值，并补齐 rects 为空数组', () => {
    const merged = mergeNodeDrafts({
      entries: [
        {
          draft: draft({
            title: 'Attention Is All You Need',
            figure: { label: 'Figure 1', caption: 'The Transformer', page: 3, kind: 'caption_only' },
          }),
          chunkId: null,
        },
      ],
    })
    expect(merged[0].figure?.label).toBe('Figure 1')
    expect(merged[0].figure?.rects).toEqual([])
  })
})
