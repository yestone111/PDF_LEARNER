/**
 * TipTap JSON → Markdown 序列化（第一轮 Q2 的降级约定，P0 导出）。
 *
 * 硬规则：
 *  - 笔记里每种自定义节点都必须有**确定**的 Markdown 降级表示（卡片→引用块，图片→内联 base64 或占位链接）；
 *  - 单图 > 1.5MB 或全篇图片合计 > 8MB 时，该图降级为 `akn-assets/<id>.png` 占位，并在文首插入提示；
 *  - 非 verified 的引注一律渲染为「无直接出处」，绝不把模型声称的页码写成出处。
 */

import type { TiptapDoc, TiptapNode } from '../domain'

export interface MarkdownOptions {
  readonly imageMode: 'inline-base64' | 'placeholder'
  readonly maxInlineBytes: number
  readonly maxTotalBytes: number
}

export const MARKDOWN_DEFAULTS: MarkdownOptions = {
  imageMode: 'inline-base64',
  maxInlineBytes: 1_500_000,
  maxTotalBytes: 8_000_000,
}

export interface MarkdownResult {
  readonly markdown: string
  readonly imageCount: number
  readonly downgradedCount: number
  readonly totalImageBytes: number
  readonly notices: readonly string[]
}

function stars(importance: number): string {
  const clamped = Math.max(1, Math.min(5, Math.round(importance)))
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped)
}

function escapeText(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function renderInline(node: TiptapNode): string {
  if (node.type === 'text') {
    let text = escapeText(node.text ?? '')
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') text = `**${text}**`
      else if (mark.type === 'italic') text = `*${text}*`
      else if (mark.type === 'code') text = `\`${text}\``
    }
    return text
  }
  if (node.type === 'hardBreak') return '\n'
  if (node.content !== undefined) return node.content.map(renderInline).join('')
  return ''
}

function blockQuote(lines: readonly string[]): string {
  return lines.map((line) => `> ${line}`.trimEnd()).join('\n')
}

function dataUriBytes(src: string): number {
  const comma = src.indexOf(',')
  if (comma === -1) return 0
  const payload = src.slice(comma + 1)
  return Math.floor((payload.length * 3) / 4)
}

interface ImageBudget {
  total: number
  downgraded: number
  count: number
  index: number
}

function renderImage(node: TiptapNode, options: MarkdownOptions, budget: ImageBudget): string {
  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '图片'
  budget.count += 1
  budget.index += 1

  if (src === '') return `![${alt}]()`

  const isInline = src.startsWith('data:')
  const bytes = isInline ? dataUriBytes(src) : 0
  const exceedsSingle = isInline && bytes > options.maxInlineBytes
  const exceedsTotal = isInline && budget.total + bytes > options.maxTotalBytes
  const forcePlaceholder = options.imageMode === 'placeholder'

  if (isInline && (exceedsSingle || exceedsTotal || forcePlaceholder)) {
    budget.downgraded += 1
    budget.total += bytes
    return `![${alt}](akn-assets/image-${budget.index}.png)`
  }

  budget.total += bytes
  return `![${alt}](${src})`
}

function renderNodeCard(node: TiptapNode): string {
  const title = typeof node.attrs?.title === 'string' ? node.attrs.title : '未命名节点'
  const importance = typeof node.attrs?.importance === 'number' ? node.attrs.importance : 3
  const mastery = node.attrs?.mastery === 'mastered' ? '已掌握' : '未掌握'
  return blockQuote([`**【节点】${title}**`, `重要度 ${stars(importance)} · 状态：${mastery}`])
}

function renderHighlightQuote(node: TiptapNode): string {
  const quote = typeof node.attrs?.quote === 'string' ? node.attrs.quote : ''
  const page = typeof node.attrs?.page === 'number' ? node.attrs.page : null
  return blockQuote([quote, page === null ? '— p.?（未定位到页码）' : `— p.${page}`])
}

