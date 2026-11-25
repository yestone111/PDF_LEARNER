import { describe, expect, it } from 'vitest'

import {
  buildDocumentTextIndex,
  buildExcerpt,
  findCaption,
  findQuoteRange,
  normalizeForSearch,
  rectsForRange,
  type PageGeometry,
} from './textIndex'

/** 构造一个「PDF 坐标 == 视口坐标」的页（identity viewport），便于断言数字。 */
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

const geometry: PageGeometry[] = [
  page(1, [
    { text: 'The Transformer follows this architecture ', x: 50, y: 700, width: 200 },
    { text: 'using stacked self-attention. ', x: 50, y: 680, width: 160 },
  ]),
  page(2, [
    { text: 'A self-attention layer connects all positions ', x: 50, y: 700, width: 220 },
    { text: 'with a constant number of operations.', x: 50, y: 680, width: 190 },
  ]),
]

describe('buildDocumentTextIndex', () => {
  it('各页文本直接拼接，页间用一个 \\n 分隔', () => {
    const index = buildDocumentTextIndex(geometry)
    expect(index.pages).toHaveLength(2)
    expect(index.pages[0]?.text).toBe('The Transformer follows this architecture using stacked self-attention. ')
    expect(index.text).toBe(
      'The Transformer follows this architecture using stacked self-attention. \nA self-attention layer connects all positions with a constant number of operations.',
    )
    expect(index.pageStarts).toEqual([
      0,
      'The Transformer follows this architecture using stacked self-attention. '.length + 1,
    ])
  })

  it('产出 PDF 坐标矩形（identity viewport 下与输入一致）', () => {
    const index = buildDocumentTextIndex(geometry)
    const item = index.pages[0]?.items[0]
    expect(item?.rect.page).toBe(1)
    expect(item?.rect.x1).toBe(50)
    expect(item?.rect.y1).toBe(690) // baseline 700 - 字高 10
    expect(item?.rect.x2).toBe(250)
    expect(item?.rect.y2).toBe(700)
  })

  it('翻转的 viewport 会把 y 转成 PDF 坐标', () => {
    const flipped: PageGeometry[] = [
      {
        page: 3,
        viewportTransform: [1, 0, 0, -1, 0, 800],
        items: [{ str: 'x', width: 10, height: 10, transform: [10, 0, 0, 10, 100, 700] }],
      },
    ]
    const index = buildDocumentTextIndex(flipped)
    const rect = index.pages[0]?.items[0]?.rect
    // item.transform 已含文本空间→视口空间：baseline 视口 y=100、top=90
    // 再用翻转 viewport 转 PDF：800-90=710、800-100=700
    expect(rect?.y1).toBe(700)
    expect(rect?.y2).toBe(710)
  })
})

describe('normalizeForSearch', () => {
  it('去掉标点空白、统一小写、保留 CJK', () => {
    expect(normalizeForSearch('Hello, World!')).toBe('helloworld')
    expect(normalizeForSearch('注意力机制（Attention）')).toBe('注意力机制attention')
  })
})

describe('findQuoteRange', () => {
  const index = buildDocumentTextIndex(geometry)

  it('定位精确引文', () => {
    const range = findQuoteRange(index, 'stacked self-attention')
    expect(range).not.toBeNull()
    expect(index.text.slice(range!.start, range!.end)).toBe('stacked self-attention')
  })

  it('忽略大小写与标点差异', () => {
    const range = findQuoteRange(index, 'STACKED SELF ATTENTION')
    expect(range).not.toBeNull()
  })

  it('跨页引文也能定位（全文连续）', () => {
    const range = findQuoteRange(index, 'self-attention. A self-attention layer')
    expect(range).not.toBeNull()
  })

  it('找不到 → null（不返回最近似区间）', () => {
    expect(findQuoteRange(index, '这段原文里根本没有出现过')).toBeNull()
  })

  it('引文太短（<4 字符）→ null，避免误命中', () => {
    expect(findQuoteRange(index, 'the')).toBeNull()
  })
})

