import { describe, expect, it } from 'vitest'

import { normalizeForFlash } from './flashQuote'

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
