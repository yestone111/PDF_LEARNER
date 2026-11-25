/**
 * quote 定位（任务书第一轮 Q6 的三级降级）。
 *
 * ① 原文精确匹配 → ② 空白折叠后匹配 → ③ 大小写不敏感匹配
 * 三级都失败 → 返回 null（UI 显示「无原文锚点」），**绝不**用「最相近的一句」冒充。
 */

import type { KnowledgeAnchor } from '../../domain/types'

export interface PageTextLike {
  readonly page: number
  readonly text: string
}

/** 逐字符 NFKC：兼容「康熙部首码位」的 PDF（Chrome 打印常见）。 */
function fold(text: string): string {
  return [...text].map((char) => char.normalize('NFKC')).join('')
}

function collapse(text: string): string {
  return fold(text).replace(/\s+/g, ' ').trim()
}

export function locateQuote(
  quote: string,
  pageHint: number | null,
  pages: readonly PageTextLike[],
): KnowledgeAnchor | null {
  const raw = quote.trim()
  if (raw === '') return null
  const foldedQuote = fold(raw)

  const ordered = pageHint === null ? pages : [...pages].sort((a, b) => (a.page === pageHint ? -1 : b.page === pageHint ? 1 : 0))

  const attempts: ((pageText: string) => boolean)[] = [
    (text) => fold(text).includes(foldedQuote),
    (text) => collapse(text).includes(collapse(raw)),
    (text) => fold(text).toLowerCase().includes(foldedQuote.toLowerCase()),
  ]

  for (const matches of attempts) {
    for (const page of ordered) {
      if (matches(page.text)) {
        return { page: page.page, quote: raw, rects: [] }
      }
    }
  }

  return null
}
