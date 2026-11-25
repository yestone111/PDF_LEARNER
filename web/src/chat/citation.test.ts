import { describe, expect, it } from 'vitest'

import { extractCitations, parseCitations, verifyCitation } from './citation'

const pages = [
  { page: 3, text: 'The Transformer follows this architecture using stacked self-attention and point-wise layers.' },
  { page: 6, text: 'A self-attention layer connects all positions with a constant number of sequential operations.' },
]

describe('parseCitations', () => {
  it('解析「[引用] 第N页：「…」」格式', () => {
    const parsed = parseCitations('正文。\n\n[引用] 第6页：「A self-attention layer connects all positions」')
    expect(parsed).toEqual([{ page: 6, quote: 'A self-attention layer connects all positions' }])
  })

  it('支持多种引号与冒号', () => {
    const parsed = parseCitations('[引用] 第 3 页: “stacked self-attention”')
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.page).toBe(3)
  })

  it('没有引注时返回空数组', () => {
    expect(parseCitations('这是一段没有引注的回答。')).toHaveLength(0)
  })
})

describe('verifyCitation（不信任模型给的页码）', () => {
  it('原文能对上的引注 → verified=true，且用真实页码', () => {
    const citation = verifyCitation({ page: 99, quote: 'stacked self-attention' }, pages)
    expect(citation.verified).toBe(true)
    expect(citation.page).toBe(3)
  })

  it('页码写错但原文存在 → 用真实页码（不沿用错误页码）', () => {
    const citation = verifyCitation({ page: 6, quote: 'Transformer follows this architecture' }, pages)
    expect(citation.verified).toBe(true)
    expect(citation.page).toBe(3)
  })

  it('原文里根本没有 → verified=false 且 page=null（不编造页码）', () => {
    const citation = verifyCitation({ page: 6, quote: '这句话在原文中不存在' }, pages)
    expect(citation.verified).toBe(false)
    expect(citation.page).toBeNull()
  })

  it('空白差异不影响校验', () => {
    const citation = verifyCitation({ page: 6, quote: 'connects all positions   with a constant' }, pages)
    expect(citation.verified).toBe(true)
  })
})

describe('extractCitations', () => {
  it('模型没给引注 → 生成一条「无直接出处」条目（不为空数组）', () => {
    const citations = extractCitations('我不知道。', pages)
    expect(citations).toHaveLength(1)
    expect(citations[0]?.verified).toBe(false)
    expect(citations[0]?.page).toBeNull()
  })

  it('全部引注都核对失败时，也返回可渲染的条目而不是空', () => {
    const citations = extractCitations('[引用] 第3页：「完全不存在的句子」', pages)
    expect(citations).toHaveLength(1)
    expect(citations[0]?.verified).toBe(false)
  })

  it('部分成立时保留成立的条目', () => {
    const answer = ['[引用] 第3页：「stacked self-attention」', '[引用] 第6页：「不存在的内容」'].join('\n')
    const citations = extractCitations(answer, pages)
    expect(citations).toHaveLength(2)
    expect(citations.filter((citation) => citation.verified)).toHaveLength(1)
  })
})

describe('康熙部首码位兼容', () => {
  it('引文用正常汉字也能在部首码位文本里通过核对', () => {
    const oddPages = [{ page: 2, text: '注意⼒机制是核⼼。' }]
    const citation = verifyCitation({ page: 2, quote: '注意力机制' }, oddPages)
    expect(citation.verified).toBe(true)
  })
})
