/**
 * 章节书签仓储。
 *
 * 语义：一条书签 = 「这份文档的某一章」（用 outlineNodeId 钉住），冗余保存标题与起始页，
 * 这样目录被重新解析/清空时书签提示仍然可读，跳转也不依赖当前目录树。
 */

import { ChapterBookmarkSchema, parseStrict } from '../../domain'
import { getDb } from '../database'
import { newId } from '../../lib/id'

import type { ChapterBookmark, OutlineNode } from '../../domain'

export async function listBookmarks(documentId: string): Promise<ChapterBookmark[]> {
  const db = getDb()
  const rows = await db.bookmarks.where('documentId').equals(documentId).toArray()
  const checked: ChapterBookmark[] = []
  for (const row of rows) {
    // 从 IndexedDB 回来的数据也当不可信输入：坏行丢掉，不让它污染 UI
    const parsed = parseStrict(ChapterBookmarkSchema, row, 'ChapterBookmark')
    if (parsed.ok) checked.push(parsed.data)
  }
  // 最新的在前：重开文档时跳「最近一次钉住」的那一章
  return checked.sort((a, b) => b.createdAt - a.createdAt)
}

export async function addBookmark(node: OutlineNode, timestamp = Date.now()): Promise<ChapterBookmark> {
  if (node.page === null) throw new Error('这一章没有可跳转的页码，无法加书签')
  const bookmark: ChapterBookmark = {
    id: newId(),
    documentId: node.documentId,
    outlineNodeId: node.id,
    label: node.title,
    page: node.page,
    createdAt: timestamp,
  }
  const parsed = parseStrict(ChapterBookmarkSchema, bookmark, 'ChapterBookmark')
  if (!parsed.ok) throw new Error(parsed.message)
  await getDb().bookmarks.add(parsed.data)
  return parsed.data
}

/** 同一章节只保留一条书签（重复点星只会取消）。 */
export async function removeBookmarkByOutline(documentId: string, outlineNodeId: string): Promise<boolean> {
  const db = getDb()
  const existing = await db.bookmarks
    .where('documentId')
    .equals(documentId)
    .filter((row) => row.outlineNodeId === outlineNodeId)
    .first()
  if (existing === undefined) return false
  await db.bookmarks.delete(existing.id)
  return true
}

export async function findBookmarkByOutline(
  documentId: string,
  outlineNodeId: string,
): Promise<ChapterBookmark | null> {
  const found = await getDb()
    .bookmarks.where('documentId')
    .equals(documentId)
    .filter((row) => row.outlineNodeId === outlineNodeId)
    .first()
  if (found === undefined) return null
  const parsed = parseStrict(ChapterBookmarkSchema, found, 'ChapterBookmark')
  return parsed.ok ? parsed.data : null
}
