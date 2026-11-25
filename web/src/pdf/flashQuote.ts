/**
 * 在 PDF 文本层里临时高亮一段原文（模块三「点图谱节点 → 跳转并临时高亮原文」）。
 *
 * 实现方式：pdf.js 的文本层是 `.textLayer span` 序列，把 span 文本归一后滑窗拼接，
 * 命中 quote 就给覆盖到的 span 加一个动画类，2.6s 后移除。
 * 找不到就返回 false —— 调用方必须给出「未能定位」提示，不能假装高亮成功。
 */

/**
 * 归一化：逐字符 NFKC（把康熙部首等兼容字符折回常规汉字）+ 去空白 + 小写。
 * 中文 PDF 常见「⽬录」这类康熙部首字符，不做 NFKC 会永远匹配不到。
 */
export function normalizeForFlash(text: string): string {
  let folded = ''
  for (const char of text) folded += char.normalize('NFKC')
  return folded.replace(/\s+/g, '').toLowerCase()
}

function normalize(text: string): string {
  return normalizeForFlash(text)
}

/**
 * 页面级闪烁：原文片段找不到时（扫描页 / 引文有出入）至少把目标页标出来。
 * 与文本层高亮互补，保证「跳过去」一定有视觉反馈。
 */
export function flashPageInView(container: HTMLElement, page: number, durationMs = 2000): boolean {
  const pageElement = container.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`)
  if (pageElement === null) return false
  pageElement.classList.add('akn-page-flash')
  window.setTimeout(() => pageElement.classList.remove('akn-page-flash'), durationMs)
  return true
}

interface BoxRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * 把命中的 span 按「行」分组，算出每行的**视口坐标**包围盒。
 *
 * 用视口坐标 + 画到 document.body 的原因：PDF 的文本层会随切 Tab / 滚动重渲染，
 * 加在 span 上的高亮和挂在 page 元素里的框会被新一轮渲染冲掉（实测「闪一下就没了」）。
 */
function lineBoxes(spans: readonly HTMLElement[]): BoxRect[] {
  interface Line {
    left: number
    top: number
    right: number
    bottom: number
  }
  const lines = new Map<number, Line>()

  for (const span of spans) {
    const rect = span.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) continue
    const key = Math.round(rect.top / 4)
    const existing = lines.get(key)
    if (existing === undefined) {
      lines.set(key, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
    } else {
      existing.left = Math.min(existing.left, rect.left)
      existing.top = Math.min(existing.top, rect.top)
      existing.right = Math.max(existing.right, rect.right)
      existing.bottom = Math.max(existing.bottom, rect.bottom)
    }
  }

  return [...lines.values()].map((line) => ({
    left: Math.max(0, line.left - 3),
    top: Math.max(0, line.top - 3),
    width: Math.max(2, line.right - line.left + 6),
    height: Math.max(2, line.bottom - line.top + 6),
  }))
}

/** 在命中文字处画「下划线闪烁」（每行一条），挂在 body 上避免被 PDF 重渲染清掉。 */
function drawFlashBoxes(spans: readonly HTMLElement[], durationMs: number): number {
  const rects = lineBoxes(spans)
  // 全部零尺寸 = 目标页当时不可见（display:none / 尚未布局），交给调用方重试
  if (rects.length === 0) return 0
  const boxes = rects.map((rect) => {
    const box = document.createElement('div')
    box.className = 'akn-flash-box'
    box.setAttribute('data-testid', 'flash-box')
    box.setAttribute('data-flash-style', 'underline')
    // 只占每行的底部 3px：下划线而不是整块遮罩
    box.style.left = `${rect.left}px`
    box.style.top = `${rect.top + rect.height - 3}px`
    box.style.width = `${rect.width}px`
    box.style.height = '3px'
    document.body.appendChild(box)
    return box
  })
  window.setTimeout(() => {
    for (const box of boxes) box.remove()
  }, durationMs)
  return boxes.length
}

function findInPage(pageElement: HTMLElement, target: string): HTMLElement[] | null {
  const spans = [...pageElement.querySelectorAll<HTMLElement>('.textLayer span')]
  if (spans.length === 0) return null

  // 整页文本 + 每个字符属于哪个 span。
  // 不要用「滑动窗口 + 逐字裁剪」：长行会把 span 从窗口里滑掉，
  // 结果 buffer 还能命中但覆盖区间为空（返回 []，画不出框）——真实踩坑。
  const chars: string[] = []
  const owners: number[] = []
  spans.forEach((span, index) => {
    const text = normalize(span.textContent ?? '')
    if (text === '') return
    for (const char of text) {
      chars.push(char)
      owners.push(index)
    }
  })
  if (chars.length === 0) return null

  const full = chars.join('')
  const at = full.indexOf(target)
  if (at === -1) return null

  const from = owners[at]
  const to = owners[Math.min(owners.length - 1, at + target.length - 1)]
  if (from === undefined || to === undefined) return null
  return spans.slice(from, to + 1)
}

/**
 * 在目标页临时高亮原文。
 *
 * 匹配顺序（由严到宽，全部命中即返回）：
 *  1) 目标页 + 完整引文；
 *  2) 目标页 + 引文前缀（模型引文偶尔尾部有出入，或引文跨页被截断）；
 *  3) 其它**已渲染**页 + 完整引文（锚点页码偶尔与文本层对不上，别让用户扑空）。
 * 全都失败返回 false —— 调用方回退为「页面级闪烁」，不假装命中。
 */
export function flashQuoteInPage(
  container: HTMLElement,
  page: number,
  quote: string,
  durationMs = 2600,
): boolean {
  const target = normalize(quote)
  if (target.length < 6) return false

  const pageElement = container.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`)
  if (pageElement === null) return false

  const candidates: string[] = [target]
  if (target.length >= 24) candidates.push(target.slice(0, Math.max(18, Math.floor(target.length * 0.6))))

  const apply = (elements: HTMLElement[]): boolean => {
      // 关键视觉：在命中文字处画脉冲框（视口坐标，挂在 body 上，重渲染也不丢）
    const drawn = drawFlashBoxes(elements, durationMs)
    if (drawn === 0) return false
    for (const element of elements) element.classList.add('akn-flash')
    window.setTimeout(() => {
      for (const element of elements) element.classList.remove('akn-flash')
    }, durationMs)
    return true
  }

  for (const candidate of candidates) {
    const hit = findInPage(pageElement, candidate)
    if (hit !== null) {
      return apply(hit)
    }
  }

  // 回退：目标页没命中时，扫其它已渲染页面（避免锚点页码与实际文本层错位时毫无反馈）
  const others = [...container.querySelectorAll<HTMLElement>('.page')].filter(
    (element) => element !== pageElement,
  )
  for (const candidate of candidates) {
    for (const other of others) {
      const hit = findInPage(other, candidate)
      if (hit !== null) {
        return apply(hit)
      }
    }
  }

  return false
}
