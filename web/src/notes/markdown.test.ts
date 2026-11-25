import { describe, expect, it } from 'vitest'

import { serializeNoteDoc } from './markdown'

import type { TiptapDoc, TiptapNode } from '../domain'

function doc(content: TiptapNode[]): TiptapDoc {
  return { type: 'doc', content }
}

const paragraph = (text: string): TiptapNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
})

describe('基础块', () => {
  it('标题 / 段落 / 列表 / 代码块', () => {
    const result = serializeNoteDoc(
      doc([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '注意力机制' }] },
        paragraph('核心是把 query 和 key 做点积。'),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraph('缩放点积')] },
            { type: 'listItem', content: [paragraph('多头')] },
          ],
        },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1' }] },
      ]),
    )
    expect(result.markdown).toContain('## 注意力机制')
    expect(result.markdown).toContain('- 缩放点积')
    expect(result.markdown).toContain('- 多头')
    expect(result.markdown).toContain('```\nconst a = 1\n```')
    expect(result.downgradedCount).toBe(0)
  })

  it('行内标记转 Markdown', () => {
    const result = serializeNoteDoc(
      doc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '重点是' },
            { type: 'text', text: '缩放', marks: [{ type: 'bold' }] },
            { type: 'text', text: '与' },
            { type: 'text', text: 'softmax', marks: [{ type: 'code' }] },
          ],
        },
      ]),
    )
    expect(result.markdown).toContain('重点是**缩放**与`softmax`')
  })
})

describe('自定义节点的确定降级', () => {
  it('图谱节点卡片 → 引用块（含重要度星级与掌握状态）', () => {
    const result = serializeNoteDoc(
      doc([{ type: 'nodeCard', attrs: { title: 'Scaled Dot-Product Attention', importance: 5, mastery: 'mastered' } }]),
    )
    expect(result.markdown).toContain('> **【节点】Scaled Dot-Product Attention**')
    expect(result.markdown).toContain('> 重要度 ★★★★★ · 状态：已掌握')
  })

  it('PDF 高亮 → 引用块 + 页码', () => {
    const result = serializeNoteDoc(doc([{ type: 'highlightQuote', attrs: { quote: 'scaled dot-product attention', page: 4 } }]))
    expect(result.markdown).toContain('> scaled dot-product attention')
    expect(result.markdown).toContain('> — p.4')
  })

  it('AI 回答卡片 → 引用块；无出处时明确写「无直接出处」', () => {
    const result = serializeNoteDoc(
      doc([
        {
          type: 'chatCard',
          attrs: {
            answer: '注意力的复杂度是 O(n²d)。',
            citations: [{ page: null, quote: '模型编的引文', verified: false }],
          },
        },
      ]),
    )
    expect(result.markdown).toContain('> **【AI】** 注意力的复杂度是 O(n²d)。')
    expect(result.markdown).toContain('> 出处：无直接出处（模型声称：模型编的引文）')
  })

  it('已核对引注 → 输出真实页码', () => {
    const result = serializeNoteDoc(
      doc([
        {
          type: 'chatCard',
          attrs: { answer: '答案', citations: [{ page: 6, quote: 'A self-attention layer', verified: true }] },
        },
      ]),
    )
    expect(result.markdown).toContain('> 出处：p.6「A self-attention layer」')
  })
})

describe('图片降级（第一轮 Q2）', () => {
  const smallInline = `data:image/png;base64,${'A'.repeat(400)}`
  const bigInline = `data:image/png;base64,${'A'.repeat(4_000_000)}`

  it('小图默认内联 base64', () => {
    const result = serializeNoteDoc(doc([{ type: 'graphImage', attrs: { src: smallInline, alt: '图谱截图' } }]))
    expect(result.markdown).toContain('![图谱截图](data:image/png;base64,')
    expect(result.downgradedCount).toBe(0)
    expect(result.imageCount).toBe(1)
  })

  it('超过单图阈值 → 降级为占位链接，并在文首提示', () => {
    const result = serializeNoteDoc(doc([{ type: 'graphImage', attrs: { src: bigInline, alt: '大图' } }]))
    expect(result.markdown).toContain('![大图](akn-assets/image-1.png)')
    expect(result.downgradedCount).toBe(1)
    expect(result.markdown.startsWith('> 提示：1 张图片已降级')).toBe(true)
  })

  it('强制 placeholder 模式时全部走占位', () => {
    const result = serializeNoteDoc(doc([{ type: 'image', attrs: { src: smallInline, alt: 'x' } }]), {
      imageMode: 'placeholder',
    })
    expect(result.markdown).toContain('![x](akn-assets/image-1.png)')
    expect(result.downgradedCount).toBe(1)
  })

  it('全篇总预算超限 → 后续图片降级', () => {
    const medium = `data:image/png;base64,${'A'.repeat(400_000)}`
    const result = serializeNoteDoc(
      doc([
        { type: 'image', attrs: { src: medium, alt: 'a' } },
        { type: 'image', attrs: { src: medium, alt: 'b' } },
        { type: 'image', attrs: { src: medium, alt: 'c' } },
      ]),
      { maxTotalBytes: 500_000 },
    )
    expect(result.downgradedCount).toBe(2)
    expect(result.markdown).toContain('![a](data:')
    expect(result.markdown).toContain('![b](akn-assets/image-2.png)')
    expect(result.markdown).toContain('![c](akn-assets/image-3.png)')
  })
})

describe('空文档', () => {
  it('输出空字符串而不是报错', () => {
    expect(serializeNoteDoc(doc([])).markdown).toBe('')
  })
})
