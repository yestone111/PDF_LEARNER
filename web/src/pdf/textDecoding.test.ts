import { describe, expect, it } from 'vitest'

import { countCjk, repairPdfText, toPdfBytes } from './textDecoding'

/** 把十六进制字节串转成「被按 Latin-1 解码」的样子。 */
function asLatin1(hex: string): string {
  const bytes = hex.match(/.{2}/g) ?? []
  return String.fromCharCode(...bytes.map((pair) => Number.parseInt(pair, 16)))
}

describe('repairPdfText', () => {
  it('UTF-8 字节被误解码 → 还原（Chrome/gs 生成的书签常见）', () => {
    // 「目录」的 UTF-8 是 E7 9B AE E5 BD 95
    expect(repairPdfText(asLatin1('E79BAEE5BD95'))).toBe('目录')
  })

  it('GBK 字节被误解码 → 还原（国产办公软件导出的 PDF 常见）', () => {
    // 「第一章」的 GBK 是 B5 DA D2 BB D5 C2
    expect(repairPdfText(asLatin1('B5DAD2BBD5C2'))).toBe('第一章')
  })

  it('GBK 字节落在 PDFDocEncoding 0x80–0x9F 特殊区也能还原', () => {
    // 「丂」的 GBK 是 81 40；0x81 会被解成 U+2020（†）
    expect(repairPdfText('\u2020@')).toBe('丂')
  })

  it('已经是正常中文 → 一字不改', () => {
    expect(repairPdfText('第五章 结论')).toBe('第五章 结论')
  })

  it('正常西文标题（含重音/标点）→ 不动', () => {
    expect(repairPdfText('Introduction')).toBe('Introduction')
    expect(repairPdfText('Café & Résumé')).toBe('Café & Résumé')
  })

  it('空字符串 / 只有空格 → 原样返回', () => {
    expect(repairPdfText('')).toBe('')
    expect(repairPdfText('   ')).toBe('   ')
  })

  it('无法还原的拉丁文本 → 保留原文（宁可不动也不改错）', () => {
    const weird = '\u00ff\u00fe\u00fd'
    expect(repairPdfText(weird)).toBe(weird)
  })

  it('去掉 UTF-16 BOM 前缀', () => {
    expect(repairPdfText('\uFEFF第一章')).toBe('第一章')
  })
})

describe('PDFDocEncoding 的 0xA0（欧元符号）位置', () => {
  /**
   * 精确模拟 pdf.js 的 stringToPDFString：把 UTF-8 字节按 PDFDocEncoding 解成字符串。
   * 只有这样才能真实复现「旧手册第 4/5 章乱码」——这两章标题里有「习」(E4 B9 A0)，
   * 而 PDFDocEncoding 把 0xA0 映射成 €，不是 Latin-1 的不换行空格。
   */
  const PDFDOC_80_TO_A0 = [
    0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044,
    0x2039, 0x203a, 0x2212, 0x2030, 0x201e, 0x201c, 0x201d, 0x2018,
    0x2019, 0x201a, 0x2122, 0xfb01, 0xfb02, 0x0141, 0x0152, 0x0160,
    0x0178, 0x017d, 0x0131, 0x0142, 0x0153, 0x0161, 0x017e, 0,
  ]

  function pdfDocDecode(byte: number): string {
    if (byte >= 0x80 && byte <= 0x9f) {
      const mapped = PDFDOC_80_TO_A0[byte - 0x80] ?? 0
      return String.fromCharCode(mapped === 0 ? byte : mapped)
    }
    if (byte === 0xa0) return '\u20ac'
    return String.fromCharCode(byte)
  }

  function asWrittenByBrokenGenerator(text: string): string {
    const bytes = [...new TextEncoder().encode(text)]
    return bytes.map((byte) => pdfDocDecode(byte)).join('')
  }

  it('「习」的 UTF-8 是 E4 B9 A0，被解成「ä¹€」，必须能还原', () => {
    expect(asWrittenByBrokenGenerator('习')).toBe('\u00e4\u00b9\u20ac')
    expect(repairPdfText('\u00e4\u00b9\u20ac')).toBe('习')
  })

  it('旧手册第 4 章标题（含「习」）能完整还原', () => {
    const broken = asWrittenByBrokenGenerator('4 第一次学习：五步走')
    expect(repairPdfText(broken)).toBe('4 第一次学习：五步走')
  })

  it('旧手册第 5 章标题（含「习」）能完整还原', () => {
    const broken = asWrittenByBrokenGenerator('5 学习对话框详解')
    expect(repairPdfText(broken)).toBe('5 学习对话框详解')
  })

  it('不含 0xA0 的标题一直都能还原（对照组）', () => {
    const broken = asWrittenByBrokenGenerator('3 界面导览')
    expect(repairPdfText(broken)).toBe('3 界面导览')
  })
})

describe('辅助函数', () => {
  it('countCjk 能数中日韩字符', () => {
    expect(countCjk('abc中文')).toBe(2)
    expect(countCjk('hello')).toBe(0)
  })

  it('toPdfBytes 遇到无法映射的字符返回 null', () => {
    expect(toPdfBytes('中文')).toBeNull()
    expect([...(toPdfBytes('Ä¿') ?? [])]).toEqual([0xc4, 0xbf])
  })
})
