import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PANEL_WIDTHS,
  KEYBOARD_STEP,
  LAYOUT_LIMITS,
  clampLeftWidth,
  clampRightWidth,
  normalizePanelWidths,
} from './layoutMath'

/** 常用窗口宽度：1440（笔记本）、1280（默认）、1024（小屏）。 */
const WIDE = 1440

describe('clampLeftWidth', () => {
  it('默认值原样保留', () => {
    expect(clampLeftWidth(DEFAULT_PANEL_WIDTHS.left, WIDE, DEFAULT_PANEL_WIDTHS.right)).toBe(260)
  })

  it('低于最小宽度时抬到 200', () => {
    expect(clampLeftWidth(50, WIDE, 380)).toBe(LAYOUT_LIMITS.left.min)
    expect(clampLeftWidth(-999, WIDE, 380)).toBe(LAYOUT_LIMITS.left.min)
  })

  it('高于最大宽度时压到 480', () => {
    expect(clampLeftWidth(9999, WIDE, 380)).toBe(LAYOUT_LIMITS.left.max)
  })

  it('中间阅读区优先：容器不足时左栏让位，而不是压没 PDF 区', () => {
    // 900 - 380(右) - 360(中) - 12(分隔条) = 148
    expect(clampLeftWidth(400, 900, 380)).toBe(148)
  })

  it('容器窄到算不出空间时返回 0 而不是负数', () => {
    expect(clampLeftWidth(300, 700, 640)).toBe(0)
  })

  it('结果永远是整数（避免亚像素抖动导致拖拽手感发麻）', () => {
    expect(clampLeftWidth(260.6, WIDE, 380)).toBe(261)
    expect(clampLeftWidth(260.4, WIDE, 380)).toBe(260)
  })
})

describe('clampRightWidth', () => {
  it('默认值原样保留', () => {
    expect(clampRightWidth(DEFAULT_PANEL_WIDTHS.right, WIDE, DEFAULT_PANEL_WIDTHS.left)).toBe(380)
  })

  it('低于最小宽度时抬到 320', () => {
    expect(clampRightWidth(10, WIDE, 260)).toBe(LAYOUT_LIMITS.right.min)
  })

  it('高于最大宽度时压到 640', () => {
    expect(clampRightWidth(9999, WIDE, 260)).toBe(LAYOUT_LIMITS.right.max)
  })

  it('容器不足时按预算收缩', () => {
    // 1024 - 260(左) - 360(中) - 12 = 392
    expect(clampRightWidth(600, 1024, 260)).toBe(392)
  })
})

describe('对偶性：先拖左再拖右不应产生负空间', () => {
  it('任意拖拽序列后，三段宽度之和都不超过容器', () => {
    const container = 1280
    let left = DEFAULT_PANEL_WIDTHS.left
    let right = DEFAULT_PANEL_WIDTHS.right
    const deltas = [400, -500, 300, -200, 900, -900, 120]

    for (const delta of deltas) {
      left = clampLeftWidth(left + delta, container, right)
      right = clampRightWidth(right + delta, container, left)
      const total = left + right + LAYOUT_LIMITS.center.min + LAYOUT_LIMITS.splitter * 2
      expect(total).toBeLessThanOrEqual(container)
      expect(left).toBeGreaterThanOrEqual(0)
      expect(right).toBeGreaterThanOrEqual(0)
    }
  })

  it('键盘步长是 16px，且能被 clamp 继续约束', () => {
    expect(KEYBOARD_STEP).toBe(16)
    const nudged = clampLeftWidth(DEFAULT_PANEL_WIDTHS.left + KEYBOARD_STEP, WIDE, 380)
    expect(nudged).toBe(276)
  })
})

describe('normalizePanelWidths（persist 脏数据归一）', () => {
  it('合法对象直接采用并取整', () => {
    expect(normalizePanelWidths({ left: 300, right: 420 })).toEqual({ left: 300, right: 420 })
    expect(normalizePanelWidths({ left: 300.7, right: 420.2 })).toEqual({ left: 301, right: 420 })
  })

  it('越界值压回合法区间', () => {
    expect(normalizePanelWidths({ left: 9999, right: -5 })).toEqual({ left: 480, right: 320 })
  })

  it('非对象/缺字段/字符串回落到默认值', () => {
    expect(normalizePanelWidths(null)).toEqual(DEFAULT_PANEL_WIDTHS)
    expect(normalizePanelWidths('wide')).toEqual(DEFAULT_PANEL_WIDTHS)
    expect(normalizePanelWidths({})).toEqual(DEFAULT_PANEL_WIDTHS)
    expect(normalizePanelWidths({ left: '300', right: Number.NaN })).toEqual(DEFAULT_PANEL_WIDTHS)
  })
})
