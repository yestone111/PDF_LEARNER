import { describe, expect, it } from 'vitest'

import { isOutlineDerivedTitle, outlineTitleKeys } from './outlineFilter'

const outline = [
  { title: '3 Model Architecture' },
  { title: '第一章 绪论' },
  { title: '附录 A：验收与自检命令' },
]

describe('outlineTitleKeys / isOutlineDerivedKey', () => {
  it('目录标题归一化后进入集合', () => {
    const keys = outlineTitleKeys(outline)
    expect(isOutlineDerivedTitle('3 model architecture', keys)).toBe(true)
    expect(isOutlineDerivedTitle('第一章 绪论', keys)).toBe(true)
  })

  it('标点/大小写差异也能识别（与节点归一化同规则）', () => {
    const keys = outlineTitleKeys(outline)
    expect(isOutlineDerivedTitle('第一章绪论', keys)).toBe(true)
    expect(isOutlineDerivedTitle('  附录A验收与自检命令 ', keys)).toBe(true)
  })

  it('真正的知识点不会被误删（只做精确匹配）', () => {
    const keys = outlineTitleKeys(outline)
    expect(isOutlineDerivedTitle('第三章的方法', keys)).toBe(false)
    expect(isOutlineDerivedTitle('多层注意力', keys)).toBe(false)
  })

  it('空目录返回空集合', () => {
    expect(outlineTitleKeys([])).toEqual(new Set())
  })
})
