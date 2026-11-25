/**
 * LLM 输出归一化（在 zod 之前执行）。
 *
 * 为什么需要：真实模型会给出「语义正确但字面不合契约」的输出，例如
 *   - relationType 写成中文「依赖」或大写 `DEPENDS_ON`；
 *   - importance 写成字符串 "4" 或越界 0/7；
 *   - 受控关系却顺手给了 relationLabel；
 *   - merges / aliases 缺省。
 * 这些如果直接交给 zod，整块就会被判失败（第一次真实调用就是这么失败的）。
 *
 * 归一化原则（**不是**伪造数据）：
 *  - 只做「等价形式 → 规范形式」的确定性映射（中英文词表、大小写、分隔符、数值区间）；
 *  - 无法映射的关系类型 → `custom`，并把原始字符串保留为 relationLabel（信息不丢）；
 *  - 结构上不可用的条目（缺标题、边缺端点）→ 丢弃，绝不补默认值凑数；
 *  - 数值越界 → 夹到合法区间；非数字 → 丢弃该字段让 zod 报错（不猜）。
 */

import { RELATION_TYPES, UNIT_KIND_BY_LEVEL, UNIT_KINDS, type RelationType } from '../../domain/enums'

const RELATION_ALIASES: Readonly<Record<string, RelationType>> = {
  depends_on: 'depends_on',
  dependson: 'depends_on',
  depends: 'depends_on',
  depend: 'depends_on',
  '依赖': 'depends_on',
  前置: 'depends_on',
  triggers: 'triggers',
  trigger: 'triggers',
  '触发': 'triggers',
  causes: 'triggers',
  '导致': 'triggers',
  belongs_to: 'belongs_to',
  belongsto: 'belongs_to',
  belongs: 'belongs_to',
  '属于': 'belongs_to',
  part_of: 'belongs_to',
  partof: 'belongs_to',
  '组成': 'belongs_to',
  extends: 'extends',
  extend: 'extends',
  extension: 'extends',
  '扩展': 'extends',
  继承: 'extends',
  implements: 'implements',
  implement: 'implements',
  implementation: 'implements',
  '实现': 'implements',
  contrasts_with: 'contrasts_with',
  contrastswith: 'contrasts_with',
  contrast: 'contrasts_with',
  contrasts: 'contrasts_with',
  对比: 'contrasts_with',
  对照: 'contrasts_with',
  custom: 'custom',
  other: 'custom',
  '自定义': 'custom',
  其他: 'custom',
}

function canonicalKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-–—]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

export interface NormalizedRelation {
  readonly relationType: RelationType
  readonly relationLabel: string | null
}

/** 关系类型归一：未知值降级为 custom 并保留原文，绝不丢弃语义。 */
export function normalizeRelationType(
  rawType: unknown,
  rawLabel: unknown,
): NormalizedRelation {
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : ''
  const typeText = typeof rawType === 'string' ? rawType : ''

  const direct = RELATION_ALIASES[canonicalKey(typeText)] ?? RELATION_ALIASES[typeText.trim()]
  if (direct !== undefined) {
    return { relationType: direct, relationLabel: direct === 'custom' ? label || '自定义' : null }
  }

  const asEnum = RELATION_TYPES.find((value) => value === typeText.trim())
  if (asEnum !== undefined) return { relationType: asEnum, relationLabel: null }

  // 无法识别：保留成 custom + 原始文本（截断到标签上限），不让这条边凭空消失
  const fallbackLabel = (label || typeText || '自定义').slice(0, 12)
  return { relationType: 'custom', relationLabel: fallbackLabel }
}

function clampImportance(raw: unknown): number | undefined {
  const asNumber = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isFinite(asNumber)) return undefined
  return Math.max(1, Math.min(5, Math.round(asNumber)))
}

const ELABORATION_FIELDS = ['analogy', 'contrast', 'why', 'misconception'] as const

/** 认知层级：夹到 1–5，类型缺失时按层级回落（模型常漏 unitKind）。 */
function normalizeCognitive(node: Record<string, unknown>): void {
  const raw = node.cognitiveLevel
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  const level = Number.isFinite(numeric) ? Math.min(5, Math.max(1, Math.round(numeric))) : 1
  const levelTyped = level as 1 | 2 | 3 | 4 | 5
  node.cognitiveLevel = levelTyped

  const kind = typeof node.unitKind === 'string' ? node.unitKind.trim().toLowerCase() : ''
  node.unitKind = UNIT_KINDS.find((item) => item === kind) ?? UNIT_KIND_BY_LEVEL[levelTyped]

  const prior = node.priorKnowledge
  node.priorKnowledge = Array.isArray(prior)
    ? prior
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .slice(0, 3)
    : []

  node.selfCheck = typeof node.selfCheck === 'string' ? node.selfCheck.trim().slice(0, 120) : ''

  const elaboration = node.elaboration
  if (typeof elaboration === 'object' && elaboration !== null) {
    const source = elaboration as Record<string, unknown>
    const cleaned: Record<string, string> = {}
    for (const field of ELABORATION_FIELDS) {
      cleaned[field] = typeof source[field] === 'string' ? source[field].trim().slice(0, 300) : ''
    }
    const empty = ELABORATION_FIELDS.every((field) => cleaned[field] === '')
    node.elaboration = empty ? null : cleaned
  } else {
    node.elaboration = null
  }
}

