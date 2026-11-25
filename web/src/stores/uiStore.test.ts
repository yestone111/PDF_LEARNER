import { describe, expect, it } from 'vitest'

import { DEFAULT_THEME, normalizeTheme } from './uiStore'

describe('normalizeTheme（持久化脏数据归一）', () => {
  it('默认主题是羊皮卷', () => {
    expect(DEFAULT_THEME).toBe('parchment')
  })

  it('只接受白名单值', () => {
    expect(normalizeTheme('night')).toBe('night')
    expect(normalizeTheme('parchment')).toBe('parchment')
  })

  it('非法值/旧数据回落羊皮卷（不会渲染出一个没有主题的界面）', () => {
    expect(normalizeTheme(undefined)).toBe('parchment')
    expect(normalizeTheme(null)).toBe('parchment')
    expect(normalizeTheme('sepia')).toBe('parchment')
    expect(normalizeTheme(42)).toBe('parchment')
  })
})
