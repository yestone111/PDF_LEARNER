/**
 * map-reduce 抽取流水线。
 *
 * 固定流程（任务书 §5.1）：
 *   切块(map) → 逐块抽取(缓存优先) → 实体合并 → 全局汇总(reduce) → 写库
 * 纪律：
 *   - 未经 zod 校验的数据绝不进入 IndexedDB 或渲染；
 *   - 校验失败先尝试一次 json_repair，仍失败则标 failed 并允许单块重试；
 *   - 绝不伪造节点/边/页码。
 */

import {
  ChunkExtractionResultSchema,
  GlobalGraphResultSchema,
  RELATION_LABELS,
  RELATION_LABELS_EN,
  parseStrict,
} from '../../domain'
import { newId } from '../../lib/id'
import { requestExtraction, type ExtractionCall } from '../client'
import { CHUNK_EXTRACT_VERSION, chunkExtractPrompt } from '../prompts/chunkExtract'
import { GLOBAL_REDUCE_VERSION, globalReducePrompt } from '../prompts/globalReduce'
import { JSON_REPAIR_VERSION, jsonRepairPrompt } from '../prompts/jsonRepair'
import { DEFAULT_PRIMARY_LANGUAGE, type PrimaryLanguage } from '../prompts/language'
import { locateQuote } from './anchor'
import { makeCacheKey, readExtractionCache, writeExtractionCache } from './cache'
import { buildChunks, type ChunkDraft } from './chunking'
import { hashChunk } from './hash'
import { mergeNodeDrafts, type DraftWithChunk, type MergedNode } from './merge'
import { calibrateLevels } from './calibrateLevels'
import { isOutlineDerivedTitle, outlineTitleKeys } from './outlineFilter'
import { planReduceBatches, REDUCE_LIMITS } from './reducePlan'
import { inheritUnderstandingFields } from './inherit'
import { normalizeExtractionJson } from './normalizeLlmJson'
import { gateUnits } from './unitGate'

import type { z } from 'zod'

import type {
  ChunkExtractionResult,
  GlobalGraphResult,
  KnowledgeEdge,
  KnowledgeNode,
  OutlineNode,
} from '../../domain'
import type { PageText } from './chunking'
import type { LlmEdgeDraft } from '../../domain/types'

export type ExtractionTransport = (call: ExtractionCall) => Promise<{ content: string; mock: boolean }>

const defaultTransport: ExtractionTransport = (call) => requestExtraction(call)

export interface RunExtractionOptions {
  readonly documentId: string
  readonly pages: readonly PageText[]
  readonly outline: readonly OutlineNode[]
  readonly transport?: ExtractionTransport
  readonly signal?: AbortSignal
  readonly targetTokens?: number
  /** 忽略缓存（单块重试时用）。 */
  readonly force?: boolean
  /** 主要语言：节点标题/摘要/关系标签用该语言输出（引文保持原文）。 */
  readonly language?: PrimaryLanguage
  /** 是否读写抽取缓存（默认 true；单测等无 IndexedDB 环境可关掉）。 */
  readonly cache?: boolean
  /** 块级抽取并发数（默认 3，范围 1–8）。 */
  readonly concurrency?: number
  readonly onProgress?: (progress: { completed: number; total: number; failed: number }) => void
}

export interface FailedChunk {
  readonly chunkId: string
  readonly pageStart: number
  readonly pageEnd: number
  readonly error: string
}

/** 闸门统计：让「合并了几个、哪类违规」对用户可见，而不是静默处理。 */
export interface GateSummary {
  readonly accepted: number
  readonly merged: number
  readonly prefixViolations: number
  readonly levelViolations: number
  readonly cycles: number
}

function summarizeGate(result: ReturnType<typeof gateUnits>): GateSummary {
  return {
    accepted: result.accepted.length,
    merged: result.mergedByNovelty.size,
    prefixViolations: result.violations.filter((violation) => violation.kind === 'prefix').length,
    levelViolations: result.violations.filter((violation) => violation.kind === 'level').length,
    cycles: result.violations.filter((violation) => violation.kind === 'cycle').length,
  }
}

export interface ExtractionOutcome {
  readonly nodes: readonly KnowledgeNode[]
  readonly edges: readonly KnowledgeEdge[]
  readonly chunkCount: number
  readonly cacheHits: number
  readonly llmCalls: number
  readonly failedChunks: readonly FailedChunk[]
  readonly mock: boolean
  readonly gate: GateSummary | null
}

