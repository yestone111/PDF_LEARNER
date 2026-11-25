/**
 * pdf.js 的目录 `dest` → 页码解析。
 *
 * 论文 PDF 的 dest 通常是**命名目标**（如 `section.3`、`subsection.3.2.1`），
 * 必须 `getDestination(name)` 拿到显式引用数组，再用 `getPageIndex(ref)` 换成页索引。
 * 直接把字符串当页码是经典错误，这里显式处理三种情况：
 *   1) string → 命名目标
 *   2) number → 页索引（0-based）
 *   3) RefProxy 对象 → 通过 getPageIndex 解析
 * 任何异常/空值都返回 null（上层不编造页码）。
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'

export async function resolveDestToPage(
  document: PDFDocumentProxy,
  dest: unknown,
): Promise<number | null> {
  if (dest === null || dest === undefined) return null

  let explicit: unknown = dest
  if (typeof dest === 'string') {
    explicit = await document.getDestination(dest)
    if (explicit === null || explicit === undefined) return null
  }

  if (!Array.isArray(explicit) || explicit.length === 0) return null

  const reference: unknown = explicit[0]

  try {
    if (typeof reference === 'number') {
      return Number.isInteger(reference) && reference >= 0 ? reference + 1 : null
    }
    if (typeof reference === 'object' && reference !== null) {
      // pdf.js 的 RefProxy：{ num, gen }
      const index = await document.getPageIndex(reference as never)
      return Number.isInteger(index) && index >= 0 ? index + 1 : null
    }
  } catch {
    return null
  }

  return null
}
