/**
 * 文档与 PDF 文件的仓储层。
 * 纪律：写入 IndexedDB 之前必须过 zod（工程纪律 §8.1 —— 连自己造的对象也不放过）。
 */

import { KDocumentSchema, PdfFileSchema, parseStrict } from '../../domain'
import { getDb } from '../database'
import { newId } from '../../lib/id'

import type { KDocument, PdfFile } from '../../domain'

export interface SaveDocumentInput {
  readonly name: string
  readonly sizeBytes: number
  readonly pageCount: number
  readonly data: ArrayBuffer
}

export interface SaveDocumentResult {
  readonly document: KDocument
  readonly file: PdfFile
}

export async function saveDocumentWithFile(input: SaveDocumentInput): Promise<SaveDocumentResult> {
  const timestamp = Date.now()
  const fileId = newId()

  const document: KDocument = {
    id: newId(),
    name: input.name,
    pageCount: input.pageCount,
    sizeBytes: input.sizeBytes,
    fileId,
    status: 'uploaded',
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  const file: PdfFile = {
    id: fileId,
    documentId: document.id,
    name: input.name,
    mime: 'application/pdf',
    sizeBytes: input.sizeBytes,
    data: input.data,
    createdAt: timestamp,
  }

  const documentCheck = parseStrict(KDocumentSchema, document, 'KDocument')
  if (!documentCheck.ok) throw new Error(documentCheck.message)
  const fileCheck = parseStrict(PdfFileSchema, file, 'PdfFile')
  if (!fileCheck.ok) throw new Error(fileCheck.message)

  const db = getDb()
  await db.transaction('rw', db.documents, db.pdfFiles, async () => {
    await db.pdfFiles.add(file)
    await db.documents.add(document)
  })

  return { document, file }
}

export async function updateDocumentStatus(
  documentId: string,
  status: KDocument['status'],
): Promise<void> {
  const db = getDb()
  await db.documents.update(documentId, { status, updatedAt: Date.now() })
}

export async function getDocument(documentId: string): Promise<KDocument | null> {
  const db = getDb()
  const found = await db.documents.get(documentId)
  if (found === undefined) return null
  const checked = parseStrict(KDocumentSchema, found, 'KDocument')
  if (!checked.ok) throw new Error(checked.message)
  return checked.data
}

export async function getPdfFile(fileId: string): Promise<PdfFile | null> {
  const db = getDb()
  const found = await db.pdfFiles.get(fileId)
  if (found === undefined) return null
  const checked = parseStrict(PdfFileSchema, found, 'PdfFile')
  if (!checked.ok) throw new Error(checked.message)
  return checked.data
}

export async function listDocuments(): Promise<KDocument[]> {
  const db = getDb()
  return db.documents.orderBy('createdAt').reverse().toArray()
}

/** 删除文档及其全部派生数据（单事务，避免半删状态）。 */
export async function deleteDocument(documentId: string): Promise<void> {
  const db = getDb()
  await db.transaction(
    'rw',
    [
      db.documents,
      db.pdfFiles,
      db.outlineNodes,
      db.highlights,
      db.notes,
      db.knowledgeNodes,
      db.knowledgeEdges,
      db.chunks,
      db.extractionCaches,
      db.chatMessages,
      db.chatThreads,
      db.noteDocs,
      db.noteImages,
    ],
    async () => {
      await db.pdfFiles.where('documentId').equals(documentId).delete()
      await db.outlineNodes.where('documentId').equals(documentId).delete()
      await db.highlights.where('documentId').equals(documentId).delete()
      await db.notes.where('documentId').equals(documentId).delete()
      await db.knowledgeEdges.where('documentId').equals(documentId).delete()
      await db.knowledgeNodes.where('documentId').equals(documentId).delete()
      await db.chunks.where('documentId').equals(documentId).delete()
      await db.extractionCaches.where('documentId').equals(documentId).delete()
      await db.chatMessages.where('documentId').equals(documentId).delete()
      await db.chatThreads.where('documentId').equals(documentId).delete()
      await db.noteDocs.where('documentId').equals(documentId).delete()
      await db.noteImages.where('documentId').equals(documentId).delete()
      await db.documents.delete(documentId)
    },
  )
}
