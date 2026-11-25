/** 从 pdf.js 文档构建全文索引（每份文档只构建一次，按 documentId 缓存）。 */

import { buildDocumentTextIndex, type DocumentTextIndex, type PageGeometry } from './textIndex'

import type { PDFDocumentProxy } from 'pdfjs-dist'

const cache = new Map<string, Promise<DocumentTextIndex>>()

async function buildFromPdf(pdfDocument: PDFDocumentProxy): Promise<DocumentTextIndex> {
  const pages: PageGeometry[] = []

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()

    pages.push({
      page: pageNumber,
      viewportTransform: viewport.transform,
      items: content.items
        .filter((item): item is typeof item & { str: string; width: number; height: number; transform: number[] } =>
          'str' in item,
        )
        .map((item) => ({
          str: item.str,
          width: item.width,
          height: item.height,
          transform: item.transform,
        })),
    })
  }

  return buildDocumentTextIndex(pages)
}

export function getDocumentTextIndex(
  documentId: string,
  pdfDocument: PDFDocumentProxy,
): Promise<DocumentTextIndex> {
  const cached = cache.get(documentId)
  if (cached !== undefined) return cached
  const created = buildFromPdf(pdfDocument)
  cache.set(documentId, created)
  return created
}

export function invalidateTextIndex(documentId: string): void {
  cache.delete(documentId)
}
