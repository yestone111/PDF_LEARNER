/**
 * 「学习对话框」的数据装配：知识点 → 可标注的原文摘录（含跨页与图表）。
 * 视图层只拿到结果，不关心 pdf.js 索引与坐标换算。
 */

import { useDocumentStore } from '../stores/documentStore'
import { useGraphStore } from '../stores/graphStore'
import { estimateFigureRegion } from './figureRender'
import { getDocumentTextIndex } from './textIndexLoader'
import { buildExcerpt, findCaption, findQuoteRange, rectsForRange } from './textIndex'

import type { KnowledgeFigure, KnowledgeNode } from '../domain'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfSpaceRect } from './textIndex'
import type { CaptionMatch, DocumentTextIndex, ExcerptSegment, RawRange } from './textIndex'

export interface FigureExcerpt {
  readonly page: number
  readonly caption: CaptionMatch
  readonly region: PdfSpaceRect
}

export interface NodeExcerpt {
  readonly node: KnowledgeNode
  readonly index: DocumentTextIndex
  readonly anchorRange: RawRange | null
  readonly segments: readonly ExcerptSegment[]
  readonly figures: readonly FigureExcerpt[]
  readonly note: string | null
}

/** 图表/表格节点：按 caption 文本在全文里定位，再按 caption 坐标估算区域。 */
async function figureFromCaption(
  pdfDocument: PDFDocumentProxy,
  index: DocumentTextIndex,
  figure: KnowledgeFigure,
): Promise<FigureExcerpt[]> {
  const candidates = [`${figure.label} ${figure.caption}`.trim(), figure.caption, figure.label]
  for (const text of candidates) {
    if (text.trim() === '') continue
    const range = findQuoteRange(index, text)
    if (range === null) continue
    const captionRects = rectsForRange(index, range)
    const captionRect = captionRects[0]
    if (captionRect === undefined) continue
    const page = await pdfDocument.getPage(captionRect.page)
    const viewport = page.getViewport({ scale: 1 })
    return [
      {
        page: captionRect.page,
        caption: { label: figure.label, text: text.trim(), range },
        region: estimateFigureRegion(
          { ...captionRect, page: captionRect.page },
          { width: viewport.width, height: viewport.height },
        ),
      },
    ]
  }
  return []
}

export async function loadNodeExcerpt(nodeId: string): Promise<NodeExcerpt | null> {
  const state = useDocumentStore.getState()
  const node = useGraphStore.getState().nodesById[nodeId]
  if (state.document === null || state.pdfDocument === null || node === undefined) return null

  const index = await getDocumentTextIndex(state.document.id, state.pdfDocument)

  const anchorRange = node.anchor === null ? null : findQuoteRange(index, node.anchor.quote)
  if (anchorRange === null) {
    // 图表/表格节点没有逐字引文（或引文定位失败）：仍然按 caption 找一次，
    // 这样对话框里还能显示 caption + 区域截图 + 「在 PDF 查看」。
    const figures =
      node.figure === null ? [] : await figureFromCaption(state.pdfDocument, index, node.figure)
    return { node, index, anchorRange: null, segments: [], figures, note: null }
  }

  const excerpt = buildExcerpt(index, anchorRange, 200, 200)

  const figures: FigureExcerpt[] = []
  for (const segment of excerpt.segments) {
    const caption = findCaption(segment)
    if (caption === null) continue
    const captionRects = rectsForRange(index, caption.range)
    const captionRect = captionRects[0]
    if (captionRect === undefined) continue

    const page = await state.pdfDocument.getPage(captionRect.page)
    const viewport = page.getViewport({ scale: 1 })
    figures.push({
      page: captionRect.page,
      caption,
      region: estimateFigureRegion(
        { ...captionRect, page: captionRect.page },
        { width: viewport.width, height: viewport.height },
      ),
    })
  }

  return { node, index, anchorRange, segments: excerpt.segments, figures, note: null }
}

/** 摘录里的选区（全文区间）→ 可落库的 Highlight.position（PDF 坐标）。 */
export function toNodeHighlightPosition(index: DocumentTextIndex, range: RawRange): {
  boundingRect: { x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }
  rects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }>
  pageNumber: number
  usePdfCoordinates: true
} | null {
  const rects = rectsForRange(index, range)
  if (rects.length === 0) return null

  const firstPage = rects[0]!.page
  const onFirstPage = rects.filter((rect) => rect.page === firstPage)
  const x1 = Math.min(...onFirstPage.map((rect) => rect.x1))
  const y1 = Math.min(...onFirstPage.map((rect) => rect.y1))
  const x2 = Math.max(...onFirstPage.map((rect) => rect.x2))
  const y2 = Math.max(...onFirstPage.map((rect) => rect.y2))

  const toPdfRect = (rect: { x1: number; y1: number; x2: number; y2: number; width: number; height: number; page: number }) => ({
    x1: rect.x1,
    y1: rect.y1,
    x2: rect.x2,
    y2: rect.y2,
    width: rect.width,
    height: rect.height,
    pageNumber: rect.page,
  })

  return {
    boundingRect: { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1, pageNumber: firstPage },
    rects: rects.map(toPdfRect),
    pageNumber: firstPage,
    usePdfCoordinates: true,
  }
}
