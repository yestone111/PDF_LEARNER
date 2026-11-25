import { describe, expect, it } from 'vitest'

import { HighlightSchema } from '../domain/schemas'
import { toLibraryHighlight, toPdfRect, toStoredPosition } from './highlightMapping'

import type { ScaledPosition } from 'react-pdf-highlighter'

import type { Highlight } from '../domain/types'

const scaled = (x1: number, y1: number, x2: number, y2: number, pageNumber?: number): {
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
  height: number
  pageNumber?: number
} => ({ x1, y1, x2, y2, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), pageNumber })

describe('toPdfRect', () => {
  it('rect 自带 pageNumber 时优先用它', () => {
    expect(toPdfRect(scaled(0, 0, 10, 10, 7), 3).pageNumber).toBe(7)
  })

  it('rect 缺 pageNumber 时用 position 的页码补全（绝不落一个 undefined 进库）', () => {
    expect(toPdfRect(scaled(0, 0, 10, 10), 3).pageNumber).toBe(3)
  })
})

describe('toStoredPosition', () => {
  const position: ScaledPosition = {
    pageNumber: 4,
    boundingRect: scaled(10, 20, 110, 40),
    rects: [scaled(10, 20, 110, 40), scaled(12, 22, 90, 38)],
  }

  it('保留全部坐标，并给每个 rect 补页码', () => {
    const stored = toStoredPosition(position)
    expect(stored.pageNumber).toBe(4)
    expect(stored.boundingRect).toEqual({
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 40,
      width: 100,
      height: 20,
      pageNumber: 4,
    })
    expect(stored.rects).toHaveLength(2)
    expect(stored.rects.every((rect) => rect.pageNumber === 4)).toBe(true)
  })

  it('转出来的结构能通过领域 zod schema（落库前的硬门）', () => {
    const highlight: Highlight = {
      id: 'hl-1',
      documentId: 'doc-1',
      position: toStoredPosition(position),
      content: { text: 'scaled dot-product attention' },
      comment: { text: '核心公式', emoji: '💡' },
      nodeId: null,
      createdAt: 1,
      updatedAt: 1,
    }
    expect(HighlightSchema.safeParse(highlight).success).toBe(true)
    expect(HighlightSchema.safeParse({ ...highlight, position: { pageNumber: 4 } }).success).toBe(false)
  })
})

describe('toLibraryHighlight', () => {
  it('输出可赋值给 IHighlight，且不丢内容', () => {
    const highlight: Highlight = {
      id: 'hl-2',
      documentId: 'doc-1',
      position: toStoredPosition({
        pageNumber: 2,
        boundingRect: scaled(0, 0, 50, 10),
        rects: [scaled(0, 0, 50, 10)],
      }),
      content: { text: 'positional encoding' },
      comment: { text: '', emoji: '💡' },
      nodeId: 'kn-1',
      createdAt: 1,
      updatedAt: 2,
    }

    const library = toLibraryHighlight(highlight)
    expect(library.id).toBe('hl-2')
    expect(library.content.text).toBe('positional encoding')
    expect(library.position.pageNumber).toBe(2)
    // documentId/nodeId 是本地扩展字段，不交给库
    expect('documentId' in library).toBe(false)
  })
})
