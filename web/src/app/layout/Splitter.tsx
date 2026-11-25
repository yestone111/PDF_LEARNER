import type { KeyboardEvent, PointerEvent, ReactElement } from 'react'

import type { PanelSide } from './layoutMath'

interface SplitterProps {
  side: PanelSide
  dragging: boolean
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onNudge: (direction: -1 | 1) => void
}

const LABELS: Record<PanelSide, string> = {
  left: '调整左栏（文档目录）宽度',
  right: '调整右栏（AI 伴读 / 笔记）宽度',
}

/**
 * 竖向分隔条。
 * - 鼠标/触控：pointerdown 后由 usePanelResize 接管 window 上的 move/up；
 * - 键盘：获得焦点后 ←/→ 微调 16px（可访问性，也便于自动化验收）；
 * - 视觉：6px 细条，hover / 拖拽时高亮，中间一条 grip 线。
 */
export function Splitter({ side, dragging, onPointerDown, onNudge }: SplitterProps): ReactElement {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    // 左栏：→ 变宽；右栏：← 变宽（分隔条朝各自面板方向移动）
    const direction: -1 | 1 = event.key === 'ArrowRight' ? 1 : -1
    onNudge(side === 'left' ? direction : direction === 1 ? -1 : 1)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={LABELS[side]}
      tabIndex={0}
      data-testid={`splitter-${side}`}
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onKeyDown={handleKeyDown}
      className={[
        'group relative flex h-full cursor-col-resize touch-none items-center justify-center',
        'bg-akn-border/40 outline-none transition-colors',
        'hover:bg-akn-accent/50 focus-visible:bg-akn-accent/60',
        dragging ? 'bg-akn-accent/70' : '',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'h-10 w-[2px] rounded-full transition-colors',
          dragging ? 'bg-akn-accent' : 'bg-akn-muted/40 group-hover:bg-akn-accent',
        ].join(' ')}
      />
    </div>
  )
}