describe('buildExcerpt（前后 200 字、可跨页）', () => {
  const index = buildDocumentTextIndex(geometry)

  it('默认取前后 200 字', () => {
    const anchor = findQuoteRange(index, 'stacked self-attention')!
    const excerpt = buildExcerpt(index, anchor)
    expect(excerpt.start).toBe(Math.max(0, anchor.start - 200))
    expect(excerpt.end).toBe(Math.min(index.text.length, anchor.end + 200))
  })

  it('跨页时按页切段，并带正确页码', () => {
    const anchor = findQuoteRange(index, 'self-attention. A self-attention')!
    const excerpt = buildExcerpt(index, anchor, 30, 30)
    expect(excerpt.segments.length).toBeGreaterThanOrEqual(2)
    const pages = excerpt.segments.map((segment) => segment.page)
    expect(pages).toContain(1)
    expect(pages).toContain(2)
    // 段区间必须连续且能拼回 excerpt 区间
    expect(excerpt.segments[0]?.start).toBe(excerpt.start)
    expect(excerpt.segments[excerpt.segments.length - 1]?.end).toBe(excerpt.end)
  })

  it('摘录文本与全文切片一致（不丢字符）', () => {
    const anchor = findQuoteRange(index, 'constant number')!
    const excerpt = buildExcerpt(index, anchor, 40, 40)
    expect(excerpt.segments.map((segment) => segment.text).join('')).toBe(
      index.text.slice(excerpt.start, excerpt.end),
    )
  })

  it('文档开头/结尾不越界', () => {
    const first = findQuoteRange(index, 'The Transformer')!
    expect(buildExcerpt(index, first).start).toBe(0)
    const last = findQuoteRange(index, 'of operations')!
    expect(buildExcerpt(index, last).end).toBe(index.text.length)
  })
})

describe('rectsForRange（摘录选区 → PDF 矩形）', () => {
  const index = buildDocumentTextIndex(geometry)

  it('只返回与选区交叠的文本项，并按行合并', () => {
    const range = findQuoteRange(index, 'stacked self-attention')!
    const rects = rectsForRange(index, range)
    expect(rects.length).toBe(1)
    expect(rects[0]?.page).toBe(1)
    // 该句在第二个文本项里，x 从 50 开始
    expect(rects[0]?.x1).toBe(50)
  })

  it('跨行选区产生多个矩形', () => {
    const range = findQuoteRange(index, 'architecture using stacked self-attention')!
    const rects = rectsForRange(index, range)
    expect(rects.length).toBe(2)
    // 按 y1 升序：第二行 680-10=670，第一行 700-10=690
    expect(rects.map((rect) => rect.y1)).toEqual([670, 690])
  })

  it('跨页选区在每一页都产生矩形', () => {
    const range = findQuoteRange(index, 'self-attention. A self-attention layer')!
    const rects = rectsForRange(index, range)
    expect(new Set(rects.map((rect) => rect.page))).toEqual(new Set([1, 2]))
  })

  it('空区间 → 空数组（不编造框）', () => {
    expect(rectsForRange(index, { start: 10, end: 10 })).toEqual([])
  })
})

describe('康熙部首码位兼容（Chrome 打印的 PDF）', () => {
  const weird = buildDocumentTextIndex([
    page(1, [
      { text: '⽬录与⽂档说明 ', x: 50, y: 700, width: 120 },
      { text: '第⼀次使⽤', x: 50, y: 680, width: 90 },
    ]),
  ])

  it('NFKC 后「⽬录」与「目录」等价', () => {
    expect(normalizeForSearch('⽬录')).toBe(normalizeForSearch('目录'))
  })

  it('用正常汉字去搜部首码位的文本也能命中', () => {
    const range = findQuoteRange(weird, '目录与文档说明')
    expect(range).not.toBeNull()
    expect(weird.text.slice(range!.start, range!.end)).toBe('⽬录与⽂档说明')
  })

  it('异体字（第⼀次）也能被正常汉字命中', () => {
    expect(findQuoteRange(weird, '第一次使用')).not.toBeNull()
  })
})

describe('findCaption', () => {
  const index = buildDocumentTextIndex([
    page(1, [
      { text: 'Figure 1: The Transformer - model architecture. ', x: 50, y: 700, width: 300 },
      { text: 'Our model is faster. ', x: 50, y: 680, width: 120 },
    ]),
  ])
  const anchor = findQuoteRange(index, 'Our model is faster')!
  const excerpt = buildExcerpt(index, anchor, 120, 0)
  const segment = excerpt.segments[0]!

  it('识别 Figure N: 形式的 caption', () => {
    const caption = findCaption(segment)
    expect(caption?.label).toBe('Figure 1:')
    expect(caption?.text).toContain('The Transformer - model architecture')
  })

  it('识别 Table / 表 形式', () => {
    const tableIndex = buildDocumentTextIndex([
      page(4, [{ text: 'Table 2: Results on WMT. ', x: 10, y: 500, width: 150 }]),
    ])
    const tableSegment = buildExcerpt(tableIndex, findQuoteRange(tableIndex, 'Results on WMT')!, 60, 0).segments[0]!
    expect(findCaption(tableSegment)?.label).toBe('Table 2:')
  })

  it('没有 caption → null', () => {
    const plainIndex = buildDocumentTextIndex([page(1, [{ text: 'Just a paragraph here. ', x: 1, y: 1, width: 100 }])])
    const plainSegment = buildExcerpt(plainIndex, findQuoteRange(plainIndex, 'Just a paragraph')!, 50, 0).segments[0]!
    expect(findCaption(plainSegment)).toBeNull()
  })
})
