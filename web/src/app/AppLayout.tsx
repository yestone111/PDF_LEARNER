import { useEffect, useRef } from 'react'

import { restoreLastDocument } from '../pdf/pdfController'
import { useUiStore } from '../stores/uiStore'
import { AppFooter } from './AppFooter'
import { TopBar } from './TopBar'
import { Splitter } from './layout/Splitter'
import { LAYOUT_LIMITS } from './layout/layoutMath'
import { usePanelResize } from './layout/usePanelResize'
import { CenterPane } from './panels/CenterPane'
import { LeftSidebar } from './panels/LeftSidebar'
import { RightDock } from './panels/RightDock'

import type { ReactElement } from 'react'

/** 模块级标记：确保「恢复上次文档」只执行一次。 */
let bootstrapped = false

/**
 * 三栏骨架：目录 | PDF | AI/笔记。
 *
 * 布局用 CSS Grid 固定两侧像素、中间 `minmax(360px, 1fr)`：
 * 中间最小宽度由浏览器保证，拖拽算出的宽度由 layoutMath 再兜一层，
 * 两层保险避免「窗口变窄 + 脏持久化」把 PDF 区压成 0。
 */
export function AppLayout(): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const theme = useUiStore((state) => state.theme)
  const leftWidth = useUiStore((state) => state.panelWidths.left)
  const rightWidth = useUiStore((state) => state.panelWidths.right)
  const rightCollapsed = useUiStore((state) => state.rightCollapsed)
  const setRightCollapsed = useUiStore((state) => state.setRightCollapsed)
  const { dragging, beginResize, nudge } = usePanelResize(containerRef)

  // 主题：写到 <html data-theme>，CSS 变量随之整体切换（组件无需感知）
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // 启动时恢复上次打开的文档（文档本体在 IndexedDB，指针在 localStorage）。
  // StrictMode 下 effect 会跑两次，这里用模块级标记防重复解析（解析 PDF 很贵）。
  useEffect(() => {
    if (bootstrapped) return
    bootstrapped = true
    void restoreLastDocument()
  }, [])

  // 窗口尺寸变化后，两侧宽度必须重新钳制（否则 grid 会溢出到看不见的地方）。
  // 观察的是 grid 自身（而不是外层布局盒）：grid 有 1px 边框，
  // 其 clientWidth 才是「左右中三栏真正可用的像素」，用外层宽度会多算 2px 边框导致溢出。
  useEffect(() => {
    const element = containerRef.current
    if (element === null) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      useUiStore.getState().clampPanelWidthsToContainer(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex h-full flex-col bg-akn-bg text-akn-ink">
      <TopBar />

      <div data-testid="layout-root" className="min-h-0 flex-1 p-3">
        <div
          ref={containerRef}
          data-testid="layout-grid"
          className="relative grid h-full min-h-0 overflow-hidden rounded-xl border border-akn-border shadow-2xl"
          style={{
            gridTemplateColumns: rightCollapsed
              ? `${leftWidth}px ${LAYOUT_LIMITS.splitter}px minmax(${LAYOUT_LIMITS.center.min}px, 1fr)`
              : `${leftWidth}px ${LAYOUT_LIMITS.splitter}px minmax(${LAYOUT_LIMITS.center.min}px, 1fr) ${LAYOUT_LIMITS.splitter}px ${rightWidth}px`,
          }}
        >
          <LeftSidebar />
          <Splitter
            side="left"
            dragging={dragging === 'left'}
            onPointerDown={beginResize('left')}
            onNudge={(direction) => nudge('left', direction)}
          />
          <CenterPane />
          {rightCollapsed ? null : (
            <Splitter
              side="right"
              dragging={dragging === 'right'}
              onPointerDown={beginResize('right')}
              onNudge={(direction) => nudge('right', direction)}
            />
          )}
          <RightDock />
          {rightCollapsed ? (
            <button
              type="button"
              data-testid="right-dock-expand"
              onClick={() => setRightCollapsed(false)}
              title="展开右侧栏（AI 伴读 / 笔记）"
              aria-label="展开右侧栏（AI 伴读 / 笔记）"
              className="absolute top-1/2 right-2 z-20 -translate-y-1/2 rounded-full border border-akn-border bg-akn-panel px-1.5 py-2 text-[10px] text-akn-muted shadow transition-colors hover:border-akn-accent/60 hover:text-akn-ink"
            >
              <span className="block leading-[10px] [writing-mode:vertical-rl]">« 伴读 / 笔记</span>
            </button>
          ) : null}
        </div>
      </div>

      <AppFooter />
    </div>
  )
}
