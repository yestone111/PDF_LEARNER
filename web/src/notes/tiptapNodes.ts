/**
 * 笔记自定义节点（模块五：图谱节点卡片 / 高亮段落 / AI 回答 / 图谱截图混排）。
 * 每个节点都必须是「可序列化 + 有确定 Markdown 降级」的原子节点，
 * 降级规则写在 notes/markdown.ts，二者字段名必须严格一致。
 */

import { Node, mergeAttributes } from '@tiptap/core'

import { MASTERY_LABELS, type MasteryState } from '../domain/enums'

export const NodeCard = Node.create({
  name: 'nodeCard',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      nodeId: { default: null },
      title: { default: '' },
      importance: { default: 3 },
      mastery: { default: 'unmastered' },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-node-card]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as { title?: string; importance?: number; mastery?: string }
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-node-card': '',
        class: 'akn-note-card',
      }),
      `【节点】${attrs.title ?? ''}（重要度 ${attrs.importance ?? 3}，${MASTERY_LABELS[(attrs.mastery ?? 'unmastered') as MasteryState]}）`,
    ]
  },
})

export const HighlightQuote = Node.create({
  name: 'highlightQuote',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { quote: { default: '' }, page: { default: null }, highlightId: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'blockquote[data-highlight-quote]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as { quote?: string; page?: number | null }
    return [
      'blockquote',
      mergeAttributes(HTMLAttributes, { 'data-highlight-quote': '', class: 'akn-note-quote' }),
      `${attrs.quote ?? ''}\n— p.${attrs.page ?? '?'}`,
    ]
  },
})

export const ChatCard = Node.create({
  name: 'chatCard',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { answer: { default: '' }, citations: { default: [] } }
  },
  parseHTML() {
    return [{ tag: 'div[data-chat-card]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as { answer?: string }
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-chat-card': '', class: 'akn-note-chat' }),
      `【AI】${(attrs.answer ?? '').slice(0, 120)}`,
    ]
  },
})

export const GraphImage = Node.create({
  name: 'graphImage',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { src: { default: '' }, alt: { default: '图谱截图' }, imageId: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'img[data-graph-image]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as { src?: string; alt?: string }
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        'data-graph-image': '',
        src: attrs.src ?? '',
        alt: attrs.alt ?? '图谱截图',
        class: 'akn-note-image',
      }),
    ]
  },
})
