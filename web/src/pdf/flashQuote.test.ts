import { describe, expect, it } from 'vitest'

import { MIN_QUOTE_WEIGHT, isSearchableQuote, normalizeForFlash, quoteWeight } from './flashQuote'

describe('normalizeForFlash（跳转高亮的匹配归一）', () => {
  it('去掉空白并转小写', () => {
    expect(normalizeForFlash('Multi-Head  Attention')).toBe('multi-headattention')
  })

  it('康熙部首折回常规汉字（中文 PDF 常见）', () => {
    // ⽬（U+2F6C）→ 目，录本身就是常规汉字
    expect(normalizeForFlash('⽬录')).toBe('目录')
  })

  it('全角/兼容字符也会被 NFKC 归一', () => {
    expect(normalizeForFlash('ＡＴＴＥＮＴＩＯＮ')).toBe('attention')
  })

  it('中文引文去空白；全角标点被 NFKC 折成半角（两边一致，不影响匹配）', () => {
    expect(normalizeForFlash('把查询和键做点积，\n再加权求和')).toBe('把查询和键做点积,再加权求和')
  })
})

describe('quoteWeight / isSearchableQuote（引文可搜索性）', () => {
  it('汉字按 2 计，拉丁/数字按 1 计', () => {
    expect(quoteWeight('零拷贝卸载')).toBe(10)
    expect(quoteWeight('attention')).toBe(9)
    expect(quoteWeight('三栏布局')).toBe(8)
  })

  it('5 个汉字的中文术语足够可搜索（之前被 length<6 误杀的真实案例）', () => {
    expect(isSearchableQuote('零拷贝卸载')).toBe(true)
    expect(isSearchableQuote('零拷贝')).toBe(true) // 4 字 = 8
    expect(isSearchableQuote('布局')).toBe(false) // 2 字 = 4
  })

  it('纯拉丁仍要求 6 个字符，避免到处命中', () => {
    expect(isSearchableQuote('hello')).toBe(false)
    expect(isSearchableQuote('hello!')).toBe(true)
    expect(isSearchableQuote('attention')).toBe(true)
  })

  it('空白与大小写不影响判定（归一后再算权重）', () => {
    expect(quoteWeight('Multi  Head')).toBe(quoteWeight('multihead'))
  })

  it('阈值常量保持不变（改它要同时加回归用例）', () => {
    expect(MIN_QUOTE_WEIGHT).toBe(6)
  })
})
