/**
 * 全文文本索引：把 pdf.js 的 textContent 变成「可定位的字符流」。
 *
 * 为什么需要它：新的学习对话框里，标注是在**摘录文字**上做的，没有 PDF 视口可以拖选。
 * 必须能凭空回答三个问题：
 *   1) 某个 quote 在全文的哪个字符区间；
 *   2) 该区间前后各 200 字（可跨页）的摘录文本是什么；
 *   3) 用户在这段摘录里划的某几个字，对应 PDF 上哪些矩形（可落库、可在 PDF 里复现）。
 *
 * 坐标系：这里输出的是 **PDF 坐标**（rect + pageNumber），配合 `usePdfCoordinates: true`
 * 交给 react-pdf-highlighter，缩放窗口都不会漂移。
 * 整个模块是纯函数（矩阵运算自己实现，不依赖 pdfjs），因此可以脱离浏览器单测。
 */

export interface TextItemGeometry {
  readonly str: string
  readonly width: number
  readonly height: number
  /** pdf.js 的 item.transform：把文本空间映射到视口（scale=1）空间。 */
  readonly transform: readonly number[]
}

export interface PageGeometry {
  readonly page: number
  /** pdf.js 的 page.getViewport({scale:1}).transform。 */
  readonly viewportTransform: readonly number[]
  readonly items: readonly TextItemGeometry[]
}

export interface PdfSpaceRect {
  readonly page: number
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly width: number
  readonly height: number
}

interface IndexedItem {
  readonly rect: PdfSpaceRect
  /** 在所在页 rawText 中的字符区间。 */
  readonly start: number
  readonly end: number
}

interface IndexedPage {
  readonly page: number
  readonly text: string
  readonly items: readonly IndexedItem[]
}

export interface DocumentTextIndex {
  /** 每页的原始文本（item.str 直接拼接，未加空格，保证偏移精确）。 */
  readonly pages: readonly IndexedPage[]
  /** 全文：各页用 '\n' 连接。 */
  readonly text: string
  readonly pageStarts: readonly number[]
  /** 归一化文本（小写、只保留字母/数字/CJK），用于鲁棒匹配。 */
  readonly normText: string
  /** normText 每个字符对应的 text 下标。 */
  readonly normToRaw: readonly number[]
}

/** pdf.js Util.transform 的等价实现（矩阵复合）。 */
function multiply(m1: readonly number[], m2: readonly number[]): [number, number, number, number, number, number] {
  return [
    m1[0]! * m2[0]! + m1[2]! * m2[1]!,
    m1[1]! * m2[0]! + m1[3]! * m2[1]!,
    m1[0]! * m2[2]! + m1[2]! * m2[3]!,
    m1[1]! * m2[2]! + m1[3]! * m2[3]!,
    m1[0]! * m2[4]! + m1[2]! * m2[5]! + m1[4]!,
    m1[1]! * m2[4]! + m1[3]! * m2[5]! + m1[5]!,
  ]
}

/**
 * 视口坐标 → PDF 坐标。pdf.js 的 viewport.convertToPdfPoint 等价实现：
 * 用 viewport 变换矩阵求逆后作用在点上。
 */
function toPdfPoint(
  viewportTransform: readonly number[],
  x: number,
  y: number,
): [number, number] {
  const [a, b, c, d, e, f] = viewportTransform as [number, number, number, number, number, number]
  const det = a * d - b * c
  if (det === 0) return [x, y]
  const invDet = 1 / det
  const ia = d * invDet
  const ib = -b * invDet
  const ic = -c * invDet
  const id = a * invDet
  const ie = (c * f - d * e) * invDet
  const iff = (b * e - a * f) * invDet
  return [ia * x + ic * y + ie, ib * x + id * y + iff]
}

