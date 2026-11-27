import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { Background, Controls, MarkerType, useReactFlow } from 'reactflow'

import { COGNITIVE_LEVEL_LABELS, MASTERY_LABELS, RELATION_EDGE_COLORS } from '../domain/enums'
import { nodeDiameter, nodeWidth } from '../domain/nodeStyle'
import { summarizeChapter, readCachedChapterSummary } from '../llm/pipeline/chapterSummary'
import { extractChapterGraph, extractWholeDocument } from '../llm/pipeline/controller'
import { useChatStore } from '../stores/chatStore'
import { useDocumentStore } from '../stores/documentStore'
import { useGraphStore } from '../stores/graphStore'
import { KnowledgeNodeView, type KnowledgeNodeData } from './KnowledgeNodeView'
import { NodeLearningDialog } from './NodeLearningDialog'
import { toggleNodeMastery } from './graphActions'
import { annotateSummary } from './summaryKeywords'
import { layeredLayout } from './layout'
import { gateUnits } from '../llm/pipeline/unitGate'

import type { Edge, Node, NodeTypes } from 'reactflow'
import type { ReactElement } from 'react'
import type { KnowledgeNode } from '../domain'

const NODE_TYPES: NodeTypes = { knowledge: KnowledgeNodeView }

/** 一次「把某个点移到画布中心」的请求；nonce 让连点同一项也能重新居中。 */
interface FocusRequest {
  readonly x: number
  readonly y: number
  readonly nonce: number
}

/**
 * 把视图平滑移到指定 flow 坐标。
 *
 * 必须是 <ReactFlow> 的子组件才能拿到实例上下文（useReactFlow 依赖内部 provider），
 * 所以单独抽出来，不污染 GraphView 顶层逻辑。
 */
function FocusOnNode({ request }: { readonly request: FocusRequest | null }): null {
  const { setCenter, getZoom } = useReactFlow()
  useEffect(() => {
    if (request === null) return
    // 尊重「减少动态效果」：动画时长归零，位置照样居中新
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // 保持当前缩放：只平移不缩放，用户自己决定的视野别被改
    void setCenter(request.x, request.y, { zoom: getZoom(), duration: reduced ? 0 : 320 })
  }, [request, setCenter, getZoom])
  return null
}

/**
 * 两组图谱（对应产品定义）：
 *  ① 全文档总览：核心知识点，从左到右按「依赖方向」排列（脑图式）；
 *  ② 章节拆解：同一套视觉语言，但更细，节点锚定到原文核心点。
 *
 * 视觉语义（唯一来源 nodeStyle.ts）：
 *  大小 = 关联程度（连边数）· 颜色深浅 = 掌握难度 · 红/绿 = 未掌握/已掌握。
 */
