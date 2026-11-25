/**
 * 打开 PDF 的完整流程（解析 → 落库 → 取目录/高亮）。
 * 这一层不碰 React / store，便于将来复用到导入向导或测试。
 */

import { listHighlights } from '../db/repositories/highlights'
import {
  getDocument,
  getPdfFile,
  saveDocumentWithFile,
  updateDocumentStatus,
} from '../db/repositories/documents'
import { loadOutline, replaceOutline } from '../db/repositories/outline'
import { newId } from '../lib/id'
import { resolveDestToPage } from './destinations'
import { buildOutlineNodes, type RawOutlineItem } from './outline'
import { loadPdfFromArrayBuffer, type PDFDocumentProxy } from './pdfjs'
import { repairPdfText } from './textDecoding'

import type { Highlight, KDocument, OutlineNode } from '../domain'

export interface OpenedDocument {
  readonly document: KDocument
  readonly outline: readonly OutlineNode[]
  readonly pdfDocument: PDFDocumentProxy
  readonly highlights: readonly Highlight[]
}

async function extractOutline(
  pdfDocument: PDFDocumentProxy,
  documentId: string,
  timestamp: number,
): Promise<OutlineNode[]> {
  const raw = (await pdfDocument.getOutline()) as readonly RawOutlineItem[] | null
  if (raw === null || raw.length === 0) return []

  return buildOutlineNodes({
    documentId,
    items: raw,
    resolvePage: (dest) => resolveDestToPage(pdfDocument, dest),
    createId: newId,
    timestamp,
  })
}

/** 上传/选择本地 PDF：解析 → 落库 → 建目录。解析失败时不落任何数据。 */
export async function openPdfFromFile(file: File): Promise<OpenedDocument> {
  if (file.size === 0) throw new Error('文件为空，无法解析')
  if (file.type !== '' && file.type !== 'application/pdf') {
    throw new Error(`仅支持 PDF，当前文件类型：${file.type}`)
  }

  const data = await file.arrayBuffer()
  const pdfDocument = await loadPdfFromArrayBuffer(data)
  const timestamp = Date.now()

  const saved = await saveDocumentWithFile({
    name: file.name,
    sizeBytes: file.size,
    pageCount: pdfDocument.numPages,
    data,
  })

  const outline = await extractOutline(pdfDocument, saved.document.id, timestamp)
  await replaceOutline(saved.document.id, outline)
  await updateDocumentStatus(saved.document.id, 'outline_parsed')

  return {
    document: { ...saved.document, status: 'outline_parsed' },
    outline,
    pdfDocument,
    highlights: [],
  }
}

/** 重新打开已存文档（刷新页面后恢复现场）。 */
export async function openPdfById(documentId: string): Promise<OpenedDocument> {
  const document = await getDocument(documentId)
  if (document === null) throw new Error('文档不存在或已删除')

  const file = await getPdfFile(document.fileId)
  if (file === null) throw new Error('PDF 原始文件缺失，请重新上传')

  const pdfDocument = await loadPdfFromArrayBuffer(file.data)

  let outline = await loadOutline(documentId)
  // 旧版本导入的文档可能把乱码标题缓存进了 IndexedDB：能修就重建一次目录，实现自愈。
  const needsRepair = outline.some((node) => repairPdfText(node.title) !== node.title)
  if (outline.length === 0 || needsRepair) {
    // 上次解析可能失败/被清空：重建一次目录（幂等）
    outline = await extractOutline(pdfDocument, documentId, Date.now())
    if (outline.length > 0) {
      await replaceOutline(documentId, outline)
      await updateDocumentStatus(documentId, 'outline_parsed')
    }
  }

  const highlights = await listHighlights(documentId)
  return { document, outline, pdfDocument, highlights }
}
