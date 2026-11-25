/**
 * 引注解析与校验（任务书模块四第 3 条：必须带页码+原文引注，无出处要明说）。
 *
 * 关键立场：**不信任模型给的页码/引文**。
 * 模型输出解析出来后，必须拿回 PDF 文本层逐条核对；核对不上就 verified=false、page=null，
 * UI 显示「无直接出处 / 未能在原文中定位」，绝不让编造的页码进入界面。
 */

import { CitationSchema } from '../domain'
import type { Citation } from '../domain'

export interface PageTextLike {
  readonly page: number
  readonly text: string
}

const CITATION_PATTERN = /\[引用\]\s*第\s*(\d+)\s*页\s*[：:]\s*[「“"]([^」”"]+)[」”"]/gu

export interface RawCitation {
  readonly page: number | null
  readonly quote: string
}

export function parseCitations(answer: string): RawCitation[] {
  const found: RawCitation[] = []
  for (const match of answer.matchAll(CITATION_PATTERN)) {
    const page = Number(match[1])
    const quote = (match[2] ?? '').trim()
    if (Number.isInteger(page) && page > 0 && quote !== '') found.push({ page, quote })
  }
  return found
}

function fold(text: string): string {
  return [...text].map((char) => char.normalize('NFKC')).join('')
}

function collapse(text: string): string {
  return fold(text).replace(/\s+/g, ' ').trim()
}

/** 三条降级（同 anchor.ts）：精确 → 空白折叠 → 大小写不敏感；优先看模型声称的页。 */
export function verifyCitation(citation: RawCitation, pages: readonly PageTextLike[]): Citation {
  const quote = citation.quote.trim()
  if (quote === '') {
    return { page: null, quote: '', nodeId: null, highlightId: null, verified: false }
  }

  const ordered =
    citation.page === null
      ? pages
      : [...pages].sort((a, b) => (a.page === citation.page ? -1 : b.page === citation.page ? 1 : 0))

  const foldedQuote = fold(quote)
  const checks: ((pageText: string) => boolean)[] = [
    (text) => fold(text).includes(foldedQuote),
    (text) => collapse(text).includes(collapse(quote)),
    (text) => fold(text).toLowerCase().includes(foldedQuote.toLowerCase()),
  ]

  for (const matches of checks) {
    for (const page of ordered) {
      if (matches(page.text)) {
        return { page: page.page, quote, nodeId: null, highlightId: null, verified: true }
      }
    }
  }

  return { page: null, quote, nodeId: null, highlightId: null, verified: false }
}

/**
 * 把回答变成可落库的 citations。
 * 永远至少返回一条：没有引注或引注全不成立时，返回 verified=false 的「无直接出处」条目。
 */
export function extractCitations(answer: string, pages: readonly PageTextLike[]): Citation[] {
  const raw = parseCitations(answer)
  if (raw.length === 0) {
    return [{ page: null, quote: '', nodeId: null, highlightId: null, verified: false }]
  }

  const verified = raw.map((citation) => verifyCitation(citation, pages))
  const safe = verified.filter((citation) => CitationSchema.safeParse(citation).success)
  if (safe.length === 0) {
    return [{ page: null, quote: '', nodeId: null, highlightId: null, verified: false }]
  }
  return safe
}
