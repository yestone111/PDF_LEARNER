/**
 * PDF 相关的动作编排：连接「流程层(pdfSession) / 仓储层(repositories) / 状态层(stores)」。
 * 组件只调这里，不直接碰 Dexie 或 pdf.js。
 */

import {
  addBookmark,
  findBookmarkByOutline,
  listBookmarks,
  removeBookmarkByOutline,
} from '../db/repositories/bookmarks'
import {
  addHighlight as addHighlightRepo,
  deleteHighlight,
  updateHighlightComment,
} from '../db/repositories/highlights'
import { loadGraphIntoStore } from '../llm/pipeline/controller'
import { newId } from '../lib/id'
import { useDocumentStore } from '../stores/documentStore'
import { useUiStore } from '../stores/uiStore'
import { toStoredPosition } from './highlightMapping'
import { openPdfById, openPdfFromFile } from './pdfSession'

import type { ScaledPosition } from 'react-pdf-highlighter'

import type { Highlight, OutlineNode } from '../domain'

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 打开本地 PDF。失败时把错误留在 store 里，UI 必须显式展示。 */
export async function openPdfFile(file: File): Promise<void> {
  useDocumentStore.getState().setStatus('loading')
  try {
    const opened = await openPdfFromFile(file)
    useDocumentStore.getState().openSession(opened)
    useUiStore.getState().setLastDocumentId(opened.document.id)
    await loadGraphIntoStore()
    await restoreBookmarks(opened.document.id)
  } catch (error) {
    useDocumentStore.getState().setStatus('error', toMessage(error))
  }
}

/** 刷新页面后恢复上次打开的文档。没有记录就什么都不做（保持初始空态）。 */
export async function restoreLastDocument(): Promise<void> {
  const documentId = useUiStore.getState().lastDocumentId
  if (documentId === null) return

  useDocumentStore.getState().setStatus('loading')
  try {
    const opened = await openPdfById(documentId)
    useDocumentStore.getState().openSession(opened)
    // 图谱存在 IndexedDB 里，刷新后必须一起恢复（否则要重新抽取才能看到图）
    await loadGraphIntoStore()
    await restoreBookmarks(opened.document.id)
  } catch (error) {
    useDocumentStore.getState().setStatus('error', toMessage(error))
    // 记录失效（文件被清掉/数据库被清空）：清掉指针，避免每次启动都报错
    useUiStore.getState().setLastDocumentId(null)
  }
}

export interface SaveHighlightInput {
  readonly position: ScaledPosition
  readonly content: { readonly text?: string; readonly image?: string }
  readonly comment: { readonly text: string; readonly emoji: string }
}

/** 划选完成 → 落库 → 进 store。返回落库后的实体（失败抛错，由调用方展示）。 */
export async function saveSelectionHighlight(input: SaveHighlightInput): Promise<Highlight> {
  const activeDocument = useDocumentStore.getState().document
  if (activeDocument === null) throw new Error('没有打开的文档')

  const timestamp = Date.now()
  const highlight: Highlight = {
    id: newId(),
    documentId: activeDocument.id,
    position: toStoredPosition(input.position),
    content: { text: input.content.text, image: input.content.image },
    comment: { text: input.comment.text, emoji: input.comment.emoji },
    nodeId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  await addHighlightRepo(highlight)
  useDocumentStore.getState().upsertHighlight(highlight)
  return highlight
}

export async function saveHighlightComment(
  highlightId: string,
  comment: { readonly text: string; readonly emoji: string },
): Promise<void> {
  await updateHighlightComment(highlightId, comment)
  const existing = useDocumentStore
    .getState()
    .highlights.find((item) => item.id === highlightId)
  if (existing !== undefined) {
    useDocumentStore.getState().upsertHighlight({ ...existing, comment, updatedAt: Date.now() })
  }
}

export async function removeHighlight(highlightId: string): Promise<void> {
  await deleteHighlight(highlightId)
  useDocumentStore.getState().removeHighlight(highlightId)
}

/** 目录点击：把跳页请求交给中栏（由 PdfPane 消费）。 */
export function requestPageNavigation(page: number): void {
  useDocumentStore.getState().requestScrollToPage(page)
}

/**
 * 读回当前文档的书签；有书签就直接跳到「最近一次钉住」的那一章。
 *
 * 跳转是「继续读」的语义，所以会把中栏切到 PDF（否则只在后台滚页，用户看不见）；
 * 但**不**切章节子图模式 —— 图谱仍停在总览，切过去会像图没生成。
 */
export async function restoreBookmarks(documentId: string): Promise<void> {
  const bookmarks = await listBookmarks(documentId)
  useDocumentStore.getState().setBookmarks(bookmarks)
  const latest = bookmarks[0]
  if (latest === undefined) return
  useDocumentStore.getState().requestScrollToPage(latest.page)
  useDocumentStore.getState().setBookmarkNotice(latest)
  useUiStore.getState().setCenterTab('pdf')
}

/** 目录里点星：同章只留一条（再点就取消）。 */
export async function toggleChapterBookmark(node: OutlineNode): Promise<void> {
  const document = useDocumentStore.getState().document
  if (document === null) throw new Error('没有打开的文档')
  if (node.page === null) throw new Error('这一章没有解析到页码，不能加书签')

  const existing = await findBookmarkByOutline(document.id, node.id)
  if (existing !== null) await removeBookmarkByOutline(document.id, node.id)
  else await addBookmark(node)

  // 只更新书签列表（星标自己会变实心）；「下次打开跳到哪」由 restoreBookmarks 取最新一条
  useDocumentStore.getState().setBookmarks(await listBookmarks(document.id))
}
