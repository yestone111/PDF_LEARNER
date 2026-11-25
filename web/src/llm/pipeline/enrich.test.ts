import { describe, expect, it } from 'vitest'

import { normalizeEnrichPayload } from './enrich'

describe('normalizeEnrichPayload（按需分析的模型输出归一）', () => {
  it('夹取数值、裁字符串、清洗空四问', () => {
    const result = normalizeEnrichPayload({
      summary: '  解释  ',
      quote: '原文',
      priorKnowledge: [' a ', '', 'b', 'c', 'd'],
      elaboration: { analogy: '像地图', contrast: '', why: '', misconception: '' },
      selfCheck: '问题？',
      difficulty: '9',
      cognitiveLevel: 0,
      unitKind: 'nonsense',
    }) as Record<string, unknown>
    expect(result.summary).toBe('解释')
    expect(result.difficulty).toBe(5)
    expect(result.cognitiveLevel).toBe(1)
    expect(result.unitKind).toBe('concept')
    expect(result.priorKnowledge).toEqual(['a', 'b', 'c'])
    expect(result.elaboration).toEqual({ analogy: '像地图', contrast: '', why: '', misconception: '' })
  })

  it('四问全空 → null', () => {
    const result = normalizeEnrichPayload({
      elaboration: { analogy: '', contrast: '', why: '', misconception: '' },
    }) as Record<string, unknown>
    expect(result.elaboration).toBeNull()
  })

  it('非对象原样返回（交给 zod 报错）', () => {
    expect(normalizeEnrichPayload('nope')).toBe('nope')
  })
})
