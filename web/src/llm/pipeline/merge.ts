/**
 * 实体合并（reduce 的核心纯逻辑）。
 *
 * 规则（与 prompt 里的说明必须一致）：
 *  1. 标题归一化后**完全相同**才自动合并；
 *  2. 或由 LLM 在 `merges[]` 里显式声明（canonical + aliases）；
 *  3. 不做编辑距离/同义词猜测 —— 误合比不合更难发现；
 *  4. 冲突（同一 alias 指向两个 canonical）保留第一个，其余不动。
 */

import { UNIT_KIND_BY_LEVEL } from '../../domain/enums'
import type { CognitiveLevel, Importance, UnitKind } from '../../domain/enums'
import type { Elaboration, EntityMerge, KnowledgeFigure, LlmNodeDraft } from '../../domain/types'

export interface DraftWithChunk {
  readonly draft: LlmNodeDraft
  readonly chunkId: string | null
}

export interface MergedNode {
  readonly key: string
  readonly title: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly importance: Importance
  readonly difficulty: Importance
  readonly cognitiveLevel: CognitiveLevel
  readonly unitKind: UnitKind
  readonly priorKnowledge: readonly string[]
  readonly elaboration: Elaboration | null
  readonly selfCheck: string
  readonly quote: string
  readonly page: number | null
  readonly figure: KnowledgeFigure | null
  readonly chunkId: string | null
  readonly isChapterRoot: boolean
}

/**
 * 归一化：NFKC → 去 LaTeX/Markdown 记号 → 小写 → 删所有标点/空白/符号。
 * 注意：**不**去掉「模型/技术/算法」这类语义后缀，否则 transformer 与 transformer模型 会被误合。
 */
