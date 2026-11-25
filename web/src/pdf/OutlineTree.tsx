import { useMemo } from 'react'

import { assembleOutlineTree } from './outline'
import { outlineNumbersFromTree, outlineTitleHasNumber } from './outlineNumbering'

import type { ChapterMasteryState, ChapterProgress } from '../graph/chapterProgress'
import type { OutlineNode } from '../domain'
import type { ReactElement } from 'react'

interface OutlineTreeProps {
  readonly nodes: readonly OutlineNode[]
  readonly onSelect: (node: OutlineNode) => void
  readonly selectedPage: number | null
  /** 每章的掌握度（圆圈状态 + 计数）；缺省时全部按「未开始」显示。 */
  readonly progress?: ReadonlyMap<string, ChapterProgress>
  /** 已加书签的章节 id 集合。 */
  readonly bookmarked?: ReadonlySet<string>
  /** 点星：加/取消书签。不传则星标只显示不可点。 */
  readonly onToggleBookmark?: (node: OutlineNode) => void
}

const EMPTY_PROGRESS: ChapterProgress = { state: 'none', total: 0, mastered: 0 }

/**
 * 目录树。层级用缩进 + 左侧竖线表达（不用折叠交互，先把「能跳页」做对）。
 * 页码为 null 的条目：可读但不可跳 —— 显式降级，不编造页码。
 *
 * 每行左侧的小圆点表示「这一章掌握到哪了」（用户定义的三种状态）：
 *   实心绿圈 = 本章知识点全部掌握；半绿圈 = 掌握了一部分；灰色空心圈 = 没开始。
 * 行尾的星标 = 章节书签（下次打开这份文档会直接跳到最近钉住的那一章）。
 */
export function OutlineTree({
  nodes,
  onSelect,
  selectedPage,
  progress,
  bookmarked,
  onToggleBookmark,
}: OutlineTreeProps): ReactElement {
  const tree = useMemo(() => assembleOutlineTree(nodes), [nodes])
  // 章节标志：按**树的结构**做 DFS 编号（1 / 1.1 / 2）。
  // 不能用扁平数组顺序：存储层按 level 排序，一级全在前、二级在后，
  // 扁平编号会让「第一章的小节」变成 8.1（真实踩坑）。
  const numberById = useMemo(() => outlineNumbersFromTree(tree), [tree])
  const progressById = progress ?? new Map<string, ChapterProgress>()
  const bookmarkedIds = bookmarked ?? new Set<string>()

  return (
    <ul data-testid="outline-tree" className="space-y-0.5">
      {tree.map((entry) => (
        <OutlineBranch
          key={entry.node.id}
          entry={entry}
          onSelect={onSelect}
          selectedPage={selectedPage}
          depth={0}
          number={numberById.get(entry.node.id) ?? ''}
          numberById={numberById}
          progress={progressById}
          bookmarked={bookmarkedIds}
          onToggleBookmark={onToggleBookmark}
        />
      ))}
    </ul>
  )
}

interface BranchProps {
  readonly entry: ReturnType<typeof assembleOutlineTree>[number]
  readonly onSelect: (node: OutlineNode) => void
  readonly selectedPage: number | null
  readonly depth: number
  readonly number: string
  readonly numberById: ReadonlyMap<string, string>
  readonly progress: ReadonlyMap<string, ChapterProgress>
  readonly bookmarked: ReadonlySet<string>
  readonly onToggleBookmark?: (node: OutlineNode) => void
}

/** 掌握度圆圈（图例里也复用它，保证目录与图例是同一套视觉）。 */
export function ChapterMasteryDot({
  progress,
  nodeId,
  showTestId = true,
}: {
  readonly progress: ChapterProgress
  readonly nodeId?: string
  readonly showTestId?: boolean
}): ReactElement {
  const title = describeProgress(progress)
  const style: Record<string, string> = {}
  if (progress.state === 'complete') {
    style.background = 'var(--color-akn-ok)'
    style.borderColor = 'var(--color-akn-ok)'
  } else if (progress.state === 'partial') {
    // 一半实心一半空心
    style.background = 'linear-gradient(90deg, var(--color-akn-ok) 50%, transparent 50%)'
    style.borderColor = 'var(--color-akn-ok)'
  }
  return (
    <span
      {...(showTestId && nodeId !== undefined ? { 'data-testid': `outline-progress-${nodeId}` } : {})}
      data-state={progress.state}
      title={title}
      aria-label={title}
      className={[
        'inline-block h-3 w-3 shrink-0 rounded-full border',
        progress.state === 'none' ? 'border-akn-muted/40' : '',
      ].join(' ')}
      style={style}
    />
  )
}

/**
 * 书签图标：绸带形状 —— 上边是平的，下边剪掉一个三角缺口（缺口顶点朝上）。
 * 已加书签 = 实心（currentColor 填充）；未加 = 空心描边，鼠标悬停才变主题色。
 */