/** 单个文本项（scale=1 视口）的矩形。 */
function itemRect(
  page: number,
  viewportTransform: readonly number[],
  item: TextItemGeometry,
): PdfSpaceRect | null {
  if (item.str.trim() === '') return null
  const tx = multiply(viewportTransform, item.transform)
  const fontHeight = Math.hypot(tx[2]!, tx[3]!)
  if (!Number.isFinite(fontHeight) || fontHeight <= 0) return null

  const left = tx[4]!
  const baseline = tx[5]!
  const top = baseline - fontHeight
  const right = left + item.width

  const [px1, py1] = toPdfPoint(viewportTransform, left, top)
  const [px2, py2] = toPdfPoint(viewportTransform, right, baseline)
  return {
    page,
    x1: Math.min(px1, px2),
    y1: Math.min(py1, py2),
    x2: Math.max(px1, px2),
    y2: Math.max(py1, py2),
    width: Math.abs(px2 - px1),
    height: Math.abs(py2 - py1),
  }
}

/**
 * 逐字符 NFKC：Chrome 打印的 PDF 会把「目录」嵌成康熙部首码位（U+2F6C「⽬」），
 * NFKC 能把它折回汉字（U+76EE）。逐字符归一化保证与原始文本偏移 1:1 对齐，
 * 不会破坏「字符 → 矩形」的映射。
 */
function fold(char: string): string {
  return char.normalize('NFKC')
}

function isKept(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char)
}

export function buildDocumentTextIndex(pages: readonly PageGeometry[]): DocumentTextIndex {
  const indexedPages: IndexedPage[] = []
  const pageStarts: number[] = []
  let globalText = ''

  for (const page of pages) {
    const items: IndexedItem[] = []
    let pageText = ''

    for (const item of page.items) {
      const text = item.str
      if (text === '') continue
      const rect = itemRect(page.page, page.viewportTransform, item)
      const start = pageText.length
      pageText += text
      if (rect !== null) items.push({ rect, start, end: pageText.length })
    }

    pageStarts.push(globalText.length)
    globalText += pageText
    indexedPages.push({ page: page.page, text: pageText, items })

    // 页与页之间插一个换行，保证跨页摘录能看出断点
    if (page !== pages[pages.length - 1]) globalText += '\n'
  }

  let normText = ''
  const normToRaw: number[] = []
  for (let index = 0; index < globalText.length; index += 1) {
    const folded = fold(globalText[index]!)
    if (!isKept(folded)) continue
    normText += folded.toLowerCase()
    normToRaw.push(index)
  }

  return { pages: indexedPages, text: globalText, pageStarts, normText, normToRaw }
}

/** 归一化（与 buildDocumentTextIndex 里的 normText 保持同一规则）。 */
export function normalizeForSearch(input: string): string {
  let out = ''
  for (const char of input) {
    const folded = fold(char)
    if (isKept(folded)) out += folded.toLowerCase()
  }
  return out
}

export interface RawRange {
  readonly start: number
  readonly end: number
}

/** 在全文里定位 quote；找不到返回 null（绝不返回「最相近」的区间）。 */
export function findQuoteRange(index: DocumentTextIndex, quote: string): RawRange | null {
  const needle = normalizeForSearch(quote)
  if (needle.length < 4) return null

  const position = index.normText.indexOf(needle)
  if (position === -1) return null

  const rawStart = index.normToRaw[position]
  const rawEnd = index.normToRaw[position + needle.length - 1]
  if (rawStart === undefined || rawEnd === undefined) return null
  return { start: rawStart, end: rawEnd + 1 }
}

export interface ExcerptSegment {
  readonly page: number
  readonly text: string
  /** 该段在全文中的区间，用于把用户在摘录上的选区映射回全文。 */
  readonly start: number
  readonly end: number
}

export interface Excerpt {
  readonly segments: readonly ExcerptSegment[]
  /** 锚点 quote 的全文区间（用于高亮显示锚点）。 */
  readonly anchor: RawRange
  readonly start: number
  readonly end: number
}

