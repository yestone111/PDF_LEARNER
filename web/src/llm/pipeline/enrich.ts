/**
 * 单节点「按需分析」。
 *
 * 场景：抽取只给了标题、没有摘要/锚点的节点，用户点开时是空的。
 * 这里按需调用一次模型，把结论写回同一个节点（不新建节点、不改图结构）。
 *
 * 纪律：
 *  - quote 只接受能在原文里逐字定位的片段，定位不到就不写锚点（不编造页码）；
 *  - 结果过 zod 才入库；失败抛出明确错误，由 UI 显示，不静默吞掉。
 */

import { KnowledgeNodeSchema, NodeEnrichResultSchema, parseStrict } from '../../domain'
import { getDb } from '../../db/database'
import { calibrateLevel } from './calibrateLevels'
import { locateQuote } from './anchor'
import { requestExtraction } from '../client'
import { NODE_ENRICH_VERSION, nodeEnrichPrompt } from '../prompts/nodeEnrich'
import { readAllPagesText } from './controller'
import { useDocumentStore } from '../../stores/documentStore'
import { useGraphStore } from '../../stores/graphStore'
import { useUiStore } from '../../stores/uiStore'

import type { KnowledgeNode } from '../../domain'

const MAX_CONTEXT_CHARS = 4000

function nearbyText(pages: readonly { page: number; text: string }[], page: number): string {
  const window = pages.filter((item) => Math.abs(item.page - page) <= 1)
  const joined = (window.length > 0 ? window : pages.slice(0, 2))
    .map((item) => item.text)
    .join('\n')
  return joined.slice(0, MAX_CONTEXT_CHARS)
}

/** 模型输出归一：夹取数值、裁字符串、清洗四问；结构与 zod 对齐。 */
export function normalizeEnrichPayload(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const source = raw as Record<string, unknown>
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
    if (!Number.isFinite(numeric)) return fallback
    return Math.min(max, Math.max(min, Math.round(numeric)))
  }
  const text = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : ''

  const elaboration = source.elaboration
  const cleanedElaboration =
    typeof elaboration === 'object' && elaboration !== null
      ? {
          analogy: text((elaboration as Record<string, unknown>).analogy, 300),
          contrast: text((elaboration as Record<string, unknown>).contrast, 300),
          why: text((elaboration as Record<string, unknown>).why, 300),
          misconception: text((elaboration as Record<string, unknown>).misconception, 300),
        }
      : null

  const level = clamp(source.cognitiveLevel, 1, 5, 1) as 1 | 2 | 3 | 4 | 5
  const kinds = ['concept', 'relation', 'inference', 'structure', 'keypoint'] as const
  const kindRaw = typeof source.unitKind === 'string' ? source.unitKind.trim().toLowerCase() : ''
  const kind = kinds.find((item) => item === kindRaw) ?? 'concept'

  return {
    summary: text(source.summary, 400),
    quote: text(source.quote, 600),
    priorKnowledge: Array.isArray(source.priorKnowledge)
      ? source.priorKnowledge
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .slice(0, 3)
      : [],
    elaboration:
      cleanedElaboration === null ||
      Object.values(cleanedElaboration).every((value) => value === '')
        ? null
        : cleanedElaboration,
    selfCheck: text(source.selfCheck, 200),
    difficulty: clamp(source.difficulty, 1, 5, 3),
    cognitiveLevel: level,
    unitKind: kind,
  }
}

export interface EnrichOutcome {
  readonly node: KnowledgeNode
  readonly mock: boolean
}

export async function enrichNode(nodeId: string): Promise<EnrichOutcome> {
  const node = useGraphStore.getState().nodesById[nodeId]
  if (node === undefined) throw new Error('节点不存在（可能刚被重新抽取覆盖）')
  const document = useDocumentStore.getState().document
  if (document === null) throw new Error('请先打开 PDF')

  const pages = await readAllPagesText()
  const page = node.anchor?.page ?? pages[0]?.page ?? 1
  const text = nearbyText(pages, page)
  if (text.trim() === '') throw new Error('取不到原文片段，无法分析')

  const prompt = nodeEnrichPrompt.build({
    title: node.title,
    page,
    text,
    language: useUiStore.getState().primaryLanguage,
  })
  const response = await requestExtraction({
    messages: prompt.messages,
    promptVersion: NODE_ENRICH_VERSION,
    stage: 'node_enrich',
    maxTokens: prompt.maxTokens,
  })

  let json: unknown
  try {
    json = JSON.parse(response.content)
  } catch {
    throw new Error('模型没有返回合法 JSON，请重试')
  }
  const checked = parseStrict(NodeEnrichResultSchema, normalizeEnrichPayload(json), 'node_enrich')
  if (!checked.ok) throw new Error(`分析结果不符合约定：${checked.message}`)

  const payload = checked.data
  const calibrated = calibrateLevel({
    title: node.title,
    summary: payload.summary,
    cognitiveLevel: payload.cognitiveLevel,
    unitKind: payload.unitKind,
  })
  const anchor =
    payload.quote === '' ? node.anchor : (locateQuote(payload.quote, page, pages) ?? node.anchor)

  const updated = KnowledgeNodeSchema.parse({
    ...node,
    summary: payload.summary !== '' ? payload.summary : node.summary,
    priorKnowledge: payload.priorKnowledge.length > 0 ? payload.priorKnowledge : node.priorKnowledge,
    elaboration: payload.elaboration ?? node.elaboration,
    selfCheck: payload.selfCheck !== '' ? payload.selfCheck : node.selfCheck,
    difficulty: payload.difficulty,
    cognitiveLevel: calibrated.cognitiveLevel,
    unitKind: calibrated.unitKind,
    anchor,
    updatedAt: Date.now(),
  }) as KnowledgeNode

  await getDb().knowledgeNodes.put(updated)
  useGraphStore.getState().upsertNodes([updated])
  return { node: updated, mock: response.mock }
}
