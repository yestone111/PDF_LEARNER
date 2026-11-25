import { describe, expect, it } from 'vitest'

import { outlineNumbers, outlineNumbersFromTree, outlineTitleHasNumber } from './outlineNumbering'

const levels = (...values: number[]) => values.map((level) => ({ level }))

describe('outlineNumbers（目录章节编号）', () => {
  it('同级顺序递增', () => {
    expect(outlineNumbers(levels(1, 1, 1))).toEqual(['1', '2', '3'])
  })

  it('多级嵌套', () => {
    expect(outlineNumbers(levels(1, 2, 2, 1, 2, 3))).toEqual(['1', '1.1', '1.2', '2', '2.1', '2.1.1'])
  })

  it('缺少一级标题时补 1，不出现 0.1', () => {
    expect(outlineNumbers(levels(2, 2))).toEqual(['1.1', '1.2'])
  })

  it('层级跳变（1 → 3）也能给出可读编号', () => {
    expect(outlineNumbers(levels(1, 3, 1))).toEqual(['1', '1.1.1', '2'])
  })

  it('回到上层后，下层计数重新开始', () => {
    expect(outlineNumbers(levels(1, 2, 3, 2))).toEqual(['1', '1.1', '1.1.1', '1.2'])
  })

  it('异常层级被收敛到 1..6', () => {
    expect(outlineNumbers(levels(0, 99))[0]).toBe('1')
    expect(outlineNumbers(levels(0, 99))[1].split('.')).toHaveLength(6)
  })

  it('空目录返回空数组', () => {
    expect(outlineNumbers([])).toEqual([])
  })
})

describe('outlineNumbersFromTree（按树编号，修复 8.1 错位）', () => {
  const leaf = (id: string): { node: { id: string }; children: never[] } => ({ node: { id }, children: [] })

  it('子节点编号跟随父节点，而不是数组顺序', () => {
    const tree = [
      {
        node: { id: 'c1' },
        children: [leaf('c1-s1'), leaf('c1-s2')],
      },
      { node: { id: 'c2' }, children: [leaf('c2-s1')] },
    ]
    const numbers = outlineNumbersFromTree(tree)
    expect(numbers.get('c1')).toBe('1')
    expect(numbers.get('c1-s1')).toBe('1.1')
    expect(numbers.get('c1-s2')).toBe('1.2')
    expect(numbers.get('c2')).toBe('2')
    expect(numbers.get('c2-s1')).toBe('2.1')
  })

  it('三级嵌套', () => {
    const tree = [
      {
        node: { id: 'a' },
        children: [
          {
            node: { id: 'a1' },
            children: [leaf('a1x'), leaf('a1y')],
          },
        ],
      },
    ]
    const numbers = outlineNumbersFromTree(tree)
    expect(numbers.get('a1x')).toBe('1.1.1')
    expect(numbers.get('a1y')).toBe('1.1.2')
  })

  it('空树返回空 Map', () => {
    expect(outlineNumbersFromTree([]).size).toBe(0)
  })
})

describe('outlineTitleHasNumber（避免重复编号）', () => {
  it('阿拉伯数字 / 多级编号', () => {
    expect(outlineTitleHasNumber('1 Introduction')).toBe(true)
    expect(outlineTitleHasNumber('3.2 Multi-Head Attention')).toBe(true)
  })

  it('中文序号与章节写法', () => {
    expect(outlineTitleHasNumber('一、绪论')).toBe(true)
    expect(outlineTitleHasNumber('第一章 绪论')).toBe(true)
  })

  it('英文 Chapter / Section', () => {
    expect(outlineTitleHasNumber('Chapter 3 Model Architecture')).toBe(true)
  })

  it('普通标题不误判', () => {
    expect(outlineTitleHasNumber('Multi-Head Attention')).toBe(false)
    expect(outlineTitleHasNumber('什么是注意力机制')).toBe(false)
  })
})
