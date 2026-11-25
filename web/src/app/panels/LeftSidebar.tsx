import { useMemo, useState } from 'react'

import { collectConcepts, computeChapterProgress } from '../../graph/chapterProgress'
import { BookmarkRibbon, ChapterMasteryDot, OutlineTree } from '../../pdf/OutlineTree'
import { requestPageNavigation, toggleChapterBookmark } from '../../pdf/pdfController'
import { useDocumentStore } from '../../stores/documentStore'
import { useGraphStore } from '../../stores/graphStore'

import type { ChapterProgress } from '../../graph/chapterProgress'
import type { OutlineNode } from '../../domain'
import type { ReactElement } from 'react'

const COMPLETE_SAMPLE: ChapterProgress = { state: 'complete', total: 1, mastered: 1 }
const PARTIAL_SAMPLE: ChapterProgress = { state: 'partial', total: 2, mastered: 1 }
const NONE_SAMPLE: ChapterProgress = { state: 'none', total: 0, mastered: 0 }

/**
 * 左栏：PDF 目录（outline）。
 * 数据来自 pdf.js 的真实书签（Step 2 已接通），没有书签就显示明确的空态。
 *
 * 目录每行左侧的小圆点 = 这一章的掌握度（实心绿 / 半绿 / 灰空心）；
 * 行尾的绸带书签图标 = 章节书签，下次打开这份文档会直接跳到最近钉住的那一章。
 */
