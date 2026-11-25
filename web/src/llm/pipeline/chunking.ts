/**
 * 切块（map 阶段的输入）。
 *
 * 策略：**按章节边界对齐**，超长章节再按页切成多块。
 * 为什么按章节：任务书要求「章节子图谱直接复用对应块的缓存」——
 * 如果块和章节不对齐，这个复用就不可能成立。
 */

import type { OutlineNode } from '../../domain/types'

export interface PageText {
  readonly page: number
  readonly text: string
}

export interface ChunkDraft {
  readonly outlineNodeId: string | null
  readonly pageStart: number
  readonly pageEnd: number
  readonly text: string
  readonly charCount: number
  readonly tokenEstimate: number
  readonly order: number
}

/** 默认块预算：1400 估算 token（含 prompt 余量后仍远低于模型上限）。 */
export const DEFAULT_CHUNK_TOKENS = 1400

/**
 * 粗略 token 估算：CJK 按 1 token/字，其他按 4 字符/token。
 * 只用于切块决策，不用于计费；宁可高估（块更小）也不低估（超长请求）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2e80) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

function chapterForPage(
  page: number,
  outline: readonly OutlineNode[],
): OutlineNode | null {
  let current: OutlineNode | null = null
  const ordered = outline
    .filter((node) => node.page !== null)
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.level - b.level)

  for (const node of ordered) {
    if ((node.page ?? 0) <= page) current = node
    else break
  }
  return current
}

export function buildChunks(
  pages: readonly PageText[],
  outline: readonly OutlineNode[],
  targetTokens: number = DEFAULT_CHUNK_TOKENS,
): ChunkDraft[] {
  if (pages.length === 0) return []

  const sorted = [...pages].sort((a, b) => a.page - b.page)
  const chunks: ChunkDraft[] = []

  let currentChapterId: string | null = null
  let currentPages: PageText[] = []

  const flush = (): void => {
    if (currentPages.length === 0) return
    const text = currentPages.map((page) => page.text).join('\n\n')
    chunks.push({
      outlineNodeId: currentChapterId,
      pageStart: currentPages[0].page,
      pageEnd: currentPages[currentPages.length - 1].page,
      text,
      charCount: text.length,
      tokenEstimate: estimateTokens(text),
      order: chunks.length,
    })
    currentPages = []
  }

  for (const page of sorted) {
    const chapter = chapterForPage(page.page, outline)
    const chapterId = chapter?.id ?? null
    const pageTokens = estimateTokens(page.text)

    if (currentPages.length > 0) {
      const sameChapter = chapterId === currentChapterId
      const currentTokens = currentPages.reduce((sum, item) => sum + estimateTokens(item.text), 0)
      if (!sameChapter || currentTokens + pageTokens > targetTokens) flush()
    }

    currentChapterId = chapterId
    currentPages.push(page)
  }

  flush()
  return repairSplitAttention(chunks, targetTokens)
}

/** 例子/图注引导语：出现这些词时，下一块大概率是它的延续。 */
const EXAMPLE_LEAD_IN = /(?:例如|比如|举例|示例|如下|诸如|for example|e\.g\.|such as|i\.e\.)[^\n]{0,30}[:：]?\s*$/i
const CAPTION_LEAD_IN = /^\s*(?:Figure|Fig\.?|Table|图|表)\s*\d+[a-zA-Z]?\s*[:：.]/i
const TRAILING_COLON = /[:：]\s*$/
const CAPTION_MENTION = /(?:Figure|Fig\.?|Table|图|表)\s*\d+/i

/**
 * 分割注意修复（CLT split-attention effect）。
 *
 * 「定义—例子」「图—图注」被切到两块时，读者要在两个块之间来回对照，外在负荷陡增。
 * 这里在**同一章节内**做配对合并：块尾是例子引导语/冒号，或下一块以图注开头，
 * 就并成一块。跨章节不合并（会破坏「章节子图复用块缓存」的对齐）。
 *
 * 合并有上限：合并后不得超过目标预算的 1.5 倍，否则宁可分开（块太大同样伤认知）。
 */
export function repairSplitAttention(chunks: readonly ChunkDraft[], targetTokens: number): ChunkDraft[] {
  const merged: ChunkDraft[] = []

  for (const chunk of chunks) {
    const previous = merged[merged.length - 1]
    if (previous === undefined) {
      merged.push(chunk)
      continue
    }

    const sameChapter = previous.outlineNodeId === chunk.outlineNodeId
    const tail = previous.text.slice(-160)
    const head = chunk.text.slice(0, 160)

    const looksLikeExample = EXAMPLE_LEAD_IN.test(tail) || TRAILING_COLON.test(tail)
    const looksLikeCaption =
      CAPTION_LEAD_IN.test(head) && CAPTION_MENTION.test(tail)
    const combinedTokens = previous.tokenEstimate + chunk.tokenEstimate

    if (
      sameChapter &&
      (looksLikeExample || looksLikeCaption) &&
      combinedTokens <= targetTokens * 1.5
    ) {
      const text = `${previous.text}\n\n${chunk.text}`
      merged[merged.length - 1] = {
        outlineNodeId: previous.outlineNodeId,
        pageStart: previous.pageStart,
        pageEnd: Math.max(previous.pageEnd, chunk.pageEnd),
        text,
        charCount: text.length,
        tokenEstimate: estimateTokens(text),
        order: previous.order,
      }
      continue
    }

    merged.push({ ...chunk, order: merged.length })
  }

  return merged.map((chunk, index) => ({ ...chunk, order: index }))
}