export function GraphView(): ReactElement {
  const nodesById = useGraphStore((state) => state.nodesById)
  const edgesById = useGraphStore((state) => state.edgesById)
  const selectedNodeId = useGraphStore((state) => state.selectedNodeId)
  const learningNodeId = useGraphStore((state) => state.learningNodeId)
  const selectNode = useGraphStore((state) => state.selectNode)
  const openLearning = useGraphStore((state) => state.openLearning)
  const extraction = useGraphStore((state) => state.extraction)
  const mock = useGraphStore((state) => state.mock)

  const activeDocument = useDocumentStore((state) => state.document)
  const outline = useDocumentStore((state) => state.outline)
  const selectedChapterId = useDocumentStore((state) => state.selectedChapterId)
  const selectChapter = useDocumentStore((state) => state.selectChapter)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chapterSummary, setChapterSummary] = useState<string>('')
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [summaryMock, setSummaryMock] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryPos, setSummaryPos] = useState(() => ({
    x: Math.max(24, Math.round(window.innerWidth * 0.42)),
    y: 140,
  }))
  const summaryDragRef = useRef<{ dx: number; dy: number } | null>(null)

  const chapter =
    selectedChapterId === null ? null : (outline.find((node) => node.id === selectedChapterId) ?? null)
  const allNodes = useMemo(() => Object.values(nodesById), [nodesById])
  const allEdges = useMemo(() => Object.values(edgesById), [edgesById])

  const visibleNodes = useMemo(
    () =>
      chapter === null
        ? allNodes.filter((node) => node.scope === 'global')
        : allNodes.filter((node) => node.chapterId === chapter.id),
    [allNodes, chapter],
  )
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes])
  const visibleEdges = useMemo(
    () => allEdges.filter((edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)),
    [allEdges, visibleIds],
  )

  // 关联程度 = 入边 + 出边（同一条边只算一次）
  const degrees = useMemo(() => {
    const result = new Map<string, number>()
    for (const edge of visibleEdges) {
      result.set(edge.sourceId, (result.get(edge.sourceId) ?? 0) + 1)
      result.set(edge.targetId, (result.get(edge.targetId) ?? 0) + 1)
    }
    return result
  }, [visibleEdges])

  const degreesOf = useCallback((nodeId: string) => degrees.get(nodeId) ?? 0, [degrees])

  // 上下游：点任意节点 → 展示前置依赖/后置影响，弱化其余节点**与连线**
  const upstream = useMemo(
    () => (selectedNodeId === null ? [] : visibleEdges.filter((edge) => edge.targetId === selectedNodeId)),
    [visibleEdges, selectedNodeId],
  )
  const downstream = useMemo(
    () => (selectedNodeId === null ? [] : visibleEdges.filter((edge) => edge.sourceId === selectedNodeId)),
    [visibleEdges, selectedNodeId],
  )
  const relatedIds = useMemo(() => {
    const ids = new Set<string>()
    if (selectedNodeId !== null) ids.add(selectedNodeId)
    for (const edge of upstream) ids.add(edge.sourceId)
    for (const edge of downstream) ids.add(edge.targetId)
    return ids
  }, [selectedNodeId, upstream, downstream])

  // 尺寸参考度数：用当前图的最大度数，稀疏图里也能看出大小差异
  const maxDegree = useMemo(() => Math.max(0, ...degrees.values()), [degrees])
  const referenceDegree = Math.max(2, maxDegree)

  const sizeOf = useCallback(
    (node: KnowledgeNode) => {
      const degree = degreesOf(node.id)
      const height = nodeDiameter(degree, referenceDegree)
      return { width: nodeWidth(height), height }
    },
    [degreesOf, referenceDegree],
  )

  // 速览里的关键词 → 图谱节点（标题/别名命中），点击联动选中
  const summarySegments = useMemo(
    () =>
      annotateSummary(
        chapterSummary,
        visibleNodes.map((node) => ({ id: node.id, title: node.title, aliases: node.aliases })),
      ),
    [chapterSummary, visibleNodes],
  )

  // 切章节时读取缓存过的速览（没有就显示「整理」按钮，不自动调模型省钱）
  useEffect(() => {
    setSummaryError(null)
    setSummaryMock(false)
    if (chapter === null || activeDocument === null) {
      setChapterSummary('')
      return
    }
    setChapterSummary(readCachedChapterSummary(activeDocument.id, chapter.id) ?? '')
  }, [chapter, activeDocument])

  const startSummaryDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    // 点在按钮上时不要启动拖拽：setPointerCapture 会抢走 pointerup，
    // 导致 ✕ / 重新整理 的 click 永远不触发（真实鼠标踩到过，验收用 .click() 反而漏了）。
    const target = event.target as HTMLElement | null
    if (target !== null && target.closest('button') !== null) return
    summaryDragRef.current = { dx: event.clientX - summaryPos.x, dy: event.clientY - summaryPos.y }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 合成事件/不支持的浏览器没有活跃指针：忽略即可，拖拽仍按 clientX/Y 计算
    }
  }

  const moveSummaryDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = summaryDragRef.current
    if (drag === null) return
    const maxX = Math.max(24, window.innerWidth - 260)
    const maxY = Math.max(24, window.innerHeight - 120)
    setSummaryPos({
      x: Math.min(maxX, Math.max(8, event.clientX - drag.dx)),
      y: Math.min(maxY, Math.max(8, event.clientY - drag.dy)),
    })
  }

  const endSummaryDrag = (): void => {
    summaryDragRef.current = null
  }

  const generateSummary = async (): Promise<void> => {
    if (chapter === null || summaryLoading) return
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      const result = await summarizeChapter(chapter.id)
      setChapterSummary(result.summary)
      setSummaryMock(result.mock && !result.cached)
    } catch (cause) {
      setSummaryError(cause instanceof Error ? cause.message : '整理失败，请重试')
    } finally {
      setSummaryLoading(false)
    }
  }

  // 学习路径：按认知层级 → 拓扑深度排序（PICA 闸门同时给出违规信息）
  const learningPath = useMemo(
    () =>
      gateUnits(
        visibleNodes.map((node) => ({
          id: node.id,
          title: node.title,
          titleNorm: node.titleNorm,
          summary: node.summary,
          cognitiveLevel: node.cognitiveLevel,
          priorKnowledge: node.priorKnowledge,
        })),
        visibleEdges.map((edge) => ({
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          relationType: edge.relationType,
        })),
      ),
    [visibleNodes, visibleEdges],
  )

  // 左 → 右按依赖层级排列（脑图式），层内过多自动折列
  const layout = useMemo(
    () =>
      layeredLayout(
        visibleNodes.map((node) => ({
          id: node.id,
          title: node.title,
          degree: degreesOf(node.id),
          ...sizeOf(node),
        })),
        visibleEdges.map((edge) => ({ source: edge.sourceId, target: edge.targetId })),
      ),
    [visibleNodes, visibleEdges, degreesOf, sizeOf],
  )

  const rfNodes: Node<KnowledgeNodeData>[] = useMemo(
    () =>
      visibleNodes.map((node) => {
        const degree = degreesOf(node.id)
        const { width, height } = sizeOf(node)
        const position = layout.positions.get(node.id) ?? { x: 0, y: 0 }
        return {
          id: node.id,
          type: 'knowledge',
          position,
          style: { width, height },
          data: {
            nodeId: node.id,
            label: node.title,
            level: node.cognitiveLevel,
            difficulty: node.difficulty,
            degree,
            width,
            height,
            mastery: node.mastery,
            importanceSource: node.importanceSource,
            hasFigure: node.figure !== null,
            dimmed: selectedNodeId !== null && !relatedIds.has(node.id),
            selected: selectedNodeId === node.id,
            onToggleMastery: (nodeId: string) => {
              void toggleNodeMastery(nodeId)
            },
          },
        }
      }),
    [visibleNodes, layout, selectedNodeId, relatedIds, degreesOf, sizeOf],
  )

  // 「点路径/关键词 → 把该知识点移到画布中心」：请求里直接带好 flow 坐标，
  // 避免依赖 boxes 的引用变化导致重复居中。
  const focusNonce = useRef(0)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const focusNode = useCallback(
    (nodeId: string) => {
      const target = rfNodes.find((item) => item.id === nodeId)
      if (target === undefined) return
      focusNonce.current += 1
      setFocusRequest({
        x: target.position.x + target.data.width / 2,
        y: target.position.y + target.data.height / 2,
        nonce: focusNonce.current,
      })
    },
    [rfNodes],
  )

  const rfEdges: Edge[] = useMemo(
    () =>
      visibleEdges.map((edge) => {
        const color = RELATION_EDGE_COLORS[edge.relationType]
        // 选中节点后：不相关的线（两端不在「选中 + 直接上下游」里）一起暗下去，
        // 只靠节点变暗会让边显得悬空。line + 标签 + 标签底一起降透明度。
        const highlighted =
          selectedNodeId === null ||
          (relatedIds.has(edge.sourceId) && relatedIds.has(edge.targetId))
        const edgeOpacity = highlighted ? 1 : 0.12
        const labelOpacity = highlighted ? 1 : 0.15
        return {
          id: edge.id,
          source: edge.sourceId,
          target: edge.targetId,
          label: edge.relationLabel,
          type: 'smoothstep',
          // 给验收一个稳定的钩子：相关/不相关边的类名（用户可见的弱化效果靠 opacity 实现）
          className: highlighted ? 'akn-edge-related' : 'akn-edge-dimmed',
          style: {
            stroke: color,
            strokeWidth: 3,
            opacity: edgeOpacity,
            filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.35))',
          },
          labelStyle: { fill: 'var(--akn-ink)', fontSize: 10, opacity: labelOpacity },
          labelBgStyle: { fill: 'var(--akn-panel)', fillOpacity: highlighted ? 0.9 : 0 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 20, height: 20 },
        }
      }),
    [visibleEdges, selectedNodeId, relatedIds],
  )

  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      selectNode(node.id)
      // 图谱优先学习流：点知识点 → 直接打开学习对话框（看描述 / 继续学 / 跳原文）
      openLearning(node.id)
      // 点节点 = 把该节点作为下一条提问的 context（模块四第 2 条）
      const knowledge = useGraphStore.getState().nodesById[node.id]
      if (knowledge === undefined) return
      const chips = useChatStore.getState().contextChips
      if (chips.some((chip) => chip.nodeId === knowledge.id)) return
      useChatStore.getState().addContextChip({
        kind: 'node',
        label: '图谱节点',
        text: knowledge.title,
        page: knowledge.anchor?.page ?? null,
        nodeId: knowledge.id,
        highlightId: null,
      })
    },
    [selectNode, openLearning],
  )

  const runExtraction = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      if (chapter === null) await extractWholeDocument()
      else await extractChapterGraph(chapter.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const enterChapterMode = (): void => {
    if (selectedChapterId !== null) return
    const first = outline[0]
    if (first !== undefined) selectChapter(first.id)
  }

  return (
    <section data-testid="graph-pane" className="flex h-full min-h-0 flex-col bg-akn-bg">
      <header className="flex flex-wrap items-center gap-2 border-b border-akn-border px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-[0.18em] text-akn-muted uppercase">
          知识图谱
        </h2>

        <div
          role="tablist"
          aria-label="图谱分组"
          className="flex items-center rounded-full border border-akn-border p-0.5"
        >
          <button
            type="button"
            role="tab"
            data-testid="graph-mode-overview"
            aria-selected={chapter === null}
            onClick={() => selectChapter(null)}
            className={[
              'rounded-full px-2 py-0.5 text-[10px] transition-colors',
              chapter === null
                ? 'bg-akn-accent/20 text-akn-accent'
                : 'text-akn-muted hover:bg-akn-raised hover:text-akn-ink',
            ].join(' ')}
          >
            ① 全文档总览
          </button>
          <button
            type="button"
            role="tab"
            data-testid="graph-mode-chapter"
            aria-selected={chapter !== null}
            onClick={enterChapterMode}
            className={[
              'rounded-full px-2 py-0.5 text-[10px] transition-colors',
              chapter !== null
                ? 'bg-akn-accent/20 text-akn-accent'
                : 'text-akn-muted hover:bg-akn-raised hover:text-akn-ink',
            ].join(' ')}
          >
            ② 章节拆解
          </button>
        </div>

        {chapter === null ? null : (
          <select
            data-testid="chapter-select"
            value={chapter.id}
            onChange={(event) => selectChapter(event.target.value)}
            className="max-w-[220px] rounded border border-akn-border bg-akn-panel px-1.5 py-0.5 text-[10px] text-akn-ink outline-none"
          >
            {outline.map((item) => (
              <option key={item.id} value={item.id}>
                {'　'.repeat(Math.max(0, item.level - 1))}
                {item.title}
              </option>
            ))}
          </select>
        )}

        <span data-testid="graph-mode" className="hidden text-[10px] text-akn-muted sm:inline">
          {chapter === null ? '全文档总览' : `章节：${chapter.title}`}
        </span>
        <span data-testid="graph-counts" className="font-mono text-[10px] text-akn-muted/70">
          节点 {visibleNodes.length} · 边 {visibleEdges.length}
        </span>
        {extraction.gateMerged > 0 || extraction.gateViolations > 0 ? (
          <span
            data-testid="graph-gate"
            className="rounded bg-akn-raised px-1.5 py-0.5 text-[10px] text-akn-muted"
            title="质量闸门：条件新颖性为 0 的单元会被合并；前缀/层级违规表示学习顺序不自洽"
          >
            闸门 合并 {extraction.gateMerged}
            {extraction.gateViolations > 0 ? ` · 违规 ${extraction.gateViolations}` : ''}
          </span>
        ) : null}
        {mock ? (
          <span
            data-testid="graph-mock-badge"
            className="rounded bg-akn-warn-soft px-1.5 py-0.5 text-[10px] text-akn-warn"
            title="当前结果来自本地 mock 上游，不代表真实 DeepSeek 输出"
          >
            Mock 上游
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {extraction.status === 'running' ? (
            <span data-testid="extraction-progress" className="text-[10px] text-akn-muted">
              抽取中 {extraction.completedChunks}/{extraction.totalChunks || '…'}
            </span>
          ) : null}
          <button
            type="button"
            data-testid="run-extraction"
            disabled={busy || activeDocument === null}
            onClick={() => void runExtraction()}
            className="rounded-md bg-akn-accent/20 px-2 py-1 text-[11px] font-medium text-akn-accent transition-colors hover:bg-akn-accent/30 disabled:opacity-40"
          >
            {busy ? '抽取中…' : chapter === null ? '⛏ AI 抽取全局图谱' : '🚀 AI 开启拆解'}
          </button>
        </div>
      </header>

      {visibleNodes.length > 1 && visibleEdges.length === 0 ? (
        <p
          data-testid="graph-no-edges"
          className="mx-3 mt-1 rounded border border-akn-warn/40 bg-akn-warn-soft px-2 py-1 text-[10px] text-akn-warn"
        >
          本次抽取没有产生关系边，所以所有节点大小相同（大小 = 关联程度）。可以重新抽取，或换一个模型再试。
        </p>
      ) : null}

      <p data-testid="graph-legend" className="flex flex-wrap gap-x-3 px-3 pt-1 text-[10px] text-akn-muted/80">
        <span>大小 = 关联程度（连边越多越大）</span>
        <span>颜色深浅 = 掌握难度（越深越难）</span>
        <span>红 = 未掌握 · 绿 = 已掌握 · 黄 = 有疑问（点节点内圆点循环切换）</span>
        <span>从左到右 = 依赖方向</span>
        <span title="L1 定位 · L2 连接 · L3 推断 · L4 组织 · L5 选择">左上角 L1–L5 = 认知层级</span>
      </p>

      {chapter !== null ? (
        <button
          type="button"
          data-testid="chapter-summary-open"
          onClick={() => setSummaryOpen(true)}
          className="mx-3 mt-2 self-start rounded-md border border-akn-border bg-akn-panel/70 px-2 py-1 text-[10px] text-akn-muted hover:border-akn-accent/50 hover:text-akn-ink"
          title="打开章节速览浮窗（可拖动）"
        >
          📄 章节速览（逐段总结 · 关键词可点）
        </button>
      ) : null}

      {learningPath.accepted.length > 1 ? (
        <details data-testid="learning-path" className="mx-3 mt-1 rounded border border-akn-border bg-akn-panel/60">
          <summary className="cursor-pointer px-2 py-1 text-[10px] text-akn-muted">
            学习路径（{learningPath.accepted.length} 步，按认知层级 L1→L5 排列）
          </summary>
          <ol className="max-h-40 overflow-y-auto px-2 pb-2">
            {learningPath.accepted.map((id, index) => {
              const item = visibleNodes.find((node) => node.id === id)
              if (item === undefined) return null
              return (
                <li key={id}>
                  {/* 路径条目只负责「在图谱里高亮」：不弹学习对话框。
                      要看详情请点图谱里的节点本身（那是图谱的主交互）。 */}
                  <button
                    type="button"
                    data-testid={`path-item-${id}`}
                    data-selected={selectedNodeId === id ? 'true' : 'false'}
                    data-mastery={item.mastery}
                    title={`${item.title} · ${MASTERY_LABELS[item.mastery]}（在图谱中高亮这个知识点；看详情请点图谱里的节点）`}
                    onClick={() => {
                      selectNode(id)
                      focusNode(id)
                    }}
                    className={[
                      'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[10px]',
                      selectedNodeId === id
                        ? 'bg-akn-accent/15 text-akn-ink'
                        : 'text-akn-ink/90 hover:bg-akn-raised',
                    ].join(' ')}
                  >
                    <span className="w-6 shrink-0 font-mono text-akn-muted/70">{index + 1}.</span>
                    <span className="shrink-0 rounded bg-akn-accent/15 px-1 text-akn-accent">
                      L{item.cognitiveLevel} {COGNITIVE_LEVEL_LABELS[item.cognitiveLevel]}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {/* 与图谱节点同源的状态标记：已掌握 ✓ / 有疑问 ? / 未掌握（空） */}
                    <span
                      data-testid={`path-mastery-${id}`}
                      data-state={item.mastery}
                      aria-label={MASTERY_LABELS[item.mastery]}
                      className={[
                        'ml-auto shrink-0 font-mono text-[11px] leading-4',
                        item.mastery === 'mastered'
                          ? 'text-akn-ok'
                          : item.mastery === 'doubt'
                            ? 'text-akn-warn'
                            : 'text-transparent',
                      ].join(' ')}
                    >
                      {item.mastery === 'mastered' ? '✓' : item.mastery === 'doubt' ? '?' : '·'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </details>
      ) : null}

      {error !== null || extraction.error !== null ? (
        <p
          data-testid="graph-error"
          className="mx-3 mt-2 rounded border border-akn-danger/50 bg-akn-danger-soft px-3 py-2 text-[11px] text-akn-danger"
        >
          {error ?? extraction.error}
        </p>
      ) : null}

      {summaryOpen && chapter !== null ? (
        <div
          data-testid="chapter-summary-popup"
          className="fixed z-40 flex max-h-[70vh] w-[440px] flex-col overflow-hidden rounded-lg border border-akn-border bg-akn-panel shadow-2xl"
          style={{ left: summaryPos.x, top: summaryPos.y }}
        >
          <header
            data-testid="chapter-summary-drag"
            onPointerDown={startSummaryDrag}
            onPointerMove={moveSummaryDrag}
            onPointerUp={endSummaryDrag}
            onPointerCancel={endSummaryDrag}
            className="flex cursor-move items-center gap-2 border-b border-akn-border px-2 py-1 text-[10px] text-akn-muted select-none"
          >
            <span className="font-semibold tracking-wide uppercase">章节速览</span>
            <span className="text-akn-muted/70">逐段总结 · 关键词可点</span>
            {summaryMock ? (
              <span className="rounded bg-akn-warn-soft px-1 text-[9px] text-akn-warn">Mock</span>
            ) : null}
            <button
              type="button"
              data-testid="chapter-summary-close"
              onClick={() => setSummaryOpen(false)}
              className="ml-auto rounded px-1 text-[11px] text-akn-muted hover:bg-akn-raised hover:text-akn-ink"
              title="关闭浮窗"
            >
              ✕
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {summaryLoading ? (
              <p className="text-[11px] text-akn-muted">正在整理这一章…</p>
            ) : summaryError !== null ? (
              <div className="space-y-1">
                <p data-testid="chapter-summary-error" className="text-[11px] text-akn-danger">
                  {summaryError}
                </p>
                <button
                  type="button"
                  data-testid="chapter-summary-retry"
                  onClick={() => void generateSummary()}
                  className="rounded-md bg-akn-accent/20 px-2 py-1 text-[11px] font-medium text-akn-accent hover:bg-akn-accent/30"
                >
                  重试整理
                </button>
              </div>
            ) : chapterSummary !== '' ? (
              <>
                <p
                  data-testid="chapter-summary-text"
                  className="text-[11px] leading-relaxed whitespace-pre-wrap text-akn-ink/90"
                >
                  {summarySegments.map((segment, index) =>
                    segment.nodeId === null ? (
                      <span key={index}>{segment.text}</span>
                    ) : (
                      <button
                        key={index}
                        type="button"
                        data-testid={`summary-kw-${segment.nodeId}`}
                        title="在图谱中选中这个知识点（会自动移到画布中心）"
                        onClick={() => {
                          const keywordNodeId = segment.nodeId
                          if (keywordNodeId === null) return
                          selectNode(keywordNodeId)
                          focusNode(keywordNodeId)
                        }}
                        className="rounded-sm text-akn-accent underline decoration-dotted underline-offset-2 transition-colors hover:bg-akn-accent/15"
                      >
                        {segment.text}
                      </button>
                    ),
                  )}
                </p>
                <button
                  type="button"
                  data-testid="chapter-summary-regenerate"
                  onClick={() => void generateSummary()}
                  className="mt-2 text-[10px] text-akn-accent hover:underline"
                >
                  重新整理
                </button>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="chapter-summary-generate"
                  onClick={() => void generateSummary()}
                  className="rounded-md bg-akn-accent/20 px-2 py-1 text-[11px] font-medium text-akn-accent hover:bg-akn-accent/30"
                >
                  整理这一章
                </button>
                <span className="text-[10px] text-akn-muted/70">基于已拆解的知识点，不重新抽取</span>
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {visibleNodes.length === 0 ? (
          <div className="grid h-full place-items-center px-6">
            <div
              data-testid="graph-empty"
              className="max-w-md rounded-xl border border-dashed border-akn-border px-6 py-8 text-center"
            >
              <p className="text-sm font-medium text-akn-ink/90">
                {chapter === null ? '还没有全文档总览图谱' : '这个章节还没拆解'}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-akn-muted">
                {activeDocument === null
                  ? '先在左侧「打开 PDF」，再点右上角「AI 抽取全局图谱」。'
                  : chapter === null
                    ? '点击「AI 抽取全局图谱」：按章节切块 → 逐块抽取 → 实体合并 → 全局汇总，然后按依赖从左到右排列。'
                    : '点击「AI 开启拆解」生成该章节的细化子图；同一章节再次进入会直接读缓存。'}
              </p>
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            onNodeClick={onNodeClick}
            onPaneClick={() => selectNode(null)}
            fitView
            fitViewOptions={{ minZoom: 0.45, maxZoom: 1, padding: 0.15 }}
            minZoom={0.2}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--akn-grid)" gap={22} />
            <Controls showInteractive={false} />
            <FocusOnNode request={focusRequest} />
          </ReactFlow>
        )}
      </div>

      {learningNodeId !== null ? (
        <NodeLearningDialog
          nodeId={learningNodeId}
          onNavigate={(nextId) => {
            selectNode(nextId)
            openLearning(nextId)
          }}
        />
      ) : null}
    </section>
  )
}
