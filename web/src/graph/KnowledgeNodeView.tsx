import { Handle, Position } from 'reactflow'

import { MASTERY_LABELS, MASTERY_NEXT } from '../domain/enums'
import { neutralNodeStyle, nodeStyle } from '../domain/nodeStyle'

import type { NodeProps } from 'reactflow'
import type { ReactElement } from 'react'
import type { MasteryState } from '../domain/enums'
import type { Importance } from '../domain/enums'

export interface KnowledgeNodeData {
  readonly nodeId: string
  readonly label: string
  readonly level: number
  readonly difficulty: Importance
  /** 关联程度（连边数），决定尺寸。 */
  readonly degree: number
  /** 椭圆长轴（按标题估算，保证文字不出框）。 */
  readonly width: number
  /** 椭圆短轴（由关联度算好放进 data，避免在节点组件里重复计算）。 */
  readonly height: number
  readonly mastery: MasteryState
  readonly importanceSource: string
  /** 图表/表格占位节点（没有逐字引文，跳转按 caption 定位）。 */
  readonly hasFigure: boolean
  readonly dimmed: boolean
  readonly selected: boolean
  readonly onToggleMastery: (nodeId: string) => void
}

/**
 * 图谱节点。尺寸与配色**只**来自 nodeStyle()/neutralNodeStyle()，
 * 这里不允许出现任何手写色值（模块一第 4 条的硬性要求）。
 */
export function KnowledgeNodeView({ data }: NodeProps<KnowledgeNodeData>): ReactElement {
  const style =
    data.importanceSource === 'none' ? neutralNodeStyle() : nodeStyle(data.difficulty, data.mastery)

  return (
    <div
      data-testid={`graph-node-${data.nodeId}`}
      data-mastery={data.mastery}
      data-difficulty={data.difficulty}
      data-degree={data.degree}
      data-importance-source={data.importanceSource}
      data-figure={data.hasFigure ? 'true' : 'false'}
      data-selected={data.selected ? 'true' : 'false'}
      title={data.label}
      className="relative flex items-center justify-center rounded-[50%] border-2 text-center transition-opacity"
      style={{
        width: data.width,
        height: data.height,
        background: style.fill,
        borderColor: style.stroke,
        color: style.textColor,
        fontSize: style.fontSize,
        opacity: data.dimmed ? 0.18 : 1,
        boxShadow: data.selected
          ? '0 0 0 3px var(--color-akn-accent), 0 10px 28px rgba(0,0,0,0.45)'
          : data.dimmed
            ? 'none'
            : '0 8px 24px rgba(0,0,0,0.35)',
      }}
    >
      {/*
        层级角标：贴在椭圆左上 45° 切点的外侧。
        椭圆参数方程在 135° 处的点是 (14.6% 宽, 14.6% 高)——**与宽高比无关**，
        所以这个百分比对任何尺寸的椭圆都落在同一条切点上；
        再沿对角线外推 4px，角标既贴着节点、又绝不压边框线（也不压节点文字）。
      */}
      <span
        data-testid={`node-level-${data.nodeId}`}
        data-level={data.level}
        className="pointer-events-none absolute z-10 rounded-full border border-akn-border bg-akn-panel px-1 text-[9px] leading-[14px] font-semibold text-akn-muted select-none"
        style={{ left: '14.6%', top: '14.6%', transform: 'translate(-100%, -100%) translate(-4px, -4px)' }}
      >
        L{data.level}
      </span>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      {/* 椭圆内再收一圈：文字最多两行，超出用省略号，绝不出框 */}
      <span
        data-testid={`node-label-${data.nodeId}`}
        className="pointer-events-none line-clamp-2 max-h-[72%] w-[78%] overflow-hidden leading-tight font-medium break-words"
      >
        {data.label}
      </span>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <button
        type="button"
        data-testid={`mastery-${data.nodeId}`}
        title={`当前：${MASTERY_LABELS[data.mastery]} · 点击标为「${MASTERY_LABELS[MASTERY_NEXT[data.mastery]]}」`}
        data-next-mastery={MASTERY_NEXT[data.mastery]}
        onClick={(event) => {
          event.stopPropagation()
          data.onToggleMastery(data.nodeId)
        }}
        className="absolute -right-1.5 -bottom-1.5 z-10 grid h-5 w-5 place-items-center rounded-full border border-akn-border bg-akn-panel text-[10px] text-akn-ink shadow"
      >
        {data.mastery === 'mastered' ? '✓' : data.mastery === 'doubt' ? '?' : '○'}
      </button>
    </div>
  )
}