interface JsonStageInput<T> {
  readonly documentId: string
  readonly stage: 'chunk_extract' | 'global_reduce'
  readonly chunkId: string | null
  readonly chunkHash: string | null
  readonly promptVersion: string
  readonly buildPrompt: () => { messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[]; maxTokens: number }
  readonly schema: z.ZodType<T>
  readonly transport: ExtractionTransport
  readonly signal?: AbortSignal
  readonly force: boolean
  /** false 时完全不碰 IndexedDB（单测/无浏览器环境）。 */
  readonly useCache: boolean
}

type JsonStageResult<T> =
  | { readonly ok: true; readonly payload: T; readonly mock: boolean; readonly cacheHit: boolean }
  | { readonly ok: false; readonly error: string; readonly mock: boolean }

async function runJsonStage<T>(input: JsonStageInput<T>): Promise<JsonStageResult<T>> {
  const key = makeCacheKey({
    documentId: input.documentId,
    stage: input.stage,
    chunkHash: input.chunkHash,
    promptVersion: input.promptVersion,
  })

  if (input.useCache && !input.force) {
    const cached = await readExtractionCache(key)
    if (cached !== null && cached.status === 'success' && cached.payload !== null && cached.payload.stage === input.stage) {
      return { ok: true, payload: cached.payload as T, mock: false, cacheHit: true }
    }
  }

  const prompt = input.buildPrompt()
  let attempts = 0
  let mock = false
  let raw = ''
  let lastError = ''

  const parseOnce = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      return { ok: false, error: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
    }
    // 宽进严出：先做确定性归一化（枚举/数值/缺省），再由 zod 严格校验。
    // 归一化只做等价映射与非法条目丢弃，不补造内容。
    const normalized = normalizeExtractionJson(json, input.stage)
    const checked = parseStrict(input.schema, normalized, input.stage)
    return checked.ok ? { ok: true, value: checked.data } : { ok: false, error: checked.message }
  }

  // 第一次尝试
  try {
    attempts += 1
    const response = await input.transport({
      stage: input.stage,
      promptVersion: input.promptVersion,
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
      signal: input.signal,
    })
    mock = response.mock
    raw = response.content
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (input.useCache) await writeExtractionCache({
      key,
      documentId: input.documentId,
      stage: input.stage,
      promptVersion: input.promptVersion,
      chunkId: input.chunkId,
      chunkHash: input.chunkHash,
      rawResponse: null,
      payload: null,
      status: 'failed',
      error: message,
      attempts,
    })
    return { ok: false, error: message, mock }
  }

  let parsed = parseOnce(raw)
  lastError = parsed.ok ? '' : parsed.error

  // 校验失败 → 一次 json_repair
  if (!parsed.ok) {
    try {
      attempts += 1
      const repairPrompt = jsonRepairPrompt.build({
        stage: input.stage,
        validationError: parsed.error,
        rawOutput: raw,
      })
      const repaired = await input.transport({
        stage: 'json_repair',
        promptVersion: JSON_REPAIR_VERSION,
        messages: repairPrompt.messages,
        maxTokens: repairPrompt.maxTokens,
        signal: input.signal,
      })
      mock = repaired.mock
      raw = repaired.content
      parsed = parseOnce(raw)
      lastError = parsed.ok ? '' : parsed.error
    } catch (error) {
      lastError = `JSON 修复阶段失败：${error instanceof Error ? error.message : String(error)}`
      parsed = { ok: false, error: lastError }
    }
  }

  if (!parsed.ok) {
    if (input.useCache) await writeExtractionCache({
      key,
      documentId: input.documentId,
      stage: input.stage,
      promptVersion: input.promptVersion,
      chunkId: input.chunkId,
      chunkHash: input.chunkHash,
      rawResponse: raw,
      payload: null,
      status: 'failed',
      error: lastError,
      attempts,
    })
    return { ok: false, error: lastError, mock }
  }

  if (input.useCache) await writeExtractionCache({
    key,
    documentId: input.documentId,
    stage: input.stage,
    promptVersion: input.promptVersion,
    chunkId: input.chunkId,
    chunkHash: input.chunkHash,
    rawResponse: raw,
    payload: parsed.value && typeof parsed.value === 'object' && 'stage' in parsed.value ? (parsed.value as never) : null,
    status: 'success',
    error: null,
    attempts,
  })

  return { ok: true, payload: parsed.value, mock, cacheHit: false }
}

function resolveOutlineTitle(outline: readonly OutlineNode[], outlineNodeId: string | null): string | null {
  if (outlineNodeId === null) return null
  return outline.find((node) => node.id === outlineNodeId)?.title ?? null
}

