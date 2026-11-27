import { useEffect, useMemo, useState } from 'react'

import { COGNITIVE_LEVEL_LABELS, MASTERY_LABELS, UNIT_KIND_LABELS } from '../domain/enums'
import { saveNote } from '../db/repositories/annotations'
import { newId } from '../lib/id'
import { renderRegionToPng } from '../pdf/figureRender'
import { enrichNode } from '../llm/pipeline/enrich'
import { loadNodeExcerpt, type NodeExcerpt } from '../pdf/excerptController'
import { useDocumentStore } from '../stores/documentStore'
import { useGraphStore } from '../stores/graphStore'
import { jumpNodeToPdf, setNodeMasteryFlag } from './graphActions'
import { jumpTargetOf } from './jumpTarget'

import type { KnowledgeNode } from '../domain'
import type { ReactElement } from 'react'

/**
 * 知识点学习对话框（图谱优先学习流）。
 *
 * 对话内容是**知识点的描述**，不是原文摘抄：
 *  1) 读：知识点描述（模型抽取/按需分析给出的 summary，图表节点回落到 caption）；
 *  2) 学：先修、精细加工四问、自测，以及该节点的图表（caption + 区域截图）；
 *  3) 走：上下游知识点可点开继续学，掌握状态可切换，随时跳回 PDF 原文。
 *
 * 原文只在需要时看：footer 的「跳到 PDF 原文」会把锚点句高亮出来，
 * 这样对话框里读的是「这个概念是什么」，而不是两百字上下文。
 */

interface NodeLearningDialogProps {
  readonly nodeId: string
  readonly onNavigate: (nodeId: string) => void
}

function stars(importance: number): string {
  const clamped = Math.max(1, Math.min(5, Math.round(importance)))
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped)
}

