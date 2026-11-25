/**
 * 高亮坐标的跨层映射。
 *
 * react-pdf-highlighter 有两套坐标：
 *   - `ScaledPosition`（持久化，x1/y1/x2/y2）—— 落库用
 *   - `Position`（视口，left/top）—— 渲染用，由库内部换算
 * 库的 `Scaled.pageNumber` 是**可选**的，而我们的 `PdfRect.pageNumber` 必填
 * （这样 `Highlight.position` 才能直接赋值给 `ScaledPosition` 而不需要类型断言）。
 * 这个文件就是唯一做「补全/校验页码」的地方，且可单测。
 */

import type { IHighlight, Scaled, ScaledPosition } from 'react-pdf-highlighter'

import type { Highlight, PdfRect } from '../domain/types'

/** 把库的可选 pageNumber 补成必填；优先用 rect 自己的，其次用 position 的。 */
export function toPdfRect(rect: Scaled, fallbackPage: number): PdfRect {
  return {
    x1: rect.x1,
    y1: rect.y1,
    x2: rect.x2,
    y2: rect.y2,
    width: rect.width,
    height: rect.height,
    pageNumber: typeof rect.pageNumber === 'number' ? rect.pageNumber : fallbackPage,
  }
}

/** 用户划选完成 → 落库用的 position。 */
export function toStoredPosition(position: ScaledPosition): Highlight['position'] {
  const page = position.pageNumber
  return {
    boundingRect: toPdfRect(position.boundingRect, page),
    rects: position.rects.map((rect) => toPdfRect(rect, page)),
    pageNumber: page,
    usePdfCoordinates: position.usePdfCoordinates,
  }
}

/** 落库的 Highlight → 库要求的 IHighlight（多出的 documentId/nodeId 等字段不影响赋值）。 */
export function toLibraryHighlight(highlight: Highlight): IHighlight {
  return {
    id: highlight.id,
    position: highlight.position,
    content: highlight.content,
    comment: highlight.comment,
  }
}
