/**
 * Dexie / IndexedDB 表结构（第一轮交付物 ②）。
 *
 * 设计要点：
 * - 主键全部是字符串 id（crypto.randomUUID），不用 ++id，方便离线导入与跨设备合并。
 * - 只给「真的会用来查询」的字段建索引；不给大文本（content/text/quote/blobs）建索引。
 * - Dexie 不能索引 boolean：SyncConfig.enabled 用 0 | 1。
 * - 嵌套字段（如 Highlight.position.pageNumber）不可索引，因此索引只落在顶层字段上。
 *
 * 迁移纪律：任何 schema 变更都必须 version(N+1) + upgrade() 显式迁移，
 * 不允许「删库重置」作为默认修复手段。
 */

import Dexie, { type Table } from 'dexie'

import type {
  ChapterBookmark,
  ChatMessage,
  ChatThread,
  Chunk,
  ExtractionCache,
  Highlight,
  KDocument,
  KnowledgeEdge,
  KnowledgeNode,
  Note,
  NoteDoc,
  NoteImage,
  OutlineNode,
  PdfFile,
  SyncConfig,
} from '../domain/types'

export const DB_NAME = 'ai-knowledge-navigator'

/** 每次 schema 变更 +1，并补 upgrade 迁移。v2：新增 bookmarks（章节书签）。 */
export const DB_VERSION = 2

/**
 * Dexie stores 声明。
 * `[a+b]` 是复合索引；同一字段可以同时出现在单列索引和复合索引里。
 */
export const TABLE_STORES = {
  documents: 'id, name, status, createdAt',
  pdfFiles: 'id, documentId',
  outlineNodes: 'id, documentId, parentId, page, [documentId+order]',
  bookmarks: 'id, documentId, outlineNodeId, createdAt, [documentId+createdAt]',
  knowledgeNodes:
    'id, documentId, parentId, chapterId, scope, importance, mastery, sourceChunkId, [documentId+scope], [documentId+chapterId]',
  knowledgeEdges: 'id, documentId, sourceId, targetId, relationType, [documentId+sourceId]',
  highlights: 'id, documentId, nodeId',
  notes: 'id, documentId, highlightId, nodeId, createdAt',
  chunks: 'id, documentId, order, [documentId+order]',
  extractionCaches: 'key, documentId, stage, status, promptVersion, updatedAt',
  chatThreads: 'id, documentId, updatedAt',
  chatMessages: 'id, threadId, documentId, role, createdAt, [threadId+createdAt]',
  noteDocs: 'id, documentId, updatedAt',
  noteImages: 'id, noteDocId, documentId, createdAt',
  syncConfigs: 'id, target, enabled',
} as const

export type TableName = keyof typeof TABLE_STORES

export const TABLE_NAMES = Object.keys(TABLE_STORES) as readonly TableName[]

export class AknDatabase extends Dexie {
  documents!: Table<KDocument, string>
  pdfFiles!: Table<PdfFile, string>
  outlineNodes!: Table<OutlineNode, string>
  bookmarks!: Table<ChapterBookmark, string>
  knowledgeNodes!: Table<KnowledgeNode, string>
  knowledgeEdges!: Table<KnowledgeEdge, string>
  highlights!: Table<Highlight, string>
  notes!: Table<Note, string>
  chunks!: Table<Chunk, string>
  extractionCaches!: Table<ExtractionCache, string>
  chatThreads!: Table<ChatThread, string>
  chatMessages!: Table<ChatMessage, string>
  noteDocs!: Table<NoteDoc, string>
  noteImages!: Table<NoteImage, string>
  syncConfigs!: Table<SyncConfig, string>

  constructor(name: string = DB_NAME) {
    super(name)
    this.version(DB_VERSION).stores(TABLE_STORES)
  }
}

let instance: AknDatabase | null = null

/**
 * 懒加载单例：模块顶层不触碰 IndexedDB，
 * 这样 node 环境（Vitest）可以安全 import 本文件做纯逻辑测试。
 */
export function getDb(): AknDatabase {
  instance ??= new AknDatabase()
  return instance
}

/** 仅供测试/退出登录时使用。 */
export async function deleteDatabase(name: string = DB_NAME): Promise<void> {
  instance?.close()
  instance = null
  await Dexie.delete(name)
}