export function normalizeTitle(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[$\\{}`*_#]/g, ' ')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\p{S}]/gu, '')
    .trim()
}

/** 把标题里的括号补充拆成别名：`Multi-Head Attention (MHA)` → 标题 + 别名 `MHA`。 */
export function splitParenthetical(title: string): { title: string; aliases: string[] } {
  const aliases: string[] = []
  const cleaned = title
    .replace(/[（(]([^）)]{1,40})[）)]/g, (_match, inner: string) => {
      const trimmed = inner.trim()
      if (trimmed !== '') aliases.push(trimmed)
      return ''
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { title: cleaned === '' ? title.trim() : cleaned, aliases }
}

/** LLM 只给 caption/页码，没有区域坐标；KnowledgeFigure.rects 允许为空（UI 只能跳页、不能框选）。 */
function toKnowledgeFigure(draft: LlmNodeDraft['figure']): KnowledgeFigure | null {
  if (draft === null) return null
  return { kind: draft.kind, label: draft.label, caption: draft.caption, page: draft.page, rects: [] }
}

function maxImportance(a: Importance, b: Importance): Importance {
  return (a >= b ? a : b) as Importance
}

export interface MergeInput {
  readonly entries: readonly DraftWithChunk[]
  readonly merges?: readonly EntityMerge[]
}

export function mergeNodeDrafts(input: MergeInput): MergedNode[] {
  const canonicalTitle = new Map<string, string>()
  const aliasMap = new Map<string, string>()

  for (const merge of input.merges ?? []) {
    const canonicalKey = normalizeTitle(merge.canonical)
    if (canonicalKey === '') continue
    canonicalTitle.set(canonicalKey, merge.canonical.trim())
    for (const alias of merge.aliases) {
      const aliasKey = normalizeTitle(alias)
      if (aliasKey === '' || aliasKey === canonicalKey) continue
      // 冲突时保留第一个 canonical（不静默改指）
      if (!aliasMap.has(aliasKey)) aliasMap.set(aliasKey, canonicalKey)
    }
  }

  const resolveKey = (key: string): string => {
    const seen = new Set<string>()
    let current = key
    for (;;) {
      const next = aliasMap.get(current)
      if (next === undefined || next === current || seen.has(next)) return current
      seen.add(current)
      current = next
    }
  }

  interface Accumulator {
    key: string
    titles: string[]
    aliases: Set<string>
    summary: string
    importance: Importance
    difficulty: Importance
    cognitiveLevel: CognitiveLevel
    unitKind: UnitKind
    priorKnowledge: Set<string>
    elaboration: { analogy: string; contrast: string; why: string; misconception: string }
    selfCheck: string
    quote: string
    page: number | null
    figure: KnowledgeFigure | null
    chunkId: string | null
    isChapterRoot: boolean
    firstTitle: string
  }

  const groups = new Map<string, Accumulator>()

  for (const { draft, chunkId } of input.entries) {
    const { title, aliases } = splitParenthetical(draft.title)
    const key = resolveKey(normalizeTitle(title))
    if (key === '') continue

    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        titles: [title],
        aliases: new Set([...aliases, ...draft.aliases]),
        summary: draft.summary,
        importance: draft.importance,
        difficulty: draft.difficulty ?? draft.importance,
        cognitiveLevel: draft.cognitiveLevel ?? 1,
        unitKind: draft.unitKind ?? UNIT_KIND_BY_LEVEL[draft.cognitiveLevel ?? 1],
        priorKnowledge: new Set(draft.priorKnowledge ?? []),
        selfCheck: draft.selfCheck ?? '',
        elaboration: {
          analogy: draft.elaboration?.analogy ?? '',
          contrast: draft.elaboration?.contrast ?? '',
          why: draft.elaboration?.why ?? '',
          misconception: draft.elaboration?.misconception ?? '',
        },
        quote: draft.quote,
        page: draft.page,
        figure: toKnowledgeFigure(draft.figure),
        chunkId,
        isChapterRoot: draft.isChapterRoot,
        firstTitle: title,
      })
      continue
    }

    existing.titles.push(title)
    for (const alias of [...aliases, ...draft.aliases]) existing.aliases.add(alias)
    if (draft.summary.length > existing.summary.length) existing.summary = draft.summary
    existing.importance = maxImportance(existing.importance, draft.importance)
    // 合并后的难度取最难的（只要某一处认为它难，就按难的算）
    existing.difficulty = maxImportance(existing.difficulty, draft.difficulty ?? draft.importance)
    // 认知层级取**较早**的一次（先学会的操作排在前面），类型随之回落
    const draftLevel = draft.cognitiveLevel ?? 1
    if (draftLevel < existing.cognitiveLevel) {
      existing.cognitiveLevel = draftLevel
      existing.unitKind = draft.unitKind ?? UNIT_KIND_BY_LEVEL[draftLevel]
    }
    for (const prior of draft.priorKnowledge ?? []) existing.priorKnowledge.add(prior)
    if (existing.selfCheck === '' && (draft.selfCheck ?? '') !== '') existing.selfCheck = draft.selfCheck ?? ''
    if (draft.elaboration !== undefined && draft.elaboration !== null) {
      const target = existing.elaboration
      for (const field of ['analogy', 'contrast', 'why', 'misconception'] as const) {
        if (target[field] === '' && (draft.elaboration[field] ?? '') !== '') {
          target[field] = draft.elaboration[field] ?? ''
        }
      }
    }
    if (existing.quote === '' && draft.quote !== '') {
      existing.quote = draft.quote
      existing.page = draft.page
    }
    if (existing.page === null && draft.page !== null) existing.page = draft.page
    if (existing.figure === null && draft.figure !== null) existing.figure = toKnowledgeFigure(draft.figure)
    if (existing.chunkId === null && chunkId !== null) existing.chunkId = chunkId
    existing.isChapterRoot = existing.isChapterRoot || draft.isChapterRoot
  }

  const result: MergedNode[] = []
  for (const group of groups.values()) {
    const canonical = canonicalTitle.get(group.key) ?? group.firstTitle
    const aliasSet = new Set<string>()
    for (const title of group.titles) {
      if (title.trim() !== '' && title.trim() !== canonical) aliasSet.add(title.trim())
    }
    for (const alias of group.aliases) {
      if (alias.trim() !== '' && alias.trim() !== canonical) aliasSet.add(alias.trim())
    }

    result.push({
      key: group.key,
      title: canonical,
      aliases: [...aliasSet],
      summary: group.summary,
      importance: group.importance,
      difficulty: group.difficulty,
      cognitiveLevel: group.cognitiveLevel,
      unitKind: group.unitKind,
      priorKnowledge: [...group.priorKnowledge].slice(0, 3),
      selfCheck: group.selfCheck,
      elaboration:
        group.elaboration.analogy === '' &&
        group.elaboration.contrast === '' &&
        group.elaboration.why === '' &&
        group.elaboration.misconception === ''
          ? null
          : group.elaboration,
      quote: group.quote,
      page: group.page,
      figure: group.figure,
      chunkId: group.chunkId,
      isChapterRoot: group.isChapterRoot,
    })
  }

  return result
}