export function LeftSidebar(): ReactElement {
  const activeDocument = useDocumentStore((state) => state.document)
  const outline = useDocumentStore((state) => state.outline)
  const status = useDocumentStore((state) => state.status)
  const error = useDocumentStore((state) => state.error)
  const pageNumber = useDocumentStore((state) => state.pageNumber)
  const bookmarks = useDocumentStore((state) => state.bookmarks)
  const bookmarkNotice = useDocumentStore((state) => state.bookmarkNotice)
  const setBookmarkNotice = useDocumentStore((state) => state.setBookmarkNotice)
  const nodesById = useGraphStore((state) => state.nodesById)

  const selectChapter = useDocumentStore((state) => state.selectChapter)
  const [bookmarkError, setBookmarkError] = useState<string | null>(null)

  // 概念集：把 ① 总览节点与 ② 章节细化节点按 titleNorm 折成同一批知识点，避免同一概念被数两次
  const allNodes = useMemo(() => Object.values(nodesById), [nodesById])
  const concepts = useMemo(() => collectConcepts(allNodes), [allNodes])
  const progress = useMemo(() => computeChapterProgress(outline, allNodes), [outline, allNodes])
  const bookmarkedIds = useMemo(() => new Set(bookmarks.map((item) => item.outlineNodeId)), [bookmarks])
  const stats = useMemo(() => {
    const mastered = concepts.filter((concept) => concept.mastered).length
    return { total: concepts.length, mastered }
  }, [concepts])

  const handleSelect = (node: OutlineNode): void => {
    // 选中章节（章节子图模式）+ 跳页（PDF 视图）；两者互不影响
    selectChapter(node.id)
    if (node.page !== null) requestPageNavigation(node.page)
  }

  const handleToggleBookmark = (node: OutlineNode): void => {
    setBookmarkError(null)
    void toggleChapterBookmark(node).catch((cause: unknown) => {
      setBookmarkError(cause instanceof Error ? cause.message : '书签操作失败')
    })
  }

  return (
    <aside
      data-testid="panel-left"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-akn-border bg-akn-panel"
    >
      <header className="flex items-center justify-between border-b border-akn-border px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-[0.18em] text-akn-muted uppercase">
          文档目录
        </h2>
        <span
          data-testid="outline-count"
          className="rounded bg-akn-raised px-1.5 py-0.5 font-mono text-[10px] text-akn-muted"
        >
          {outline.length}
        </span>
      </header>

      {bookmarkNotice !== null ? (
        <div
          data-testid="bookmark-notice"
          className="mx-2 mt-2 flex items-start justify-between gap-2 rounded border border-akn-ok/40 bg-akn-ok-soft px-2 py-1 text-[10px] leading-relaxed text-akn-ok"
        >
          <span>
            已跳到书签：{bookmarkNotice.label}（第 {bookmarkNotice.page} 页）
          </span>
          <button
            type="button"
            data-testid="bookmark-notice-dismiss"
            onClick={() => setBookmarkNotice(null)}
            className="shrink-0 rounded px-1 text-akn-ok/70 hover:text-akn-ok"
            aria-label="关闭书签提示"
          >
            ×
          </button>
        </div>
      ) : null}

      {bookmarkError !== null ? (
        <p
          data-testid="bookmark-error"
          className="mx-2 mt-2 rounded border border-akn-danger/40 bg-akn-danger-soft px-2 py-1 text-[10px] text-akn-danger"
        >
          {bookmarkError}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {status === 'error' ? (
          <p className="rounded-lg border border-akn-danger/40 bg-akn-danger-soft px-3 py-2 text-xs text-akn-danger">
            目录加载失败：{error ?? '未知错误'}
          </p>
        ) : status === 'loading' ? (
          <p className="rounded-lg border border-akn-border bg-akn-sunken px-3 py-6 text-center text-xs text-akn-muted">
            正在解析 PDF 目录…
          </p>
        ) : activeDocument === null ? (
          <OutlineEmptyState />
        ) : outline.length === 0 ? (
          <div
            data-testid="outline-empty"
            className="rounded-lg border border-dashed border-akn-border px-3 py-6 text-center text-[11px] leading-relaxed text-akn-muted"
          >
            这份 PDF 没有书签目录。
            <br />
            不伪造目录 —— 章节结构将在 Step 3 由 AI 抽取补全。
          </div>
        ) : (
          <OutlineTree
            nodes={outline}
            onSelect={handleSelect}
            selectedPage={pageNumber}
            progress={progress}
            bookmarked={bookmarkedIds}
            onToggleBookmark={handleToggleBookmark}
          />
        )}
      </div>

      <footer className="space-y-1 border-t border-akn-border px-3 py-2 text-[10px] leading-relaxed text-akn-muted">
        <div
          data-testid="outline-progress-legend"
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <span className="inline-flex items-center gap-1">
            <ChapterMasteryDot progress={COMPLETE_SAMPLE} showTestId={false} />
            全部掌握
          </span>
          <span className="inline-flex items-center gap-1">
            <ChapterMasteryDot progress={PARTIAL_SAMPLE} showTestId={false} />
            部分掌握
          </span>
          <span className="inline-flex items-center gap-1">
            <ChapterMasteryDot progress={NONE_SAMPLE} showTestId={false} />
            未开始
          </span>
          <span data-testid="outline-mastery-stats" className="font-mono text-akn-muted/70">
            已掌握 {stats.mastered}/{stats.total}
          </span>
        </div>
        <p>
          点行尾的 <BookmarkRibbon filled={false} className="inline h-3 w-3 align-text-bottom text-akn-muted" /> 加章节书签
          （实心即已加）；下次打开这份文档会直接跳到最近钉住的那一章。鼠标停在圆圈上可看这一章掌握了几分之几。
        </p>
      </footer>
    </aside>
  )
}

function OutlineEmptyState(): ReactElement {
  return (
    <div
      data-testid="outline-idle"
      className="rounded-lg border border-dashed border-akn-border px-3 py-8 text-center"
    >
      <p className="text-xs font-medium text-akn-ink/80">尚未打开 PDF</p>
      <p className="mt-2 text-[11px] leading-relaxed text-akn-muted">
        打开后这里显示 PDF 的真实书签目录，
        <br />
        点击条目即可跳转到对应页。
      </p>
      <div className="mt-4 space-y-1.5" aria-hidden="true">
        <div className="mx-auto h-1.5 w-3/4 rounded-full bg-akn-raised" />
        <div className="mx-auto h-1.5 w-2/3 rounded-full bg-akn-raised" />
        <div className="mx-auto h-1.5 w-4/5 rounded-full bg-akn-raised" />
      </div>
    </div>
  )
}
