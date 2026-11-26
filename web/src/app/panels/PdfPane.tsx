import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Highlight, PdfHighlighter } from 'react-pdf-highlighter'

import { useChatStore } from '../../stores/chatStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useGraphStore } from '../../stores/graphStore'
import { useUiStore } from '../../stores/uiStore'
import { HighlightCommentEditor, type LinkedNodeRef } from '../../pdf/HighlightCommentEditor'
import { HighlightTip } from '../../pdf/HighlightTip'
import { toLibraryHighlight } from '../../pdf/highlightMapping'
import { OpenPdfButton } from '../../pdf/OpenPdfButton'
import { removeHighlight, saveHighlightComment, saveSelectionHighlight } from '../../pdf/pdfController'
import { flashPageInView, flashQuoteInPage, isSearchableQuote } from '../../pdf/flashQuote'

import { findNodeByText } from '../../graph/quoteMatch'

import type { IHighlight } from 'react-pdf-highlighter'
import type { ReactElement } from 'react'

/**
 * 中栏：PDF 渲染 + 高亮 + 备注。
 *
 * 集成要点（都来自读库源码，不是猜的）：
 * - `pdfDocument` 由我们自己的 pdfjs（顶层 4.4.168）解析后传入，库内部用自己的 viewer 渲染，
 *   这是 react-pdf-highlighter 官方 demo 的用法；
 * - 跳页唯一入口是 `scrollRef(scrollTo)`，用一个零尺寸合成高亮实现（见 pageAnchor.ts）；
 * - 高亮坐标在「持久化(ScaledPosition) ↔ 视口(Position)」之间的换算全部由库完成，
 *   我们只负责把 ScaledPosition 落库（highlightMapping.ts）。
 */
/** 找到最近的纵向可滚动祖先（库把滚动放在内层 viewer，scrollIntoView 不总是生效）。 */
function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement
  while (current !== null) {
    const style = window.getComputedStyle(current)
    const scrollable =
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      current.scrollHeight > current.clientHeight + 1
    if (scrollable) return current
    current = current.parentElement
  }
  return null
}

/**
 * 把目标页滚进视口。
 * 用「rect 差值 + scrollTop」而不是 scrollIntoView：库的页面在内层滚动容器里，
 * scrollIntoView 在部分布局下不触发滚动 → 页面懒渲染不生成文本层（会导致跳过去后没有高亮）。
 */