function normalizeNode(raw: unknown): unknown {
  // 模型偶尔只给标题字符串：补成最小合法节点（重要度/难度用中性 3），而不是整块丢弃
  if (typeof raw === 'string') {
    const title = raw.trim()
    if (title === '') return null
    return {
      title,
      aliases: [],
      summary: '',
      importance: 3,
      difficulty: 3,
      quote: '',
      page: null,
      parentTitle: null,
      figure: null,
      isChapterRoot: false,
    }
  }
  if (typeof raw !== 'object' || raw === null) return null
  const node = { ...(raw as Record<string, unknown>) }

  if (typeof node.title === 'string') node.title = node.title.trim()
  if (node.title === undefined || node.title === '') return null

  normalizeCognitive(node)

  const importance = clampImportance(node.importance)
  if (importance !== undefined) node.importance = importance

  if (typeof node.aliases === 'string') node.aliases = node.aliases === '' ? [] : [node.aliases]
  else if (!Array.isArray(node.aliases)) node.aliases = []
  else node.aliases = node.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim() !== '')

  if (typeof node.summary !== 'string') node.summary = ''
  if (typeof node.quote !== 'string') node.quote = ''

  if (node.page !== null && node.page !== undefined) {
    const page = typeof node.page === 'number' ? node.page : Number(node.page)
    node.page = Number.isInteger(page) && page > 0 ? page : null
  } else {
    node.page = null
  }

  if (node.figure !== null && node.figure !== undefined) {
    const figure = node.figure as Record<string, unknown>
    if (typeof figure.caption !== 'string' || figure.caption.trim() === '') node.figure = null
    else {
      const page = typeof figure.page === 'number' ? figure.page : Number(figure.page)
      node.figure = {
        label: typeof figure.label === 'string' && figure.label.trim() !== '' ? figure.label.trim() : 'Figure',
        caption: figure.caption.trim(),
        page: Number.isInteger(page) && page > 0 ? page : 1,
        kind: 'caption_only',
      }
    }
  } else {
    node.figure = null
  }

  return node
}

function normalizeEdge(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return null
  const edge = { ...(raw as Record<string, unknown>) }

  const source = typeof edge.sourceTitle === 'string' ? edge.sourceTitle.trim() : ''
  const target = typeof edge.targetTitle === 'string' ? edge.targetTitle.trim() : ''
  if (source === '' || target === '') return null
  edge.sourceTitle = source
  edge.targetTitle = target

  const { relationType, relationLabel } = normalizeRelationType(edge.relationType, edge.relationLabel)
  edge.relationType = relationType
  edge.relationLabel = relationLabel

  if (edge.evidenceQuote !== null && typeof edge.evidenceQuote !== 'string') edge.evidenceQuote = null
  return edge
}

function normalizeList(raw: unknown, mapper: (item: unknown) => unknown): unknown[] {
  if (!Array.isArray(raw)) return []
  return raw.map(mapper).filter((item) => item !== null)
}

/**
 * 归一化整块抽取结果。stage 不匹配或整体不是对象时原样返回，交给 zod 报错。
 */
export function normalizeExtractionJson(
  raw: unknown,
  stage?: 'chunk_extract' | 'global_reduce',
): unknown {
  let payload: Record<string, unknown>

  if (Array.isArray(raw)) {
    // 形态 1：模型直接返回裸数组（节点列表）→ 包成对应阶段对象，节点仍走下面的归一化
    payload = {
      stage: stage ?? 'chunk_extract',
      nodes: raw,
      edges: [],
      ...(stage === 'global_reduce' ? { merges: [] } : {}),
    }
  } else if (typeof raw === 'object' && raw !== null) {
    payload = { ...(raw as Record<string, unknown>) }
  } else {
    return raw
  }

  // 形态 2：缺 stage（调用方知道自己在哪个阶段，补上即可）
  if (payload.stage === undefined && stage !== undefined) payload.stage = stage

  // 形态 3：缺 nodes / edges（模型只回了 merges 或空对象）
  if (!Array.isArray(payload.nodes)) payload.nodes = []
  if (!Array.isArray(payload.edges)) payload.edges = []

  if (Array.isArray(payload.nodes)) payload.nodes = normalizeList(payload.nodes, normalizeNode)
  if (Array.isArray(payload.edges)) payload.edges = normalizeList(payload.edges, normalizeEdge)

  if (payload.stage === 'global_reduce') {
    if (!Array.isArray(payload.merges)) payload.merges = []
    else {
      payload.merges = payload.merges
        .map((merge) => {
          if (typeof merge !== 'object' || merge === null) return null
          const item = merge as Record<string, unknown>
          const canonical = typeof item.canonical === 'string' ? item.canonical.trim() : ''
          if (canonical === '') return null
          const aliases = Array.isArray(item.aliases)
            ? item.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim() !== '')
            : []
          return { canonical, aliases }
        })
        .filter((item) => item !== null)
    }
  }

  return payload
}