function pageIndexForOffset(index: DocumentTextIndex, offset: number): number {
  let low = 0
  let high = index.pageStarts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (index.pageStarts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * 以 anchor 为中心取 before/after 字符的摘录，**允许跨页**。
 * 跨页时按页切段，返回的 segments 每段自带 page 与全文区间。
 */
export function buildExcerpt(
  index: DocumentTextIndex,
  anchor: RawRange,
  before = 200,
  after = 200,
): Excerpt {
  const start = Math.max(0, anchor.start - before)
  const end = Math.min(index.text.length, anchor.end + after)

  const segments: ExcerptSegment[] = []
  let cursor = start
  while (cursor < end) {
    const pageIdx = pageIndexForOffset(index, cursor)
    const pageStart = index.pageStarts[pageIdx]!
    const nextPageStart = index.pageStarts[pageIdx + 1] ?? index.text.length
    const segmentEnd = Math.min(end, nextPageStart)
    segments.push({
      page: index.pages[pageIdx]!.page,
      text: index.text.slice(cursor, segmentEnd),
      start: cursor,
      end: segmentEnd,
    })
    cursor = Math.max(segmentEnd, cursor + 1)
  }

  return { segments, anchor, start, end }
}

function mergeLineRects(rects: readonly PdfSpaceRect[]): PdfSpaceRect[] {
  const sorted = [...rects].sort((a, b) => a.page - b.page || a.y1 - b.y1 || a.x1 - b.x1)
  const merged: PdfSpaceRect[] = []

  for (const rect of sorted) {
    const last = merged[merged.length - 1]
    const sameLine =
      last !== undefined &&
      last.page === rect.page &&
      Math.abs(last.y1 - rect.y1) < 2 &&
      Math.abs(last.height - rect.height) < 3
    if (sameLine && rect.x1 - last.x2 < 14) {
      const x1 = last.x1
      const x2 = Math.max(last.x2, rect.x2)
      const y1 = Math.min(last.y1, rect.y1)
      const y2 = Math.max(last.y2, rect.y2)
      merged[merged.length - 1] = {
        page: last.page,
        x1,
        y1,
        x2,
        y2,
        width: x2 - x1,
        height: y2 - y1,
      }
      continue
    }
    merged.push(rect)
  }

  return merged
}

/**
 * 全文区间 → PDF 坐标矩形（按行合并）。
 * 只返回与区间有实际字符交叠的 item，避免把整行都框进去。
 */
export function rectsForRange(
  index: DocumentTextIndex,
  range: RawRange,
): PdfSpaceRect[] {
  // 空区间不产生任何框（否则「没选任何字」也会被画出一条高亮）
  if (range.end <= range.start) return []

  const pageIdxStart = pageIndexForOffset(index, range.start)
  const pageIdxEnd = pageIndexForOffset(index, Math.max(range.start, range.end - 1))
  const rects: PdfSpaceRect[] = []

  for (let pageIdx = pageIdxStart; pageIdx <= pageIdxEnd; pageIdx += 1) {
    const page = index.pages[pageIdx]!
    const pageStart = index.pageStarts[pageIdx]!
    const localStart = range.start - pageStart
    const localEnd = range.end - pageStart

    for (const item of page.items) {
      if (item.end <= localStart || item.start >= localEnd) continue
      rects.push(item.rect)
    }
  }

  return mergeLineRects(rects)
}

/** 判断某段摘录是否包含图表 caption（Figure N / Fig. N / Table N / 表 N）。 */
// 不要求 caption 出现在行首：PDF 文本层经常把整页拼成一行，
// 强要求 (^|\n) 会让「Figure 1: …」这种明明存在的 caption 永远匹配不到（图摘抄因此常被跳过）。
const CAPTION_PATTERN = /((?:Figure|Fig\.?|Table|图|表)\s*\d+[a-zA-Z]?\s*[:：.])\s*([^\n]{0,160})/i

export interface CaptionMatch {
  readonly label: string
  readonly text: string
  /** caption 在全文中的区间。 */
  readonly range: RawRange
}

export function findCaption(segment: ExcerptSegment): CaptionMatch | null {
  const match = CAPTION_PATTERN.exec(segment.text)
  if (match === null) return null
  const offset = match.index + (match[0].startsWith('\n') ? 1 : 0)
  return {
    label: (match[1] ?? '').trim(),
    text: `${match[1] ?? ''} ${match[2] ?? ''}`.trim(),
    range: { start: segment.start + offset, end: segment.start + offset + match[0].length },
  }
}