export function BookmarkRibbon({
  filled,
  className = 'h-3.5 w-3.5',
}: {
  readonly filled: boolean
  readonly className?: string
}): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className}
      data-filled={filled ? 'true' : 'false'}
    >
      <path
        d="M6 3h12v18l-6-4.5L6 21z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={filled ? 1 : 1.7}
        strokeLinejoin="round"
      />
    </svg>
  )
}

function describeProgress(progress: ChapterProgress): string {
  if (progress.total === 0) return '本章暂无知识点'
  if (progress.state === 'complete') return `本章已全部掌握（${progress.mastered}/${progress.total}）`
  if (progress.state === 'partial') return `已掌握 ${progress.mastered}/${progress.total}`
  return `尚未掌握任何知识点（0/${progress.total}）`
}

function rowTitle(node: OutlineNode, progress: ChapterProgress, isBookmarked: boolean): string {
  const base = node.page === null ? `${node.title}（未解析到页码）` : `${node.title}（第 ${node.page} 页）`
  const parts = [base, describeProgress(progress)]
  if (isBookmarked) parts.push('已加书签')
  return parts.join(' · ')
}

function OutlineBranch({
  entry,
  onSelect,
  selectedPage,
  depth,
  number,
  numberById,
  progress,
  bookmarked,
  onToggleBookmark,
}: BranchProps): ReactElement {
  const { node, children } = entry
  const isActive = selectedPage !== null && node.page === selectedPage
  const jumpable = node.page !== null
  const chapterProgress = progress.get(node.id) ?? EMPTY_PROGRESS
  const isBookmarked = bookmarked.has(node.id)

  return (
    <li>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          data-testid={`outline-item-${node.id}`}
          data-page={node.page ?? ''}
          data-level={node.level}
          data-progress={chapterProgress.state}
          disabled={!jumpable}
          onClick={() => {
            if (jumpable) onSelect(node)
          }}
          title={rowTitle(node, chapterProgress, isBookmarked)}
          className={[
            'flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors',
            jumpable ? 'hover:bg-akn-raised' : 'cursor-not-allowed opacity-60',
            isActive ? 'bg-akn-accent/15 text-akn-ink' : 'text-akn-muted',
          ].join(' ')}
          style={{ paddingLeft: `${6 + depth * 12}px` }}
          data-outline-number={number}
          data-number-shown={number !== '' && !outlineTitleHasNumber(node.title) ? '1' : '0'}
        >
          <ChapterMasteryDot progress={chapterProgress} nodeId={node.id} />
          {number !== '' && !outlineTitleHasNumber(node.title) ? (
            <span
              data-testid={`outline-number-${node.id}`}
              className="shrink-0 font-mono text-[9px] tabular-nums text-akn-muted/60"
            >
              {number}
            </span>
          ) : null}
          {node.level === 1 ? (
            <span className="shrink-0 rounded bg-akn-accent/15 px-1 text-[9px] font-medium text-akn-accent">
              章
            </span>
          ) : null}
          <span
            data-outline-title={node.title}
            className={[
              'min-w-0 flex-1 truncate',
              node.level === 1 ? 'font-semibold text-akn-ink/90' : '',
            ].join(' ')}
          >
            {node.title}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-akn-muted/60">
            {node.page ?? '—'}
          </span>
        </button>
        <button
          type="button"
          data-testid={`bookmark-toggle-${node.id}`}
          data-bookmarked={isBookmarked ? 'true' : 'false'}
          disabled={!jumpable}
          onClick={() => onToggleBookmark?.(node)}
          title={
            isBookmarked
              ? '取消这一章的书签'
              : jumpable
                ? '给这一章加书签（下次打开会直接跳到这里）'
                : '这一章没有解析到页码，不能加书签'
          }
          aria-label={isBookmarked ? `取消书签：${node.title}` : `加书签：${node.title}`}
          className={[
            'shrink-0 rounded px-1 py-0.5 transition-colors',
            isBookmarked ? 'text-akn-accent' : 'text-akn-muted/45',
            jumpable ? 'hover:bg-akn-raised hover:text-akn-accent' : 'cursor-not-allowed opacity-30',
          ].join(' ')}
        >
          <BookmarkRibbon filled={isBookmarked} />
        </button>
      </div>

      {children.length > 0 ? (
        <ul className="ml-2 border-l border-akn-border/50">
          {children.map((child) => (
            <OutlineBranch
              key={child.node.id}
              entry={child}
              onSelect={onSelect}
              selectedPage={selectedPage}
              depth={depth + 1}
              number={numberById.get(child.node.id) ?? ''}
              numberById={numberById}
              progress={progress}
              bookmarked={bookmarked}
              onToggleBookmark={onToggleBookmark}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
