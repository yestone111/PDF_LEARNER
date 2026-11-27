/**
 * 在 PDF 全文文本索引里定位一段文本（纯函数，可单测）。
 *
 * 「跳到原文」的兜底链路用它：知识点没有可用引文时，用标题/别名在这里找第一次出现的位置，
 * 拿到页码 + 原文片段，再交给下划线闪烁。找不到返回 null（调用方必须明确提示，不猜页码）。
 */

import { normalizeForSearch } from './textIndex'

import type { DocumentTextIndex } from './textIndex'

export interface TextHit {
  readonly page: number
  readonly quote: string
}

function pageOfOffset(index: DocumentTextIndex, offset: number): number | null {
  let page: number | null = null
  for (let i = 0; i < index.pageStarts.length; i += 1) {
    const start = index.pageStarts[i]
    if (start === undefined || start > offset) break
    page = index.pages[i]?.page ?? page
  }
  return page
}

/**
 * 定位文本，返回它所在页码与**原文片段**（用于画下划线）。
 *
 * 匹配复用 `findQuoteRange` 的归一化规则（NFKC + 去空白/标点 + 小写），
 * 因此 PDF 里「零拷⾙卸载」这类康熙部首、或字符间被拆开的文本都能对上。
 */
export function locateTextInIndex(
  index: DocumentTextIndex,
  text: string,
  options: { readonly skipPages?: ReadonlySet<number> } = {},
): TextHit | null {
  const needle = normalizeForSearch(text)
  if (needle.length < 4) return null
  const skipPages = options.skipPages ?? new Set<number>()
  let fallback: TextHit | null = null
  let from = 0

  // 逐次往后找：标题在目录页也会出现一次，优先返回「非目录页」的那次命中
  for (let guard = 0; guard < 200; guard += 1) {
    const position = index.normText.indexOf(needle, from)
    if (position === -1) break
    from = position + 1
    const rawStart = index.normToRaw[position]
    const rawEnd = index.normToRaw[position + needle.length - 1]
    if (rawStart === undefined || rawEnd === undefined) continue
    const page = pageOfOffset(index, rawStart)
    if (page === null) continue
    const quote = index.text.slice(rawStart, rawEnd + 1).replace(/\s+/g, ' ').trim()
    if (quote === '') continue
    const hit: TextHit = { page, quote }
    if (!skipPages.has(page)) return hit
    fallback ??= hit
  }

  // 全都在目录页：退回第一次命中（总比不跳强），由调用方给出提示
  return fallback
}
