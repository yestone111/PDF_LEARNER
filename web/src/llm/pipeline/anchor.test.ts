import { describe, expect, it } from 'vitest'

import { locateQuote } from './anchor'

const pages = [
  { page: 3, text: 'The Transformer follows this overall architecture using stacked self-attention.' },
  { page: 4, text: 'Scaled dot-product attention  computes  the  dot  products of the query with all keys.' },
]

describe('locateQuote（三级降级）', () => {
  it('① 原文精确匹配', () => {
    const anchor = locateQuote('stacked self-attention', 3, pages)
    expect(anchor).toEqual({ page: 3, quote: 'stacked self-attention', rects: [] })
  })

  it('② 空白折叠后匹配', () => {
    const anchor = locateQuote('Scaled dot-product attention computes the dot products', 4, pages)
    expect(anchor?.page).toBe(4)
  })

  it('③ 大小写不敏感匹配', () => {
    const anchor = locateQuote('SCALED DOT-PRODUCT ATTENTION', 4, pages)
    expect(anchor?.page).toBe(4)
  })

  it('优先在提示页找（即便别处也命中）', () => {
    const anchor = locateQuote('attention', 4, pages)
    expect(anchor?.page).toBe(4)
  })

  it('三级都失败 → null（绝不返回「最相近」的假锚点）', () => {
    expect(locateQuote('这句话原文里根本没有出现过', 3, pages)).toBeNull()
  })

  it('空 quote → null', () => {
    expect(locateQuote('   ', 3, pages)).toBeNull()
  })

  it('没有页码提示时全文档搜索', () => {
    const anchor = locateQuote('overall architecture', null, pages)
    expect(anchor?.page).toBe(3)
  })
})

describe('康熙部首码位（Chrome 打印的 PDF）', () => {
  const odd = [{ page: 2, text: '注意⼒机制是核⼼。' }]

  it('用正常汉字 quote 能在部首码位文本里定位', () => {
    const anchor = locateQuote('注意力机制', 2, odd)
    expect(anchor).not.toBeNull()
    expect(anchor?.page).toBe(2)
  })
})