export function scrollPageIntoViewer(container: HTMLElement, page: number): boolean {
  const pageElement = container.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`)
  if (pageElement === null) return false
  const scroller = findScrollableAncestor(pageElement) ?? container
  const rect = pageElement.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  const delta = rect.top - scrollerRect.top - 8
  if (Math.abs(delta) > 2) scroller.scrollTop += delta
  return true
}

export function PdfPane(): ReactElement {
  const activeDocument = useDocumentStore((state) => state.document)
  const pdfDocument = useDocumentStore((state) => state.pdfDocument)
  const highlights = useDocumentStore((state) => state.highlights)
  const status = useDocumentStore((state) => state.status)
  const error = useDocumentStore((state) => state.error)
  const pageNumber = useDocumentStore((state) => state.pageNumber)
  const pendingScrollPage = useDocumentStore((state) => state.pendingScrollPage)
  const setPage = useDocumentStore((state) => state.setPage)
  const consumeScrollRequest = useDocumentStore((state) => state.consumeScrollRequest)
  const pendingFlash = useDocumentStore((state) => state.pendingFlash)
  const centerTab = useUiStore((state) => state.centerTab)
  const consumeFlashRequest = useDocumentStore((state) => state.consumeFlashRequest)

  const viewerRef = useRef<HTMLDivElement | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 「跳转到原文」的短提示（引文太短/文本层缺失时的降级说明）。以前 setStatus 写进 error 字段，
  // 但 PDF 已打开时那个占位组件根本不渲染 —— 用户完全看不到降级原因。
  const [flashHint, setFlashHint] = useState<string | null>(null)
  const flashHintTimer = useRef<number | null>(null)

  const libraryHighlights = useMemo(() => highlights.map(toLibraryHighlight), [highlights])

  useEffect(
    () => () => {
      if (flashHintTimer.current !== null) window.clearTimeout(flashHintTimer.current)
    },
    [],
  )

  const showFlashHint = useCallback((message: string): void => {
    if (flashHintTimer.current !== null) window.clearTimeout(flashHintTimer.current)
    setFlashHint(message)
    flashHintTimer.current = window.setTimeout(() => {
      setFlashHint(null)
      flashHintTimer.current = null
    }, 5000)
  }, [])

  /** 由滚动位置推断当前页（viewer 的页面容器带 data-page-number）。 */
  const trackVisiblePage = useCallback(() => {
    const container = viewerRef.current
    if (container === null) return
    const pages = container.querySelectorAll<HTMLElement>('.page[data-page-number]')
    const threshold = container.getBoundingClientRect().top + 60
    for (const page of pages) {
      if (page.getBoundingClientRect().bottom > threshold) {
        const value = Number(page.dataset.pageNumber)
        if (Number.isFinite(value) && value > 0) {
          setPage(value)
          return
        }
      }
    }
  }, [setPage])

  /**
   * 跳页：直接对页面容器做 scrollIntoView。
   *
   * 为什么不用库提供的 `scrollRef(scrollTo)`：
   * 实测在当前容器里调用后 scrollTop 不变（它走 viewer.scrollPageIntoView + 合成 destArray，
   * 依赖 viewer 内部布局状态），15 页文档点目录完全不滚。
   * 自己滚动的好处：可测、可解释，Step 4「点节点 → PDF 锚点」也能复用同一套定位。
   */
  const scrollToPage = useCallback(
    (page: number): boolean => {
      const container = viewerRef.current
      if (container === null) return false
      if (!scrollPageIntoViewer(container, page)) return false
      setPage(page)
      return true
    },
    [setPage],
  )

  // 消费左栏的跳页请求。页面容器由 pdf.js 一次性创建，但仍做有限重试兜底。
  useEffect(() => {
    if (pendingScrollPage === null) return
    let cancelled = false
    let attempts = 0

    const tryScroll = (): void => {
      if (cancelled) return
      if (scrollToPage(pendingScrollPage)) {
        consumeScrollRequest()
        return
      }
      attempts += 1
      if (attempts < 25) window.setTimeout(tryScroll, 100)
    }

    tryScroll()
    return () => {
      cancelled = true
    }
  }, [pendingScrollPage, scrollToPage, consumeScrollRequest])

  // 点图谱节点跳过来时：自己把目标页滚进视口（懒渲染），等文本层就绪后高亮原文。
  // 必须等面板真正可见（centerTab === 'pdf'）再闪：切 Tab 会重渲染文本层，
  // 在切换那一帧加的高亮会被新一轮渲染冲掉（实测「闪了一下就没了」）。
  useEffect(() => {
    if (pendingFlash === null || centerTab !== 'pdf') return
    let cancelled = false
    let attempts = 0
    let scrolled = false
    let pageFlashed = false

    // 引文本身太短（如两个字）时，不必等 30 次重试才降级：直接整页闪 + 说明原因
    const searchable = isSearchableQuote(pendingFlash.quote)

    const tryFlash = (): void => {
      if (cancelled) return
      const container = viewerRef.current
      const pageElement =
        container?.querySelector<HTMLElement>(`.page[data-page-number="${pendingFlash.page}"]`) ?? null

      if (container === null || pageElement === null) {
        attempts += 1
        if (attempts < 100) {
          window.setTimeout(tryFlash, 100)
          return
        }
        // 目标页始终没渲染出来：至少给一条明确提示，不静默失败
        showFlashHint(`没能定位到第 ${pendingFlash.page} 页，PDF 可能仍在加载`)
        consumeFlashRequest()
        return
      }

      // 页面是懒渲染的：把它滚进视口才会生成文本层
      const spans = pageElement.querySelectorAll('.textLayer span').length
      if (spans === 0 && searchable) {
        if (!scrolled) {
          scrollPageIntoViewer(container, pendingFlash.page)
          scrolled = true
        }
        attempts += 1
        if (attempts < 100) {
          window.setTimeout(tryFlash, 100)
          return
        }
        // 文本层始终没出来（扫描页 / 渲染失败）：兜底整页闪并说明原因
        flashPageInView(container, pendingFlash.page)
        showFlashHint(`第 ${pendingFlash.page} 页没有可选中文本（可能是扫描页），已标出该页`)
        consumeFlashRequest()
        return
      }

      let matched = false
      if (searchable) {
        try {
          matched = flashQuoteInPage(container, pendingFlash.page, pendingFlash.quote)
        } catch {
          matched = false
        }
      }

      if (!matched) {
        // 目标页可能刚切过来还没完成布局（span 高度为 0，画不出框）：短暂重试，不急着降级
        attempts += 1
        if (searchable && attempts < 30) {
          if (!scrolled) {
            scrollPageIntoViewer(container, pendingFlash.page)
            scrolled = true
          }
          window.setTimeout(tryFlash, 120)
          return
        }
        if (!pageFlashed) {
          // 兜底：匹配不到时才整页闪，并明确告知（不假装命中）
          flashPageInView(container, pendingFlash.page)
          pageFlashed = true
          showFlashHint(
            searchable
              ? `已跳到第 ${pendingFlash.page} 页（这段引文未能逐字匹配，已标出该页）`
              : `引文「${pendingFlash.quote.slice(0, 12)}」太短，无法精确定位，已标出第 ${pendingFlash.page} 页`,
          )
        }
      }
      consumeFlashRequest()
    }

    tryFlash()
    return () => {
      cancelled = true
    }
  }, [pendingFlash, consumeFlashRequest, centerTab, showFlashHint])

  // 选中原文 → 自动成为下一条提问的 context chip（可删除）
  useEffect(() => {
    let timer: number | null = null
    const handler = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const container = viewerRef.current
        const selection = window.getSelection()
        if (container === null || selection === null) return
        const text = selection.toString().trim()
        if (text.length < 8) return
        const anchorNode = selection.anchorNode
        if (anchorNode === null || !container.contains(anchorNode)) return
        const chips = useChatStore.getState().contextChips
        if (chips.some((chip) => chip.text === text.slice(0, 300))) return
        useChatStore.getState().addContextChip({
          kind: 'selection',
          label: '选中原文',
          text: text.slice(0, 300),
          page: useDocumentStore.getState().pageNumber,
          nodeId: null,
          highlightId: null,
        })
      }, 350)
    }
    document.addEventListener('selectionchange', handler)
    return () => {
      document.removeEventListener('selectionchange', handler)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  return (
    <section data-testid="pdf-pane" className="flex h-full min-h-0 flex-col bg-akn-bg">
      <header className="flex items-center justify-between gap-2 border-b border-akn-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-[11px] font-semibold tracking-[0.18em] text-akn-muted uppercase">
            PDF 阅读区
          </h2>
          <span data-testid="document-name" className="truncate text-[11px] text-akn-muted/70">
            {activeDocument?.name ?? '未选择文件'}
          </span>
          {notice !== null ? (
            <span className="truncate rounded bg-akn-danger-soft px-1.5 py-0.5 text-[10px] text-akn-danger">
              {notice}
            </span>
          ) : null}
          {flashHint !== null ? (
            <span
              data-testid="pdf-flash-hint"
              className="max-w-[46ch] truncate rounded bg-akn-warn-soft px-1.5 py-0.5 text-[10px] text-akn-warn"
              title={flashHint}
            >
              {flashHint}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            data-testid="page-indicator"
            className="rounded bg-akn-raised px-2 py-0.5 font-mono text-[11px] text-akn-muted"
          >
            {activeDocument === null ? '—' : pageNumber} / {activeDocument?.pageCount ?? '—'}
          </span>
          <span
            data-testid="highlight-count"
            className="rounded bg-akn-raised px-2 py-0.5 font-mono text-[11px] text-akn-muted"
          >
            高亮 {highlights.length}
          </span>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {pdfDocument === null ? (
          <PanePlaceholder status={status} error={error} />
        ) : (
          <div ref={viewerRef} data-testid="pdf-viewer" className="absolute inset-0">
            <PdfHighlighter<IHighlight>
              pdfDocument={pdfDocument}
              highlights={libraryHighlights}
              pdfScaleValue="auto"
              enableAreaSelection={(event) => event.altKey}
              onScrollChange={trackVisiblePage}
              scrollRef={() => {
                // 库的滚动能力在本容器里不可用（见 scrollToPage 注释），保留空实现避免破坏类型契约。
              }}
              onSelectionFinished={(position, content, hideTipAndSelection) => (
                <HighlightTip
                  onCancel={hideTipAndSelection}
                  onConfirm={(comment) => {
                    void saveSelectionHighlight({ position, content, comment })
                      .then(() => {
                        setNotice(null)
                        hideTipAndSelection()
                      })
                      .catch((cause: unknown) => {
                        setNotice(cause instanceof Error ? cause.message : '高亮保存失败')
                        hideTipAndSelection()
                      })
                  }}
                />
              )}
              highlightTransform={(
                highlight,
                _index,
                setTip,
                hideTip,
                _viewportToScaled,
                _screenshot,
                isScrolledTo,
              ) => (
                <Highlight
                  isScrolledTo={isScrolledTo}
                  position={highlight.position}
                  comment={highlight.comment}
                  onClick={() => {
                    const highlightText = highlight.content?.text ?? ''
                    const linkedNode: LinkedNodeRef | null = (() => {
                      const found = findNodeByText(Object.values(useGraphStore.getState().nodesById), highlightText)
                      return found === null ? null : { id: found.id, title: found.title }
                    })()
                    setTip(highlight, (target) => (
                      <HighlightCommentEditor
                        highlightId={target.id}
                        initialComment={target.comment}
                        linkedNode={linkedNode}
                        onLocateNode={() => {
                          if (linkedNode === null) return
                          hideTip()
                          useUiStore.getState().setCenterTab('graph')
                          useGraphStore.getState().selectNode(linkedNode.id)
                          useGraphStore.getState().openLearning(linkedNode.id)
                        }}
                        onClose={hideTip}
                        onSave={(comment) => {
                          void saveHighlightComment(target.id, comment).then(hideTip)
                        }}
                        onDelete={() => {
                          void removeHighlight(target.id).then(hideTip)
                        }}
                      />
                    ))
                  }}
                />
              )}
            />
          </div>
        )}
      </div>
    </section>
  )
}

interface PanePlaceholderProps {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string | null
}

function PanePlaceholder({ status, error }: PanePlaceholderProps): ReactElement {
  if (status === 'loading') {
    return (
      <div className="grid h-full place-items-center">
        <p
          data-testid="pdf-loading"
          className="rounded-lg border border-akn-border bg-akn-panel/60 px-4 py-3 text-xs text-akn-muted"
        >
          正在解析 PDF 并建立目录…
        </p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="grid h-full place-items-center px-6">
        <div
          data-testid="pdf-error"
          className="max-w-md rounded-lg border border-akn-danger/50 bg-akn-danger-soft px-4 py-3 text-sm text-akn-danger"
        >
          <p className="font-medium">PDF 打开失败</p>
          <p className="mt-1 break-all text-xs text-akn-danger/90">{error ?? '未知错误'}</p>
          <div className="mt-3">
            <OpenPdfButton label="重新选择 PDF" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-full place-items-center px-6">
      <div
        data-testid="pdf-empty"
        className="flex max-w-md flex-col items-center rounded-xl border border-dashed border-akn-border/80 bg-akn-panel/30 px-6 py-10 text-center"
      >
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-akn-border bg-akn-panel text-lg">
          📄
        </div>
        <p className="mt-4 text-sm font-medium text-akn-ink/90">打开一份 PDF 开始阅读</p>
        <p className="mt-2 text-[11px] leading-relaxed text-akn-muted">
          文件只保存在本机 IndexedDB，不会上传到任何服务器。
          <br />
          支持目录跳转、划选高亮、备注，刷新后原样恢复。
        </p>
        <div className="mt-4">
          <OpenPdfButton />
        </div>
        <p className="mt-3 text-[10px] text-akn-muted/60">
          测试素材：fixtures/attention-is-all-you-need.pdf
        </p>
      </div>
    </div>
  )
}
