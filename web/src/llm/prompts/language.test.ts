import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PRIMARY_LANGUAGE,
  languageDirective,
  normalizePrimaryLanguage,
} from './language'

describe('normalizePrimaryLanguage', () => {
  it('默认简体中文', () => {
    expect(DEFAULT_PRIMARY_LANGUAGE).toBe('zh-CN')
  })

  it('只接受白名单', () => {
    expect(normalizePrimaryLanguage('en')).toBe('en')
    expect(normalizePrimaryLanguage('auto')).toBe('auto')
    expect(normalizePrimaryLanguage('zh-CN')).toBe('zh-CN')
  })

  it('脏数据回落默认', () => {
    expect(normalizePrimaryLanguage(undefined)).toBe('zh-CN')
    expect(normalizePrimaryLanguage('fr')).toBe('zh-CN')
    expect(normalizePrimaryLanguage(123)).toBe('zh-CN')
  })
})

describe('languageDirective', () => {
  it('中文：要求中文输出 + 引文逐字不译', () => {
    const directive = languageDirective('zh-CN')
    expect(directive).toContain('简体中文')
    expect(directive).toContain('引文')
    expect(directive).toContain('逐字不变')
  })

  it('英文：要求英文输出 + 引文不译', () => {
    const directive = languageDirective('en')
    expect(directive).toContain('English')
    expect(directive).toContain('verbatim')
    expect(directive).toContain('Never translate')
  })

  it('auto：不注入任何指令（由模型跟随原文）', () => {
    expect(languageDirective('auto')).toBe('')
  })
})
