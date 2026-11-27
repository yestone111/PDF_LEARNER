import { describe, expect, it } from 'vitest'

import { NODE_SIZE, neutralNodeStyle, nodeDiameter, nodeStyle, nodeWidth } from './nodeStyle'

import type { Importance } from './enums'

const LEVELS: readonly Importance[] = [1, 2, 3, 4, 5]

/** 简易色相（0–360），用来区分红/绿/黄三系，不受深浅影响。 */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const max = Math.max(r!, g!, b!)
  const min = Math.min(r!, g!, b!)
  const delta = max - min
  if (delta === 0) return 0
  const raw =
    max === r ? ((g! - b!) / delta) % 6 : max === g ? (b! - r!) / delta + 2 : (r! - g!) / delta + 4
  return (raw * 60 + 360) % 360
}

function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

describe('nodeStyle：难度决定深浅、掌握决定色相', () => {
  it('难度越高颜色越深（未掌握 / 已掌握 / 有疑问都成立）', () => {
    for (const mastery of ['unmastered', 'mastered', 'doubt'] as const) {
      const values = LEVELS.map((level) => luminance(nodeStyle(level, mastery).fill))
      for (let index = 1; index < values.length; index += 1) {
        expect(values[index]!).toBeLessThan(values[index - 1]!)
      }
    }
  })

  it('切换掌握状态只换色相，字号（深浅档位）不变', () => {
    for (const level of LEVELS) {
      const red = nodeStyle(level, 'unmastered')
      const green = nodeStyle(level, 'mastered')
      const yellow = nodeStyle(level, 'doubt')
      expect(red.fontSize).toBe(green.fontSize)
      expect(red.fontSize).toBe(yellow.fontSize)
      expect(new Set([red.fill, green.fill, yellow.fill]).size).toBe(3)
    }
  })

  it('未掌握是红系、已掌握是绿系、有疑问是黄系（按色相判定，不靠通道大小）', () => {
    for (const level of LEVELS) {
      const red = nodeStyle(level, 'unmastered').fill
      const green = nodeStyle(level, 'mastered').fill
      const yellow = nodeStyle(level, 'doubt').fill
      expect(hue(red)).toBeLessThan(30) // 红/深红
      expect(hue(green)).toBeGreaterThan(90) // 绿/深绿
      expect(hue(yellow)).toBeGreaterThanOrEqual(35) // 金黄/深金
      expect(hue(yellow)).toBeLessThanOrEqual(60)
    }
  })
})

describe('nodeDiameter：关联程度决定尺寸', () => {
  it('没有连线时是最小尺寸', () => {
    expect(nodeDiameter(0)).toBe(NODE_SIZE.minDiameter)
  })

  it('随度数单调递增，并在参考度数处达到上限', () => {
    const values = [0, 1, 2, 3, 5, 8, 10].map((degree) => nodeDiameter(degree))
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]!).toBeGreaterThanOrEqual(values[index - 1]!)
    }
    expect(nodeDiameter(NODE_SIZE.referenceDegree)).toBe(NODE_SIZE.maxDiameter)
    expect(nodeDiameter(999)).toBe(NODE_SIZE.maxDiameter)
  })

  it('负数/非法值按 0 处理', () => {
    expect(nodeDiameter(-3)).toBe(NODE_SIZE.minDiameter)
    expect(nodeDiameter(Number.NaN)).toBe(NODE_SIZE.minDiameter)
  })
})

describe('nodeWidth：宽度只由高度决定（大小 = 关联度，不是字数）', () => {
  it('高度越大宽度越大', () => {
    expect(nodeWidth(60)).toBeGreaterThan(nodeWidth(46))
    expect(nodeWidth(112)).toBeGreaterThan(nodeWidth(60))
  })

  it('有最小/最大宽度，窄节点不会扁成一条线', () => {
    expect(nodeWidth(46)).toBeGreaterThanOrEqual(NODE_SIZE.minWidth)
    expect(nodeWidth(999)).toBeLessThanOrEqual(NODE_SIZE.maxWidth)
  })

  it('宽高比稳定（同一高度下宽度固定，与标题无关）', () => {
    expect(nodeWidth(80)).toBe(nodeWidth(80))
    expect(nodeWidth(80) / 80).toBeGreaterThan(1.4)
  })
})

describe('neutralNodeStyle（无难度预测值）', () => {
  it('刻意与红/绿系都不同，且不得伪造深浅', () => {
    const neutral = neutralNodeStyle()
    for (const level of LEVELS) {
      expect(nodeStyle(level, 'unmastered').fill).not.toBe(neutral.fill)
      expect(nodeStyle(level, 'mastered').fill).not.toBe(neutral.fill)
      expect(nodeStyle(level, 'doubt').fill).not.toBe(neutral.fill)
    }
  })

  it('直径可由调用方指定（章节根用关联程度算）', () => {
    expect(neutralNodeStyle(72).diameter).toBe(72)
  })
})