interface ChatCitation {
  page: number | null
  quote: string
  verified: boolean
}

function renderChatCard(node: TiptapNode): string {
  const answer = escapeText(typeof node.attrs?.answer === 'string' ? node.attrs.answer : '')
  const citations = Array.isArray(node.attrs?.citations) ? (node.attrs.citations as ChatCitation[]) : []
  const lines = [`**【AI】** ${answer.split('\n')[0] ?? ''}`]
  for (const line of answer.split('\n').slice(1)) lines.push(line)

  if (citations.length === 0) {
    lines.push('', '出处：无直接出处')
  } else {
    for (const citation of citations) {
      if (citation.verified && citation.page !== null) {
        lines.push('', `出处：p.${citation.page}「${citation.quote}」`)
      } else {
        lines.push('', `出处：无直接出处${citation.quote !== '' ? `（模型声称：${citation.quote}）` : ''}`)
      }
    }
  }
  return blockQuote(lines.map((line) => line.replace(/^\s+$/, '')))
}

function renderBlocks(nodes: readonly TiptapNode[], options: MarkdownOptions, budget: ImageBudget, depth = 0): string {
  const parts: string[] = []
  const indent = '  '.repeat(depth)

  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1
        parts.push(`${'#'.repeat(Math.min(6, level))} ${renderInline(node)}`)
        break
      }
      case 'paragraph':
        parts.push(renderInline(node))
        break
      case 'bulletList':
        for (const item of node.content ?? []) {
          const inner = renderBlocks(item.content ?? [], options, budget, depth + 1).trim()
          parts.push(`${indent}- ${inner.replace(/\n/g, `\n${indent}  `)}`)
        }
        break
      case 'orderedList': {
        let index = 1
        for (const item of node.content ?? []) {
          const inner = renderBlocks(item.content ?? [], options, budget, depth + 1).trim()
          parts.push(`${indent}${index}. ${inner.replace(/\n/g, `\n${indent}   `)}`)
          index += 1
        }
        break
      }
      case 'blockquote':
        parts.push(blockQuote([renderBlocks(node.content ?? [], options, budget, depth).trim()]))
        break
      case 'codeBlock':
        parts.push(['```', (node.content ?? []).map((child) => child.text ?? '').join(''), '```'].join('\n'))
        break
      case 'nodeCard':
        parts.push(renderNodeCard(node))
        break
      case 'highlightQuote':
        parts.push(renderHighlightQuote(node))
        break
      case 'chatCard':
        parts.push(renderChatCard(node))
        break
      case 'graphImage':
        parts.push(renderImage(node, options, budget))
        break
      case 'image':
        parts.push(renderImage(node, options, budget))
        break
      case 'horizontalRule':
        parts.push('---')
        break
      default:
        if (node.content !== undefined) parts.push(renderBlocks(node.content, options, budget, depth).trim())
        break
    }
  }

  return parts.filter((part) => part !== '').join('\n\n')
}

export function serializeNoteDoc(doc: TiptapDoc, overrides: Partial<MarkdownOptions> = {}): MarkdownResult {
  const options: MarkdownOptions = { ...MARKDOWN_DEFAULTS, ...overrides }
  const budget: ImageBudget = { total: 0, downgraded: 0, count: 0, index: 0 }
  const body = renderBlocks(doc.content, options, budget)
  const notices: string[] = []

  if (budget.downgraded > 0) {
    notices.push(
      `提示：${budget.downgraded} 张图片已降级为占位链接（akn-assets/…），需要手动导出对应 PNG。`,
    )
  }

  const header = notices.length > 0 ? `${notices.map((notice) => `> ${notice}`).join('\n')}\n\n` : ''
  return {
    markdown: header + body + (body === '' ? '' : '\n'),
    imageCount: budget.count,
    downgradedCount: budget.downgraded,
    totalImageBytes: budget.total,
    notices,
  }
}
