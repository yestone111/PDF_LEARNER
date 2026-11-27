import { create } from 'zustand'

import type { PDFDocumentProxy } from 'pdfjs-dist'

import type { ChapterBookmark, Highlight, KDocument, OutlineNode } from '../domain'

/** 通用异步三态（工程纪律 §8.2：禁止空白静默失败）。 */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface DocumentSession {
  readonly document: KDocument
  readonly outline: readonly OutlineNode[]
  readonly pdfDocument: PDFDocumentProxy
  readonly highlights: readonly Highlight[]
}

interface DocumentState {
  document: KDocument | null
  outline: readonly OutlineNode[]
  /** pdf.js 文档代理：不可序列化、不落库，只活在内存里。 */
  pdfDocument: PDFDocumentProxy | null
  highlights: readonly Highlight[]
  /** 当前阅读页（1-based），目录点击 / 滚动都会更新。 */
  pageNumber: number
  /** 目录里当前选中的章节（章节子图模式用它）。 */
  selectedChapterId: string | null
  /** 当前文档的章节书签（最新的在前）。 */
  bookmarks: readonly ChapterBookmark[]
  /** 打开文档时自动跳到书签的提示；null = 不显示。 */
  bookmarkNotice: ChapterBookmark | null
  /** PDF 头部的临时提示（跳转降级原因等），5 秒后自动清空。 */
  flashHint: string | null
  /**
   * 待执行的跳页请求。放在 store 里的原因：
   * 目录在左栏、滚动能力在中栏（PdfHighlighter 的 scrollRef），
   * 用事件总线会引入额外依赖，用 store 一个字段就能解耦且可测。
   */
  pendingScrollPage: number | null
  /** 待执行的「临时高亮原文」请求（点图谱节点跳过来时用）。 */
  pendingFlash: { readonly page: number; readonly quote: string } | null
  status: LoadStatus
  error: string | null

  openSession: (session: DocumentSession) => void
  setHighlights: (highlights: readonly Highlight[]) => void
  upsertHighlight: (highlight: Highlight) => void
  removeHighlight: (highlightId: string) => void
  setPage: (pageNumber: number) => void
  selectChapter: (chapterId: string | null) => void
  setBookmarks: (bookmarks: readonly ChapterBookmark[]) => void
  removeBookmark: (bookmarkId: string) => void
  setBookmarkNotice: (bookmark: ChapterBookmark | null) => void
  setFlashHint: (hint: string | null) => void
  requestScrollToPage: (page: number) => void
  consumeScrollRequest: () => void
  requestFlashQuote: (page: number, quote: string) => void
  consumeFlashRequest: () => void
  setStatus: (status: LoadStatus, error?: string | null) => void
  clear: () => void
}

/**
 * 当前打开的文档现场。
 * Step 2 起：pdfjs 文档代理 + 目录 + 高亮都在这里；
 * 图谱数据仍然在 graphStore（Step 3），不在这里混放。
 */
export const useDocumentStore = create<DocumentState>()((set) => ({
  document: null,
  outline: [],
  pdfDocument: null,
  highlights: [],
  pageNumber: 1,
  selectedChapterId: null,
  bookmarks: [],
  bookmarkNotice: null,
  flashHint: null,
  pendingScrollPage: null,
  pendingFlash: null,
  status: 'idle',
  error: null,

  openSession: (session) =>
    set({
      document: session.document,
      outline: session.outline,
      pdfDocument: session.pdfDocument,
      highlights: session.highlights,
      pageNumber: 1,
      selectedChapterId: null,
      // 书签由 pdfController 在会话打开后异步载入（页面恢复时也要能自动跳过去）
      bookmarks: [],
      bookmarkNotice: null,
      flashHint: null,
      pendingScrollPage: null,
      pendingFlash: null,
      status: 'ready',
      error: null,
    }),

  setHighlights: (highlights) => set({ highlights }),

  upsertHighlight: (highlight) =>
    set((state) => {
      const index = state.highlights.findIndex((item) => item.id === highlight.id)
      if (index === -1) return { highlights: [...state.highlights, highlight] }
      const next = [...state.highlights]
      next[index] = highlight
      return { highlights: next }
    }),

  removeHighlight: (highlightId) =>
    set((state) => ({
      highlights: state.highlights.filter((item) => item.id !== highlightId),
    })),

  setPage: (pageNumber) => set({ pageNumber: Math.max(1, Math.floor(pageNumber)) }),

  selectChapter: (selectedChapterId) => set({ selectedChapterId }),

  setBookmarks: (bookmarks) => set({ bookmarks }),

  removeBookmark: (bookmarkId) =>
    set((state) => ({ bookmarks: state.bookmarks.filter((item) => item.id !== bookmarkId) })),

  setBookmarkNotice: (bookmarkNotice) => set({ bookmarkNotice }),

  setFlashHint: (flashHint) => set({ flashHint }),

  requestScrollToPage: (page) => set({ pendingScrollPage: Math.max(1, Math.floor(page)) }),

  consumeScrollRequest: () => set({ pendingScrollPage: null }),

  requestFlashQuote: (page, quote) => set({ pendingFlash: { page, quote } }),

  consumeFlashRequest: () => set({ pendingFlash: null }),

  setStatus: (status, error = null) => set({ status, error }),

  clear: () =>
    set({
      document: null,
      outline: [],
      pdfDocument: null,
      highlights: [],
      pageNumber: 1,
      selectedChapterId: null,
      bookmarks: [],
      bookmarkNotice: null,
      flashHint: null,
      pendingScrollPage: null,
      pendingFlash: null,
      status: 'idle',
      error: null,
    }),
}))
