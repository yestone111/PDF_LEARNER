import { describe, expect, it } from 'vitest'

import { jumpTargetOf } from './jumpTarget'

import type { KnowledgeNode } from '../domain'

const base = (): Pick<KnowledgeNode, 'anchor' | 'figure'> => ({ anchor: null, figure: null })

describe('jumpTargetOf', () => {
  it('有锚点时用锚点页码与引文', () => {
    const target = jumpTargetOf({
      ...base(),
      anchor: { page: 4, quote: 'Scaled dot-product attention', rects: [] },
      figure: { kind: 'caption_only', label: 'Figure 2', caption: 'Figure 2: The attention', page: 5, rects: [] },
    })
    expect(target).toEqual({ page: 4, quote: 'Scaled dot-product attention' })
  })

  it('没有锚点时退到图表页码 + caption（表格/图表节点以前点不动的原因）', () => {
    const target = jumpTargetOf({
      ...base(),
      figure: { kind: 'caption_only', label: 'Table 1', caption: 'Table 1: 三栏布局', page: 6, rects: [] },
    })
    expect(target).toEqual({ page: 6, quote: 'Table 1: 三栏布局' })
  })

  it('图表没有 caption 时用 label，至少能落到那一页', () => {
    const target = jumpTargetOf({
      ...base(),
      figure: { kind: 'caption_only', label: 'Table 2', caption: '', page: 9, rects: [] },
    })
    expect(target).toEqual({ page: 9, quote: 'Table 2' })
  })

  it('锚点和图表都没有时返回 null（不猜页码）', () => {
    expect(jumpTargetOf(base())).toBeNull()
  })
})
