import { describe, expect, it } from 'vitest'

import { trimToSentence } from './chapterSummary'

describe('trimToSentence（速览超长时按句收尾）', () => {
  it('未超长时原样返回（去首尾空白）', () => {
    expect(trimToSentence('  一段话。  ')).toBe('一段话。')
  })

  it('超长时截到最后一个句号，而不是半句', () => {
    const text = '第一句话。第二句话。第三句话。'
    expect(trimToSentence(text, 10)).toBe('第一句话。第二句话。')
  })

  it('找不到句号时退回硬截断', () => {
    expect(trimToSentence('a'.repeat(100), 20)).toBe('a'.repeat(20))
  })
})
