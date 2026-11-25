import { useCallback, useEffect, useRef, useState } from 'react'

import { useUiStore } from '../../stores/uiStore'
import { KEYBOARD_STEP, clampLeftWidth, clampRightWidth, type PanelSide } from './layoutMath'

import type { RefObject } from 'react'

export interface PanelResizeApi {
  /** 正在拖拽的栏（用于给分隔条/面板加高亮态）。 */
  dragging: PanelSide | null
  beginResize: (side: PanelSide) => (event: React.PointerEvent<HTMLDivElement>) => void
  /** 键盘微调：direction=+1 表示让该栏变宽。 */
  nudge: (side: PanelSide, direction: -1 | 1) => void
}

/**
 * 栏宽拖拽。全部计算走 layoutMath 纯函数，组件只负责事件接线。
 *
 * 为什么不用 React state 存「拖拽中的宽度」：
 * 拖拽是高频事件，写入 zustand 已足够（3 个订阅点），
 * 但 clamp 必须用 store 里的实时值，否则两侧会互相算出负空间。
 */
export function usePanelResize(containerRef: RefObject<HTMLDivElement | null>): PanelResizeApi {
  const [dragging, setDragging] = useState<PanelSide | null>(null)
  /** 当前这次拖拽的清理函数（组件卸载 / 重新按下时先清掉上一次）。 */
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      stopRef.current?.()
    }
  }, [])

  const applyWidth = useCallback(
    (side: PanelSide, desired: number, containerWidth: number) => {
      const { panelWidths, setPanelWidth } = useUiStore.getState()
      const next =
        side === 'left'
          ? clampLeftWidth(desired, containerWidth, panelWidths.right)
          : clampRightWidth(desired, containerWidth, panelWidths.left)
      setPanelWidth(side, next)
    },
    [],
  )

  const beginResize = useCallback(
    (side: PanelSide) => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      stopRef.current?.()

      const startX = event.clientX
      const { panelWidths } = useUiStore.getState()
      const startWidth = side === 'left' ? panelWidths.left : panelWidths.right
      const containerWidth = containerRef.current?.clientWidth ?? window.innerWidth
      setDragging(side)

      const onMove = (moveEvent: PointerEvent): void => {
        const delta = moveEvent.clientX - startX
        // 左栏向右拖变宽；右栏向左拖变宽，所以取反。
        applyWidth(side, side === 'left' ? startWidth + delta : startWidth - delta, containerWidth)
      }

      const stop = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        stopRef.current = null
        setDragging(null)
      }

      stopRef.current = stop
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    },
    [applyWidth, containerRef],
  )

  const nudge = useCallback(
    (side: PanelSide, direction: -1 | 1) => {
      const containerWidth = containerRef.current?.clientWidth ?? window.innerWidth
      const { panelWidths } = useUiStore.getState()
      const current = side === 'left' ? panelWidths.left : panelWidths.right
      applyWidth(side, current + direction * KEYBOARD_STEP, containerWidth)
    },
    [applyWidth, containerRef],
  )

  return { dragging, beginResize, nudge }
}
