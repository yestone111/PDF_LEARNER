import { describe, expect, it } from 'vitest'

import { detectTocPages } from './jumpSearch'
import { buildDocumentTextIndex, type PageGeometry } from './textIndex'

import type { OutlineNode } from '../domain'

function page(pageNumber: number, lines: string[]): PageGeometry {
  return {
    page: pageNumber,
    viewportTransform: [1, 0, 0, 1, 0, 0],
    items: lines.map((line, index) => ({
      str: line,
      width: 120,
      height: 10,
      transform: [10, 0, 0, 10, 50, 700 - index * 20],
    })),
  }
}

const outline = (titles: string[]): OutlineNode[] =>
  titles.map((title, index) => ({
    id: `o${index}`,
    documentId: 'doc',
    parentId: null,
    order: index,
    level: 1,
    title,
    page: null,
    predictedImportance: null,
    importanceSource: 'none',
    graphBuilt: false,
    createdAt: 0,
    updatedAt: 0,
  }))

describe('detectTocPages（标题兜底要避开目录页）', () => {
  it('一页里出现 ≥3 个章节标题就算目录页', () => {
    const index = buildDocumentTextIndex([
      page(2, ['1 这是什么 ', '2 安装与运行 ', '3 界面导览 ', '4 第一次学习']),
      page(6, ['3 界面导览 ', '正文……']),
    ])
    const toc = detectTocPages(index, outline(['1 这是什么', '2 安装与运行', '3 界面导览', '4 第一次学习']))
    expect([...toc]).toEqual([2])
  })

  it('正文页只有 1~2 个标题，不会被误判成目录页', () => {
    const index = buildDocumentTextIndex([page(6, ['3 界面导览 ', '4 第一次学习'])])
    const toc = detectTocPages(index, outline(['3 界面导览', '4 第一次学习']))
    expect(toc.size).toBe(0)
  })
})
