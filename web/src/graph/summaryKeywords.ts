/**
 * 章节速览里的关键词联动。
 *
 * 目标：速览正文里出现的知识点名称（标题或别名）渲染成可点关键词，
 * 点击 → 选中下方图谱里的同一个节点（图谱会高亮它、弱化其余节点）。
 *
 * 匹配用「逐字符 NFKC + 小写 + 去空白」的归一化串，并保留「归一化字符 → 原文下标」的映射，
 * 这样中文/全角/换行差异都不影响命中，同时还能精确切回原文位置做高亮。
 */

export interface KeywordNode {
  readonly id: string
  readonly title: string
  readonly aliases: readonly string[]
}

export interface SummarySegment {
  readonly text: string
  /** 非空表示这段是某知识点的关键词。 */
  readonly nodeId: string | null
}

interface Indexed {
  readonly norm: string
  /** 归一化串第 i 个字符对应原文的下标。 */
  readonly map: readonly number[]
}

function foldChar(char: string): string {
  return char.normalize('NFKC').toLowerCase()
}

function indexText(text: string): Indexed {
  const chars: string[] = []
  const map: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (/\s/u.test(char)) continue
    const folded = foldChar(char)
    for (const piece of folded) {
      chars.push(piece)
      map.push(index)
    }
  }
  return { norm: chars.join(''), map }
}

function normalizeKey(key: string): string {
  let out = ''
  for (const char of key) {
    if (/\s/u.test(char)) continue
    out += foldChar(char)
  }
  return out
}

interface Match {
  readonly start: number
  readonly end: number
  readonly nodeId: string
}

/**
 * 把速览正文切成普通文本段与关键词段（按原文顺序，互不重叠）。
 * 同一位置命中多个关键词时，取更长的那一个（标题优先于短别名）。
 */
export function annotateSummary(summary: string, nodes: readonly KeywordNode[]): SummarySegment[] {
  if (summary === '') return []
  const indexed = indexText(summary)

  const keys: { key: string; nodeId: string }[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    for (const candidate of [node.title, ...node.aliases]) {
      const key = normalizeKey(candidate)
      // 太短的关键词（1 个字）会在正文里疯狂误命中，直接忽略
      if (key.length < 2) continue
      if (seen.has(key)) continue
      seen.add(key)
      keys.push({ key, nodeId: node.id })
    }
  }
  if (keys.length === 0 || indexed.norm === '') return [{ text: summary, nodeId: null }]

  const matches: Match[] = []
  for (const { key, nodeId } of keys) {
    let from = 0
    for (;;) {
      const at = indexed.norm.indexOf(key, from)
      if (at === -1) break
      const rawStart = indexed.map[at]
      const rawEnd = indexed.map[at + key.length - 1]
      if (rawStart !== undefined && rawEnd !== undefined) {
        matches.push({ start: rawStart, end: rawEnd + 1, nodeId })
      }
      from = at + 1
    }
  }
  if (matches.length === 0) return [{ text: summary, nodeId: null }]

  // 长匹配优先、起点靠前优先；再贪心去重叠
  matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const accepted: Match[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    accepted.push(match)
    cursor = match.end
  }

  const segments: SummarySegment[] = []
  let position = 0
  for (const match of accepted) {
    if (match.start > position) {
      segments.push({ text: summary.slice(position, match.start), nodeId: null })
    }
    segments.push({ text: summary.slice(match.start, match.end), nodeId: match.nodeId })
    position = match.end
  }
  if (position < summary.length) segments.push({ text: summary.slice(position), nodeId: null })
  return segments
}