/** 把合并后的草稿变成 KnowledgeNode（锚点只在 quote 真实可定位时生成）。 */
function toKnowledgeNode(input: {
  readonly documentId: string
  readonly merged: MergedNode
  readonly scope: 'global' | 'chapter'
  readonly chapterId: string | null
  readonly parentId: string | null
  readonly pages: readonly PageText[]
  readonly sourceChunkId: string | null
}): KnowledgeNode {
  const timestamp = Date.now()
  // 图表/表格占位节点通常没有 quote（模型只给 caption）。以前这里直接判 anchor=null，
  // 结果「Table N」这类节点点了跳不动。改用 caption 做引文去原文里定位：
  // 命中就得到真实页码 + 可画下划线的引文，命不中也还有 figure.page 兜底（见 jumpTargetOf）。
  const figure = input.merged.figure
  const quote = input.merged.quote !== '' ? input.merged.quote : (figure?.caption ?? '')
  const pageHint = figure !== null ? figure.page : input.merged.page
  const anchor = quote.trim() === '' ? null : locateQuote(quote, pageHint, input.pages)

  return {
    id: newId(),
    documentId: input.documentId,
    parentId: input.parentId,
    chapterId: input.chapterId,
    scope: input.scope,
    title: input.merged.title,
    titleNorm: input.merged.key,
    aliases: input.merged.aliases,
    summary: input.merged.summary,
    difficulty: input.merged.difficulty,
    cognitiveLevel: input.merged.cognitiveLevel,
    unitKind: input.merged.unitKind,
    priorKnowledge: input.merged.priorKnowledge,
    elaboration: input.merged.elaboration,
    selfCheck: input.merged.selfCheck,
    importance: input.merged.importance,
    importanceSource: 'llm',
    mastery: 'unmastered',
    anchor,
    sourceChunkId: input.sourceChunkId,
    figure,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function toKnowledgeEdges(input: {
  readonly documentId: string
  readonly drafts: readonly LlmEdgeDraft[]
  readonly byNorm: ReadonlyMap<string, string>
  readonly language: PrimaryLanguage
}): KnowledgeEdge[] {
  const timestamp = Date.now()
  const edges: KnowledgeEdge[] = []

  for (const draft of input.drafts) {
    const sourceId = input.byNorm.get(normalizeForEdge(draft.sourceTitle))
    const targetId = input.byNorm.get(normalizeForEdge(draft.targetTitle))
    if (sourceId === undefined || targetId === undefined || sourceId === targetId) continue

    const relationLabel =
      draft.relationType === 'custom'
        ? (draft.relationLabel ?? (input.language === 'en' ? 'custom' : '自定义'))
        : input.language === 'en'
          ? RELATION_LABELS_EN[draft.relationType]
          : RELATION_LABELS[draft.relationType]

    edges.push({
      id: newId(),
      documentId: input.documentId,
      sourceId,
      targetId,
      relationType: draft.relationType,
      relationLabel,
      origin: 'llm',
      evidence: null,
      confidence: null,
      createdAt: timestamp,
    })
  }

  return edges
}

function normalizeForEdge(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/[$\\{}`*_#]/g, ' ')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\p{S}]/gu, '')
    .trim()
}

interface ChunkStageInput {
  readonly documentId: string
  readonly chunks: readonly ChunkDraft[]
  readonly outline: readonly OutlineNode[]
  readonly language: PrimaryLanguage
  readonly transport: ExtractionTransport
  readonly signal?: AbortSignal
  readonly force: boolean
  readonly useCache: boolean
  readonly concurrency?: number
  readonly onProgress?: (progress: { completed: number; total: number; failed: number }) => void
}

interface ChunkOutcome {
  readonly chunk: ChunkDraft
  readonly chunkId: string
  readonly payload?: ChunkExtractionResult
  readonly error?: string
}

interface ChunkStageResult {
  readonly outcomes: readonly ChunkOutcome[]
  readonly cacheHits: number
  readonly llmCalls: number
  readonly mock: boolean
  readonly failedChunks: FailedChunk[]
}

/**
 * 块级抽取（全局与章节共用）。
 *
 * 两条路径必须共用同一实现：缓存 key、并发度、进度上报都一致，
 * 否则「章节拆解为什么比全局慢」这类问题会反复出现（串行 + 无进度 = 看起来卡死）。
 */
async function runChunkStage(input: ChunkStageInput): Promise<ChunkStageResult> {
  const outcomes: Array<ChunkOutcome | undefined> = new Array(input.chunks.length)
  const failedChunks: FailedChunk[] = []
  let cacheHits = 0
  let llmCalls = 0
  let mock = false
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 3, 8))
  let cursor = 0
  let completed = 0

  const runOne = async (index: number): Promise<void> => {
    const chunk = input.chunks[index]!
    const outlineTitle = resolveOutlineTitle(input.outline, chunk.outlineNodeId)
    const chunkId = await hashChunk({ text: chunk.text, pageStart: chunk.pageStart, outlineTitle })

    const result = await runJsonStage<ChunkExtractionResult>({
      documentId: input.documentId,
      stage: 'chunk_extract',
      chunkId,
      chunkHash: chunkId,
      promptVersion: CHUNK_EXTRACT_VERSION,
      buildPrompt: () =>
        chunkExtractPrompt.build({
          language: input.language,
          chunkId,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          outlineTitle,
          text: chunk.text,
        }),
      schema: ChunkExtractionResultSchema,
      transport: input.transport,
      signal: input.signal,
      force: input.force,
      useCache: input.useCache,
    })

    if (result.ok) {
      outcomes[index] = { chunk, chunkId, payload: result.payload }
      if (result.cacheHit) cacheHits += 1
      else llmCalls += 1
      mock = mock || result.mock
    } else {
      outcomes[index] = { chunk, chunkId, error: result.error }
      llmCalls += 1
    }
    completed += 1
    input.onProgress?.({ completed, total: input.chunks.length, failed: failedChunks.length })
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= input.chunks.length) return
      await runOne(index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, input.chunks.length) }, () => worker()))

  const ordered: ChunkOutcome[] = []
  for (const entry of outcomes) {
    if (entry === undefined) continue
    if (entry.error !== undefined) {
      failedChunks.push({
        chunkId: entry.chunkId,
        pageStart: entry.chunk.pageStart,
        pageEnd: entry.chunk.pageEnd,
        error: entry.error,
      })
    }
    ordered.push(entry)
  }

  return { outcomes: ordered, cacheHits, llmCalls, mock, failedChunks }
}

export async function runDocumentExtraction(options: RunExtractionOptions): Promise<ExtractionOutcome> {
  const transport = options.transport ?? defaultTransport
  const language = options.language ?? DEFAULT_PRIMARY_LANGUAGE
  const chunks = buildChunks(options.pages, options.outline, options.targetTokens)
  const failedChunks: FailedChunk[] = []
  let cacheHits = 0
  let llmCalls = 0
  let mock = false

  const chunkDrafts = new Map<string, { chunk: ChunkDraft & { id: string }; drafts: DraftWithChunk[]; edges: LlmEdgeDraft[] }>()

  // 块级抽取（并发 + 缓存 + 进度），与章节路径共用同一实现
  const stage = await runChunkStage({
    documentId: options.documentId,
    chunks,
    outline: options.outline,
    language,
    transport,
    signal: options.signal,
    force: options.force === true,
    useCache: options.cache !== false,
    concurrency: options.concurrency,
    onProgress: options.onProgress,
  })
  cacheHits += stage.cacheHits
  llmCalls += stage.llmCalls
  mock = mock || stage.mock
  failedChunks.push(...stage.failedChunks)

  // 按块顺序装配，保证合并结果与并发无关（确定性）
  for (const outcome of stage.outcomes) {
    if (outcome.payload === undefined) continue
    const entries: DraftWithChunk[] = outcome.payload.nodes.map((draft) => ({ draft, chunkId: outcome.chunkId }))
    const key = outcome.chunk.outlineNodeId ?? 'root'
    const existing = chunkDrafts.get(key)
    if (existing === undefined) {
      chunkDrafts.set(key, {
        chunk: { ...outcome.chunk, id: outcome.chunkId },
        drafts: entries,
        edges: [...outcome.payload.edges],
      })
    } else {
      existing.drafts.push(...entries)
      existing.edges.push(...outcome.payload.edges)
    }
  }

  // 所有块都失败：直接返回，不产生任何节点（绝不假数据填充）
  if (chunkDrafts.size === 0) {
    return {
      nodes: [],
      edges: [],
      chunkCount: chunks.length,
      cacheHits,
      llmCalls,
      gate: null,
      failedChunks,
      mock,
    }
  }

  // 章节内合并
  const chapterMerged = new Map<string | null, MergedNode[]>()
  const allChapterDrafts: DraftWithChunk[] = []
  for (const [chapterKey, bucket] of chunkDrafts) {
    const merged = mergeNodeDrafts({ entries: bucket.drafts })
    chapterMerged.set(chapterKey === 'root' ? null : chapterKey, merged)
    allChapterDrafts.push(...bucket.drafts)
  }

  // reduce：全局汇总（先搭总纲）
  //
  // 关键：reduce 必须「看得懂」概念，而不只是看到标题。
  // 因此这里给每个节点补上摘要与「出现在哪些章节」——这正是「好几章讲同一个大概念的不同侧面」
  // 能被识别为同一坨的前提。章节只作上下文，prompt 里明确禁止按章机械分组。
  const chapterTitles = new Map<string, string>()
  for (const item of options.outline) chapterTitles.set(item.id, item.title)

  // 目录不是知识点：与目录标题完全同名的节点一律排除（不进图、不当关联端点）
  const outlineKeys = outlineTitleKeys(options.outline)
  const isOutlineNode = (title: string): boolean => isOutlineDerivedTitle(title, outlineKeys)

  interface SummaryEntry {
    title: string
    importance: number
    difficulty: number
    page: number | null
    summary: string
    chapters: Set<string>
    cognitiveLevel: number
    unitKind: string
  }
  const summaryByKey = new Map<string, SummaryEntry>()
  for (const [chapterKey, mergedList] of chapterMerged) {
    const chapterTitle =
      chapterKey === null ? '' : (chapterTitles.get(chapterKey) ?? '')
    for (const merged of mergedList) {
      if (isOutlineNode(merged.title)) continue
      const existing = summaryByKey.get(merged.key)
      if (existing === undefined) {
        summaryByKey.set(merged.key, {
          title: merged.title,
          importance: merged.importance,
          difficulty: merged.difficulty,
          page: merged.page,
          summary: merged.summary.slice(0, 80),
          chapters: new Set(chapterTitle === '' ? [] : [chapterTitle]),
          cognitiveLevel: merged.cognitiveLevel,
          unitKind: merged.unitKind,
        })
        continue
      }
      existing.importance = Math.max(existing.importance, merged.importance)
      existing.difficulty = Math.max(existing.difficulty, merged.difficulty)
      if (existing.page === null && merged.page !== null) existing.page = merged.page
      if (merged.summary.length > existing.summary.length) existing.summary = merged.summary.slice(0, 80)
      if (merged.cognitiveLevel < existing.cognitiveLevel) {
        existing.cognitiveLevel = merged.cognitiveLevel
        existing.unitKind = merged.unitKind
      }
      if (chapterTitle !== '') existing.chapters.add(chapterTitle)
    }
  }

  const summary = [...summaryByKey.values()].map((entry) => ({
    title: entry.title,
    importance: entry.importance,
    difficulty: entry.difficulty,
    page: entry.page,
    summary: entry.summary,
    cognitiveLevel: entry.cognitiveLevel,
    unitKind: entry.unitKind,
  }))

  // 分块阶段的关系候选：按出现次数排序，交给 reduce 采纳/纠正/补全（而不是从零编）
  const candidateCounts = new Map<
    string,
    { source: string; target: string; relationType: LlmEdgeDraft['relationType']; count: number }
  >()
  for (const [, bucket] of chunkDrafts) {
    for (const edge of bucket.edges) {
      const key = `${edge.sourceTitle}\u0000${edge.targetTitle}\u0000${edge.relationType}`
      const existing = candidateCounts.get(key)
      if (existing === undefined) {
        candidateCounts.set(key, {
          source: edge.sourceTitle,
          target: edge.targetTitle,
          relationType: edge.relationType,
          count: 1,
        })
      } else {
        existing.count += 1
      }
    }
  }
  const candidates = [...candidateCounts.values()].sort((a, b) => b.count - a.count).slice(0, 40)

  // 大文档两阶段汇总：节点太多时先分批，再把批次结果汇总一次
  // （单次塞几百个节点会被 maxTokens 截断 → JSON 非法，这是大文档失败的主因）
  const plan = planReduceBatches(summary.length)

  /** 把最终汇总用到的节点草案压成 reduce 输入形状（字段齐全、类型收窄）。 */
  const toReduceInput = (draft: {
    title: string
    importance: number
    difficulty?: number
    page: number | null
    summary: string
    cognitiveLevel?: number
    unitKind?: string
  }) => ({
    title: draft.title,
    importance: draft.importance,
    difficulty: draft.difficulty ?? 3,
    page: draft.page,
    summary: draft.summary,
    cognitiveLevel: draft.cognitiveLevel ?? 1,
    unitKind: draft.unitKind ?? 'concept',
  })

  const reduceBatch = async (
    batchNodes: typeof summary,
    insistEdges: boolean,
    force: boolean,
  ): Promise<{ ok: true; payload: GlobalGraphResult; cacheHit: boolean; mock: boolean } | { ok: false; error: string }> => {
    const batchHash = await hashChunk({
      text: batchNodes.map((node) => node.title).join('|'),
      pageStart: 1,
      outlineTitle: null,
    })
    const result = await runJsonStage<GlobalGraphResult>({
      documentId: options.documentId,
      stage: 'global_reduce',
      chunkId: null,
      chunkHash: batchHash,
      promptVersion: GLOBAL_REDUCE_VERSION,
      buildPrompt: () =>
        globalReducePrompt.build({ nodes: batchNodes, candidates, language, insistEdges }),
      schema: GlobalGraphResultSchema,
      transport,
      signal: options.signal,
      force,
      useCache: options.cache !== false,
    })
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, payload: result.payload, cacheHit: result.cacheHit, mock: result.mock }
  }

  const failGlobal = (message: string): ExtractionOutcome => ({
    nodes: [],
    edges: [],
    chunkCount: chunks.length,
    cacheHits,
    llmCalls: llmCalls + 1,
    gate: null,
    failedChunks: [
      ...failedChunks,
      { chunkId: 'global', pageStart: 0, pageEnd: 0, error: `全局汇总失败：${message}` },
    ],
    mock,
  })

  const batchPayloads: GlobalGraphResult[] = []
  for (const batch of plan.batches) {
    const batchNodes = batch.map((index) => summary[index]!)
    const result = await reduceBatch(batchNodes, false, options.force === true)
    if (!result.ok) return failGlobal(result.error)
    if (result.cacheHit) cacheHits += 1
    else llmCalls += 1
    mock = mock || result.mock
    batchPayloads.push(result.payload)
  }

  if (batchPayloads.length === 0) {
    return failGlobal('没有可汇总的节点')
  }

  let reducedPayload: GlobalGraphResult
  if (plan.needsFinal) {
    // 最终汇总只喂前 80 个（按重要度），避免再次超长
    const finalNodes = [...batchPayloads.flatMap((payload) => payload.nodes)]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, REDUCE_LIMITS.batchSize)
      .map(toReduceInput)
    const finalResult = await reduceBatch(finalNodes, false, options.force === true)
    if (!finalResult.ok) {
      // 兜底：最终汇总失败时，保留各批次的结果（部分图谱 + 明确警告），而不是整篇归零
      failedChunks.push({
        chunkId: 'global-final',
        pageStart: 0,
        pageEnd: 0,
        error: `最终汇总失败（已保留分批结果）：${finalResult.error}`,
      })
      reducedPayload = {
        stage: 'global_reduce',
        nodes: batchPayloads.flatMap((payload) => payload.nodes),
        edges: batchPayloads.flatMap((payload) => payload.edges),
        merges: batchPayloads.flatMap((payload) => payload.merges),
      }
    } else {
      if (finalResult.cacheHit) cacheHits += 1
      else llmCalls += 1
      mock = mock || finalResult.mock
      reducedPayload = {
        ...finalResult.payload,
        merges: [...batchPayloads.flatMap((payload) => payload.merges), ...finalResult.payload.merges],
      }
    }
  } else {
    reducedPayload = batchPayloads[0]!
  }

  // 模型偶尔交出一整屏孤立节点：追加一次「必须补关系」的重试（仍走同一 zod 校验，不伪造数据）
  if (reducedPayload.nodes.length > 1 && reducedPayload.edges.length === 0) {
    const retryNodes = reducedPayload.nodes.map(toReduceInput)
    const retried = await reduceBatch(retryNodes, true, true)
    if (retried.ok && retried.payload.edges.length > 0) {
      reducedPayload = retried.payload
      llmCalls += 1
    }
  }

  const globalMerged = mergeNodeDrafts({
    entries: reducedPayload.nodes.map((draft) => ({ draft, chunkId: null })),
    merges: reducedPayload.merges,
  }).filter((merged) => !isOutlineNode(merged.title))

  // 全局节点
  const globalNodes = globalMerged.map((merged) =>
    toKnowledgeNode({
      documentId: options.documentId,
      merged,
      scope: 'global',
      chapterId: null,
      parentId: null,
      pages: options.pages,
      sourceChunkId: merged.chunkId,
    }),
  )
  const globalByNorm = new Map<string, string>()
  for (const node of globalNodes) {
    if (!globalByNorm.has(node.titleNorm)) globalByNorm.set(node.titleNorm, node.id)
  }

  // 章节节点（parentId 指向同名全局节点，找不到则 null —— 依然由总览图承载层级）
  const chapterNodes: KnowledgeNode[] = []
  for (const [chapterId, mergedList] of chapterMerged) {
    for (const merged of mergedList) {
      if (isOutlineNode(merged.title)) continue
      chapterNodes.push(
        toKnowledgeNode({
          documentId: options.documentId,
          merged,
          scope: 'chapter',
          chapterId,
          parentId: globalByNorm.get(merged.key) ?? null,
          pages: options.pages,
          sourceChunkId: merged.chunkId,
        }),
      )
    }
  }

  // 认知层级校准（确定性、只升不降）：模型偏保守，用语篇标记补上连接/推断/组织/选择
  const calibratedGlobalNodes = calibrateLevels(globalNodes)
  const calibratedChapterNodes = calibrateLevels(chapterNodes)

  // 全局节点继承「章节节点上的理解性字段」（reduce 只看标题，写不出类比）
  const enrichedGlobalNodes = inheritUnderstandingFields(calibratedGlobalNodes, calibratedChapterNodes)

  // 边：章节边优先在章节节点内解析，全局边在全局节点内解析
  const edges: KnowledgeEdge[] = []
  for (const [chapterKey, bucket] of chunkDrafts) {
    const chapterId = chapterKey === 'root' ? null : chapterKey
    const scoped = calibratedChapterNodes.filter((node) => node.chapterId === chapterId)
    const byNorm = new Map<string, string>()
    for (const node of scoped) if (!byNorm.has(node.titleNorm)) byNorm.set(node.titleNorm, node.id)
    // 章节内同名节点可能只存在于全局图：回落到全局节点
    for (const [norm, id] of globalByNorm) if (!byNorm.has(norm)) byNorm.set(norm, id)
    edges.push(
      ...toKnowledgeEdges({ documentId: options.documentId, drafts: bucket.edges, byNorm, language }),
    )
  }
  edges.push(
    ...toKnowledgeEdges({
      documentId: options.documentId,
      drafts: reducedPayload.edges,
      byNorm: globalByNorm,
      language,
    }),
  )

  /**
   * 章节边提升为全局边。
   *
   * 为什么需要：全局视图只渲染 scope='global' 的节点，而 chunk 阶段抽出的边
   * 绝大多数连接的是**章节节点**（它们带 parentId 指向同名全局节点）。
   * 不做提升的话，全局图就只剩 reduce 阶段给的边 —— 一旦 reduce 不给边，
   * 整张总览图就没有任何箭头、大小也全都一样（2026-11-20 真实手册实测踩到）。
   */
  const chapterParent = new Map<string, string>()
  for (const node of chapterNodes) {
    if (node.parentId !== null) chapterParent.set(node.id, node.parentId)
  }
  const existingKeys = new Set(edges.map((edge) => `${edge.sourceId}|${edge.targetId}|${edge.relationType}`))
  for (const edge of [...edges]) {
    const source = chapterParent.get(edge.sourceId)
    const target = chapterParent.get(edge.targetId)
    if (source === undefined || target === undefined || source === target) continue
    const key = `${source}|${target}|${edge.relationType}`
    if (existingKeys.has(key)) continue
    existingKeys.add(key)
    edges.push({ ...edge, id: newId(), sourceId: source, targetId: target })
  }

  void allChapterDrafts

  /**
   * 全局节点继承锚点：
   * reduce 阶段只拿得到标题、拿不到原文，所以全局节点的 anchor 天然为空。
   * 若同名（titleNorm 相同）章节节点已经定位到真实 quote，就继承过来 —— 同一实体的真实证据，
   * 不是编造；继承不到就保持 null，UI 明确显示「无原文锚点」。
   */
  const chapterAnchorByNorm = new Map<string, NonNullable<KnowledgeNode['anchor']>>()
  for (const node of chapterNodes) {
    if (node.anchor !== null && !chapterAnchorByNorm.has(node.titleNorm)) {
      chapterAnchorByNorm.set(node.titleNorm, node.anchor)
    }
  }
  const globalNodesWithAnchor = enrichedGlobalNodes.map((node) => {
    if (node.anchor !== null) return node
    const inherited = chapterAnchorByNorm.get(node.titleNorm)
    return inherited === undefined ? node : { ...node, anchor: inherited }
  })

  return {
    // 章节节点返回**校准后**的版本：calibrateLevels 的结果以前只喂给继承函数，没落库
    nodes: [...globalNodesWithAnchor, ...calibratedChapterNodes],
    edges,
    chunkCount: chunks.length,
    cacheHits,
    llmCalls,
    failedChunks,
    mock,
    gate: null,
  }
}

/**
 * 章节子图抽取（模块二）。
 * 只跑该章节对应块的 map 阶段，**不跑全局 reduce**：
 * 块缓存与全局抽取共用同一 key，所以「先全局后章节」是 0 次网络调用。
 */
export async function runChapterExtraction(
  options: RunExtractionOptions & {
    readonly chapterId: string
    readonly chapterTitle: string
    /** 章节的页码范围（含端点）。 */
    readonly chapterPageFrom: number
    readonly chapterPageTo: number
  },
): Promise<ExtractionOutcome> {
  const transport = options.transport ?? defaultTransport
  const language = options.language ?? DEFAULT_PRIMARY_LANGUAGE
  // 关键：仍然对**全文**切块（与全局抽取完全一致），再按页码范围筛选。
  // 这样块边界、块哈希、缓存 key 全部一致，章节子图必然命中全局抽取的缓存。
  const allChunks = buildChunks(options.pages, options.outline, options.targetTokens)
  const chunks = allChunks.filter(
    (chunk) => chunk.pageStart <= options.chapterPageTo && chunk.pageEnd >= options.chapterPageFrom,
  )

  // 与全局抽取共用同一并发实现（此前这里是串行循环，所以章节拆解明显更慢）
  const stage = await runChunkStage({
    documentId: options.documentId,
    chunks,
    outline: options.outline,
    language,
    transport,
    signal: options.signal,
    force: options.force === true,
    useCache: options.cache !== false,
    concurrency: options.concurrency,
    onProgress: options.onProgress,
  })
  let cacheHits = stage.cacheHits
  let llmCalls = stage.llmCalls
  let mock = stage.mock
  const failedChunks: FailedChunk[] = [...stage.failedChunks]

  const entries: DraftWithChunk[] = []
  const edgeDrafts: LlmEdgeDraft[] = []
  for (const outcome of stage.outcomes) {
    if (outcome.payload === undefined) continue
    entries.push(...outcome.payload.nodes.map((draft) => ({ draft, chunkId: outcome.chunkId })))
    edgeDrafts.push(...outcome.payload.edges)
  }

  const outlineKeys = outlineTitleKeys(options.outline)
  const isOutlineNode = (title: string): boolean => isOutlineDerivedTitle(title, outlineKeys)
  // 目录标题不是知识点：先滤掉，再建节点（否则它们会被当成章节根或首节点）
  const merged = mergeNodeDrafts({ entries }).filter((node) => !isOutlineNode(node.title))
  const timestamp = Date.now()

  // 不再造「章节根节点」：目录不是知识点，章节只作为视图范围（chapterId），不进入图的节点与关系
  const children = merged.map((node) =>
    toKnowledgeNode({
      documentId: options.documentId,
      merged: node,
      scope: 'chapter',
      chapterId: options.chapterId,
      parentId: null,
      pages: options.pages,
      sourceChunkId: node.chunkId,
    }),
  )

  const byNorm = new Map<string, string>()
  for (const node of children) if (!byNorm.has(node.titleNorm)) byNorm.set(node.titleNorm, node.id)

  const chapterEdges = toKnowledgeEdges({
    documentId: options.documentId,
    drafts: edgeDrafts,
    byNorm,
    language: options.language ?? DEFAULT_PRIMARY_LANGUAGE,
  })
  const chapterNodes = [...children]
  const chapterNodeIds = new Set(chapterNodes.map((node) => node.id))
  const gate = summarizeGate(
    gateUnits(
      chapterNodes.map((node) => ({
        id: node.id,
        title: node.title,
        titleNorm: node.titleNorm,
        summary: node.summary,
        cognitiveLevel: node.cognitiveLevel,
        priorKnowledge: node.priorKnowledge,
      })),
      chapterEdges
        .filter((edge) => chapterNodeIds.has(edge.sourceId) && chapterNodeIds.has(edge.targetId))
        .map((edge) => ({
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          relationType: edge.relationType,
        })),
    ),
  )

  return {
    nodes: chapterNodes,
    edges: chapterEdges,
    chunkCount: chunks.length,
    cacheHits,
    llmCalls,
    failedChunks,
    mock,
    gate,
  }
}