export function NodeLearningDialog({ nodeId, onNavigate }: NodeLearningDialogProps): ReactElement | null {
  const node = useGraphStore((state) => state.nodesById[nodeId] ?? null)
  const edges = useGraphStore((state) => state.edgesById)
  const nodesById = useGraphStore((state) => state.nodesById)
  const closeLearning = useGraphStore((state) => state.closeLearning)
  const activeDocument = useDocumentStore((state) => state.document)
  const pdfDocument = useDocumentStore((state) => state.pdfDocument)

  const [excerpt, setExcerpt] = useState<NodeExcerpt | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [enriching, setEnriching] = useState(false)
  const [figureImages, setFigureImages] = useState<Record<number, string | null>>({})

  // 摘录只用来定位图表（caption + 区域），对话框正文显示的始终是知识点描述
  useEffect(() => {
    let cancelled = false
    setExcerpt(null)
    setHint(null)

    void loadNodeExcerpt(nodeId)
      .then((result) => {
        if (!cancelled) setExcerpt(result)
      })
      .catch(() => {
        // 取不到原文索引不影响「描述」这条主线：图表块不出现即可
        if (!cancelled) setExcerpt(null)
      })

    return () => {
      cancelled = true
    }
  }, [nodeId])

  // 图表区域截图（有 caption 才渲染）
  useEffect(() => {
    if (excerpt === null || pdfDocument === null) return
    let cancelled = false
    for (const figure of excerpt.figures) {
      void renderRegionToPng(pdfDocument, figure.region).then((dataUrl) => {
        if (!cancelled) setFigureImages((prev) => ({ ...prev, [figure.page]: dataUrl }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [excerpt, pdfDocument])

  const upstream = useMemo(() => {
    if (node === null) return []
    return Object.values(edges).filter((edge) => edge.targetId === node.id)
  }, [edges, node])
  const downstream = useMemo(() => {
    if (node === null) return []
    return Object.values(edges).filter((edge) => edge.sourceId === node.id)
  }, [edges, node])

  if (node === null) return null

  // 知识点描述：抽取/按需分析给的 summary；图表节点没有 summary 时回落到 caption
  const description =
    node.summary.trim() !== '' ? node.summary.trim() : (node.figure?.caption ?? '').trim()
  const hasDescription = description !== ''
  // 图表/表格节点没有 quote 也能跳（退到 figure.page + caption）
  const jumpTarget = jumpTargetOf(node)

  const analyzeNode = async (): Promise<void> => {
    if (enriching) return
    setEnriching(true)
    setHint('正在分析这个知识点…')
    try {
      await enrichNode(node.id)
      setHint('已生成知识点描述与自测')
    } catch (cause) {
      setHint(cause instanceof Error ? cause.message : '分析失败，请重试')
    } finally {
      setEnriching(false)
    }
  }

  const saveNodeNote = async (): Promise<void> => {
    if (activeDocument === null || noteText.trim() === '') return
    const timestamp = Date.now()
    try {
      await saveNote({
        id: newId(),
        documentId: activeDocument.id,
        highlightId: null,
        nodeId: node.id,
        page: node.anchor?.page ?? null,
        text: noteText.trim(),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      setNoteText('')
      setHint('知识点笔记已保存')
    } catch (cause) {
      setHint(cause instanceof Error ? cause.message : '笔记保存失败')
    }
  }

  return (
    <div
      data-testid="learning-dialog"
      data-node-id={node.id}
      data-mastery={node.mastery}
      data-anchor-page={node.anchor?.page ?? ''}
      className="absolute inset-0 z-30 flex items-center justify-center bg-akn-scrim p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeLearning()
      }}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-akn-border bg-akn-panel shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-akn-border px-4 py-3">
          <div className="min-w-0">
            <h3 data-testid="learning-title" className="truncate text-sm font-semibold text-akn-ink">
              {node.title}
            </h3>
            <p className="mt-1 text-[11px] text-akn-muted">
              <span data-testid="learning-level">
                L{node.cognitiveLevel} {COGNITIVE_LEVEL_LABELS[node.cognitiveLevel]}
              </span>
              {' · '}
              <span data-testid="learning-kind">{UNIT_KIND_LABELS[node.unitKind]}</span>
              {' · '}重要度 {stars(node.importance)} ·{' '}
              <span data-testid="learning-mastery" data-state={node.mastery}>
                {MASTERY_LABELS[node.mastery]}
              </span>{' '}
              ·
              来源 {node.importanceSource}
              {node.anchor === null
                ? node.figure !== null
                  ? ` · 图表 p.${node.figure.page}`
                  : ' · 无原文锚点'
                : ` · p.${node.anchor.page}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-testid="learning-toggle-mastery"
              data-active={node.mastery === 'mastered' ? 'true' : 'false'}
              title={node.mastery === 'mastered' ? '已掌握 · 点击取消' : '标为已掌握'}
              onClick={() => void setNodeMasteryFlag(node.id, 'mastered')}
              className={[
                'rounded border px-2 py-1 text-[11px]',
                node.mastery === 'mastered'
                  ? 'border-akn-ok bg-akn-ok-soft text-akn-ok'
                  : 'border-akn-border text-akn-muted hover:border-akn-ok/60 hover:text-akn-ok',
              ].join(' ')}
            >
              ✓ 已掌握
            </button>
            <button
              type="button"
              data-testid="learning-toggle-doubt"
              data-active={node.mastery === 'doubt' ? 'true' : 'false'}
              title={node.mastery === 'doubt' ? '有疑问 · 点击取消' : '标为有疑问'}
              onClick={() => void setNodeMasteryFlag(node.id, 'doubt')}
              className={[
                'rounded border px-2 py-1 text-[11px]',
                node.mastery === 'doubt'
                  ? 'border-akn-warn bg-akn-warn-soft text-akn-warn'
                  : 'border-akn-border text-akn-muted hover:border-akn-warn/60 hover:text-akn-warn',
              ].join(' ')}
            >
              ? 有疑问
            </button>
            <button
              type="button"
              data-testid="learning-close"
              onClick={closeLearning}
              className="rounded border border-akn-border px-2 py-1 text-[11px] text-akn-muted hover:text-akn-ink"
            >
              关闭
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!hasDescription ? (
            <div
              data-testid="learning-empty"
              className="mb-3 rounded border border-dashed border-akn-accent/50 bg-akn-accent/5 px-3 py-3 text-center"
            >
              <p className="text-[11px] text-akn-muted">
                这个知识点还没有描述。可以让模型读原文，把它讲清楚。
              </p>
              <button
                type="button"
                data-testid="learning-analyze"
                disabled={enriching}
                onClick={() => void analyzeNode()}
                className="mt-2 rounded-md bg-akn-accent/20 px-3 py-1 text-[11px] font-medium text-akn-accent transition-colors hover:bg-akn-accent/30 disabled:opacity-40"
              >
                {enriching ? '分析中…' : '点击进一步分析'}
              </button>
            </div>
          ) : null}

          {/* 知识点描述：取代原来的「原文摘抄」，读的是概念本身而不是两百字上下文 */}
          <section
            data-testid="learning-description"
            className="mb-3 rounded-lg border border-akn-border bg-akn-sunken/60 px-3 py-2"
          >
            <p className="text-[10px] font-semibold tracking-wide text-akn-muted uppercase">
              知识点描述
            </p>
            {description === '' ? (
              <p
                data-testid="learning-description-empty"
                className="mt-1 text-[12px] leading-relaxed text-akn-muted/70"
              >
                还没有描述（点上面的「点击进一步分析」生成）。
              </p>
            ) : (
              <p
                data-testid="learning-description-text"
                className="mt-1 text-[12px] leading-relaxed text-akn-ink/90"
              >
                {description}
              </p>
            )}
            {node.aliases.length > 0 ? (
              <p data-testid="learning-aliases" className="mt-1 text-[10px] text-akn-muted/80">
                别名：{node.aliases.join(' / ')}
              </p>
            ) : null}
            {node.anchor === null ? (
              <p
                data-testid="learning-anchor-note"
                className="mt-1 text-[10px] text-akn-warn"
              >
                {node.figure !== null
                  ? `图表/表格节点：跳转会定位到第 ${node.figure.page} 页的 caption（没有逐字引文）。`
                  : '没有可定位的原文引文：跳转会按标题在 PDF 里搜索，找不到会给出提示。'}
              </p>
            ) : null}
          </section>

          <div data-testid="learning-prior" className="mb-3">
            <p className="text-[10px] font-semibold tracking-wide text-akn-muted uppercase">
              先修（学它之前应先掌握）
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {node.priorKnowledge.length === 0 ? (
                <span className="text-[10px] text-akn-muted/70">无明确先修，可直接学</span>
              ) : (
                node.priorKnowledge.map((item, index) => (
                  <span
                    key={`${item}-${index}`}
                    data-testid={`learning-prior-${index}`}
                    className="rounded-full border border-akn-border bg-akn-raised px-2 py-0.5 text-[10px] text-akn-ink/90"
                  >
                    {item}
                  </span>
                ))
              )}
            </div>
          </div>

          {node.elaboration !== null ? (
            <div
              data-testid="learning-elaboration"
              className="mb-3 rounded border border-akn-border bg-akn-sunken/40 px-3 py-2"
            >
              <p className="text-[10px] font-semibold tracking-wide text-akn-muted uppercase">精细加工</p>
              <dl className="mt-1 space-y-1 text-[11px] leading-relaxed text-akn-ink/90">
                {node.elaboration.analogy !== '' ? (
                  <div>
                    <dt className="inline font-medium text-akn-muted">类比：</dt>
                    <dd className="inline">{node.elaboration.analogy}</dd>
                  </div>
                ) : null}
                {node.elaboration.contrast !== '' ? (
                  <div>
                    <dt className="inline font-medium text-akn-muted">对比：</dt>
                    <dd className="inline">{node.elaboration.contrast}</dd>
                  </div>
                ) : null}
                {node.elaboration.why !== '' ? (
                  <div>
                    <dt className="inline font-medium text-akn-muted">为什么重要：</dt>
                    <dd className="inline">{node.elaboration.why}</dd>
                  </div>
                ) : null}
                {node.elaboration.misconception !== '' ? (
                  <div>
                    <dt className="inline font-medium text-akn-muted">常见误解：</dt>
                    <dd className="inline">{node.elaboration.misconception}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : null}

          {node.selfCheck !== '' ? (
            <div
              data-testid="learning-selfcheck"
              className="mb-3 rounded border border-akn-accent/30 bg-akn-accent/5 px-3 py-2"
            >
              <p className="text-[10px] font-semibold tracking-wide text-akn-accent uppercase">
                自测（先自己想，再展开答案）
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-akn-ink">{node.selfCheck}</p>
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] text-akn-muted">查看答案要点</summary>
                <p className="mt-1 text-[11px] leading-relaxed text-akn-ink/90">
                  {description !== '' ? description : '（可点「点击进一步分析」生成答案要点）'}
                </p>
              </details>
            </div>
          ) : null}

          {/* 图表：仍然保留 caption + 区域截图（这是知识点自身的图，不是原文摘抄） */}
          {excerpt !== null && excerpt.figures.length > 0 ? (
            <div className="mt-3 space-y-2">
              {excerpt.figures.map((figure) => (
                <figure
                  key={`${figure.page}-${figure.caption.label}`}
                  data-testid="figure-excerpt"
                  className="rounded-lg border border-akn-border bg-akn-sunken p-2"
                >
                  <div className="flex items-center justify-between">
                    <figcaption className="text-[11px] font-medium text-akn-ink/90">
                      {figure.caption.text.slice(0, 120)}
                    </figcaption>
                    <button
                      type="button"
                      onClick={() => {
                        void jumpNodeToPdf(node.id)
                        closeLearning()
                      }}
                      className="ml-2 shrink-0 rounded border border-akn-border px-1.5 py-0.5 text-[10px] text-akn-muted"
                    >
                      在 PDF 查看
                    </button>
                  </div>
                  {figureImages[figure.page] ? (
                    <img
                      data-testid="figure-image"
                      src={figureImages[figure.page] ?? ''}
                      alt={figure.caption.text}
                      className="mt-2 max-h-64 w-full rounded border border-akn-border object-contain"
                    />
                  ) : (
                    <p className="mt-2 text-[10px] text-akn-muted/70">
                      图表区域按 caption 估算，渲染中或不可用；可点「在 PDF 查看」。
                    </p>
                  )}
                </figure>
              ))}
            </div>
          ) : null}

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <section className="rounded-lg border border-akn-border p-2">
              <p className="text-[10px] font-semibold tracking-wider text-akn-muted uppercase">
                知识点笔记
              </p>
              <textarea
                data-testid="learning-note-input"
                value={noteText}
                rows={2}
                onChange={(event) => setNoteText(event.target.value)}
                placeholder="记录你自己的理解…"
                className="mt-1 w-full resize-none rounded border border-akn-border bg-akn-sunken px-2 py-1 text-[11px] text-akn-ink placeholder:text-akn-muted/50"
              />
              <button
                type="button"
                data-testid="learning-note-save"
                onClick={() => void saveNodeNote()}
                className="mt-1 rounded border border-akn-border px-2 py-0.5 text-[10px] text-akn-muted hover:text-akn-ink"
              >
                保存笔记
              </button>
            </section>

            <section className="rounded-lg border border-akn-border p-2">
              <p className="text-[10px] font-semibold tracking-wider text-akn-muted uppercase">
                前置依赖（{upstream.length}） / 后置影响（{downstream.length}）
              </p>
              <div className="mt-1 space-y-1">
                {upstream.length === 0 && downstream.length === 0 ? (
                  <p className="text-[10px] text-akn-muted/60">暂无关联知识点</p>
                ) : null}
                {upstream.slice(0, 4).map((edge) => (
                  <ChipButton
                    key={edge.id}
                    testId={`learning-upstream-${edge.sourceId}`}
                    label={`← ${nodesById[edge.sourceId]?.title ?? edge.sourceId}（${edge.relationLabel}）`}
                    onClick={() => onNavigate(edge.sourceId)}
                  />
                ))}
                {downstream.slice(0, 4).map((edge) => (
                  <ChipButton
                    key={edge.id}
                    testId={`learning-downstream-${edge.targetId}`}
                    label={`→ ${nodesById[edge.targetId]?.title ?? edge.targetId}（${edge.relationLabel}）`}
                    onClick={() => onNavigate(edge.targetId)}
                  />
                ))}
              </div>
            </section>
          </div>

          {hint !== null ? (
            <p data-testid="learning-hint" className="mt-2 rounded bg-akn-raised px-2 py-1 text-[10px] text-akn-muted">
              {hint}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-between border-t border-akn-border px-4 py-2">
          <span className="text-[10px] text-akn-muted/60">
            {jumpTarget === null
              ? activeDocument === null
                ? '请先打开 PDF'
                : '无引文锚点：按标题在 PDF 中搜索'
              : node.anchor !== null
                ? `原文位置：第 ${jumpTarget.page} 页`
                : `图表位置：第 ${jumpTarget.page} 页`}
          </span>
          <button
            type="button"
            data-testid="learning-jump-pdf"
            disabled={activeDocument === null}
            title={
              jumpTarget === null
                ? '没有可用的原文引文：会按知识点标题在 PDF 里搜索'
                : '跳到原文并临时高亮'
            }
            onClick={() => {
              void jumpNodeToPdf(node.id)
              closeLearning()
            }}
            className="rounded border border-akn-border px-2 py-1 text-[11px] text-akn-muted hover:border-akn-accent/60 hover:text-akn-ink disabled:opacity-40"
          >
            跳到 PDF 原文
          </button>
        </footer>
      </div>
    </div>
  )
}

function ChipButton({
  label,
  onClick,
  testId,
}: {
  label: string
  onClick: () => void
  testId?: string
}): ReactElement {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="block w-full truncate rounded px-1.5 py-1 text-left text-[11px] text-akn-muted hover:bg-akn-raised hover:text-akn-ink"
    >
      {label}
    </button>
  )
}

export type { KnowledgeNode }
