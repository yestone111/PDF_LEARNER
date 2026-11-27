import { describe, expect, it } from 'vitest'

import { locateTextInIndex } from './textSearch'
import { buildDocumentTextIndex, type PageGeometry } from './textIndex'

function page(pageNumber: number, lines: Array<{ text: string; x: number; y: number; width: number }>): PageGeometry {
  return {
    page: pageNumber,
    viewportTransform: [1, 0, 0, 1, 0, 0],
    items: lines.map((line) => ({
      str: line.text,
      width: line.width,
      height: 10,
      transform: [10, 0, 0, 10, line.x, line.y],
    })),
  }
}

const index = buildDocumentTextIndex([
  page(1, [{ text: '零拷贝卸载是一种优化手段 ', x: 50, y: 700, width: 200 }]),
  page(2, [
    { text: '界面导览与三栏布局 ', x: 50, y: 700, width: 180 },
    { text: 'Table 1: 参数说明', x: 50, y: 680, width: 150 },
  ]),
])

describe('locateTextInIndex（标题兜底定位）', () => {
  it('按标题找到页码与原文片段', () => {
    expect(locateTextInIndex(index, '零拷贝卸载')).toEqual({ page: 1, quote: '零拷贝卸载' })
    expect(locateTextInIndex(index, '三栏布局')).toEqual({ page: 2, quote: '三栏布局' })
  })

  it('跨行/带空格的标题也能对上（归一化后匹配）', () => {
    const hit = locateTextInIndex(index, '界面导览与三栏布局')
    expect(hit?.page).toBe(2)
  })

  it('标题里混入标点/大小写差异仍可定位', () => {
    expect(locateTextInIndex(index, 'table 1：参数说明')?.page).toBe(2)
  })

  it('找不到就返回 null（不猜页码）', () => {
    expect(locateTextInIndex(index, '量子纠缠与超导')).toBeNull()
  })

  it('空标题/太短的词不参与定位', () => {
    expect(locateTextInIndex(index, '   ')).toBeNull()
    expect(locateTextInIndex(index, '零')).toBeNull()
  })

  it('可以跳过指定页（标题兜底要避开目录页）', () => {
    // 「零拷贝卸载」只出现在第 1 页；跳过第 1 页后没有别的命中 → 退回第一次命中
    expect(locateTextInIndex(index, '零拷贝卸载', { skipPages: new Set([1]) })?.page).toBe(1)
  })

  it('同一标题在目录页和正文页都出现时，优先非目录页', () => {
    const withToc = buildDocumentTextIndex([
      page(2, [{ text: '3 界面导览 ', x: 50, y: 700, width: 120 }]),
      page(6, [{ text: '3 界面导览 ', x: 50, y: 700, width: 120 }]),
    ])
    expect(locateTextInIndex(withToc, '界面导览')?.page).toBe(2)
    expect(locateTextInIndex(withToc, '界面导览', { skipPages: new Set([2]) })?.page).toBe(6)
  })
})
