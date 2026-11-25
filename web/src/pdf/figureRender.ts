/**
 * 图表摘抄：把 PDF 页面的某个区域渲染成 PNG（data URI）。
 *
 * 现状：我们只有 caption 的坐标，没有图表本体的精确框。
 * 所以按「caption 上方一个大区域」估算，并在 UI 里明确标注这是**按 caption 估算**。
 * 估算失败/渲染失败一律返回 null，由调用方降级为「只显示 caption + 跳到 PDF」。
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'

import type { PdfSpaceRect } from './textIndex'

export interface RegionRenderOptions {
  /** 渲染倍率，2 = 更清晰但更大。 */
  readonly scale?: number
}

/** 以 caption 为基准估算图表区域：向上扩 35% 页高、左右各留 8% 页宽。 */
export function estimateFigureRegion(
  captionRect: PdfSpaceRect,
  pageSize: { width: number; height: number },
): PdfSpaceRect {
  const pageHeight = pageSize.height
  const pageWidth = pageSize.width
  const marginX = pageWidth * 0.08

  const x1 = Math.max(0, Math.min(captionRect.x1, marginX) - marginX)
  const x2 = Math.min(pageWidth, Math.max(captionRect.x2, pageWidth - marginX) + marginX)
  const y2 = Math.min(pageHeight, captionRect.y2)
  // PDF 坐标系 y 向上；caption 上方的图在 y 更大的位置
  const y1 = Math.max(0, y2 - pageHeight * 0.35)

  return {
    page: captionRect.page,
    x1,
    y1,
    x2,
    y2,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

export async function renderRegionToPng(
  pdfDocument: PDFDocumentProxy,
  region: PdfSpaceRect,
  options: RegionRenderOptions = {},
): Promise<string | null> {
  try {
    const page = await pdfDocument.getPage(region.page)
    const viewport = page.getViewport({ scale: options.scale ?? 2 })

    const full = document.createElement('canvas')
    full.width = Math.ceil(viewport.width)
    full.height = Math.ceil(viewport.height)
    const fullContext = full.getContext('2d')
    if (fullContext === null) return null

    await page.render({ canvasContext: fullContext, viewport }).promise

    const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle([region.x1, region.y1, region.x2, region.y2])
    const sx = Math.max(0, Math.min(vx1, vx2))
    const sy = Math.max(0, Math.min(vy1, vy2))
    const sw = Math.max(1, Math.abs(vx2 - vx1))
    const sh = Math.max(1, Math.abs(vy2 - vy1))

    const crop = document.createElement('canvas')
    crop.width = Math.ceil(sw)
    crop.height = Math.ceil(sh)
    const cropContext = crop.getContext('2d')
    if (cropContext === null) return null
    cropContext.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh)

    return crop.toDataURL('image/png')
  } catch (error) {
    console.warn('[figureRender] 区域渲染失败：', error)
    return null
  }
}
