/**
 * 节点视觉唯一实现点。
 *
 * 三个正交维度（2026-11-20 按用户新语义重定义）：
 *  - 尺寸 ← 关联程度（degree：该节点连了多少条边）—— 越大代表涉及面越广；
 *  - 颜色深浅 ← 掌握难度 difficulty 1–5 —— 越深代表越难掌握；
 *  - 色相 ← 掌握状态 mastery —— 未掌握红系、已掌握绿系、有疑问黄系（点击循环切换）。
 *
 * 切换掌握状态时**尺寸与深浅都不变、只有色相变**，避免节点跳动。
 * 组件里禁止出现任何手写颜色/尺寸判断：只能来自这里。
 */

import type { Importance, MasteryState } from './enums'

export interface NodeStyle {
  readonly fill: string
  readonly stroke: string
  readonly textColor: string
  readonly fontSize: number
}

interface Ramp {
  readonly fontSize: number
  readonly unmastered: string
  readonly mastered: string
  readonly doubt: string
  readonly textOnUnmastered: string
  readonly textOnMastered: string
  readonly textOnDoubt: string
  readonly stroke: string
}

/** 难度 ramp：1 最浅、5 最深（改这里等于改全产品配色，必须同步文档）。 */
const RAMP: Readonly<Record<Importance, Ramp>> = {
  5: {
    fontSize: 16,
    unmastered: '#7f1d1d',
    mastered: '#14532d',
    doubt: '#a16207',
    textOnUnmastered: '#f8fafc',
    textOnMastered: '#f8fafc',
    textOnDoubt: '#fefce8',
    stroke: '#450a0a',
  },
  4: {
    fontSize: 15,
    unmastered: '#991b1b',
    mastered: '#166534',
    doubt: '#ca8a04',
    textOnUnmastered: '#f8fafc',
    textOnMastered: '#f8fafc',
    textOnDoubt: '#1c1917',
    stroke: '#450a0a',
  },
  3: {
    fontSize: 14,
    unmastered: '#b91c1c',
    mastered: '#15803d',
    doubt: '#eab308',
    textOnUnmastered: '#f8fafc',
    textOnMastered: '#f8fafc',
    textOnDoubt: '#422006',
    stroke: '#3f0a0a',
  },
  2: {
    fontSize: 13,
    unmastered: '#ef4444',
    mastered: '#22c55e',
    doubt: '#facc15',
    textOnUnmastered: '#111827',
    textOnMastered: '#052e16',
    textOnDoubt: '#422006',
    stroke: '#7f1d1d',
  },
  1: {
    fontSize: 12,
    unmastered: '#fca5a5',
    mastered: '#86efac',
    doubt: '#fde047',
    textOnUnmastered: '#111827',
    textOnMastered: '#052e16',
    textOnDoubt: '#422006',
    stroke: '#b91c1c',
  },
}

/**
 * 难度 → 颜色（深浅）+ 字号。
 * difficulty 越高颜色越深，和掌握状态（红/绿）正交。
 */
export function nodeStyle(difficulty: Importance, mastery: MasteryState): NodeStyle {
  const ramp = RAMP[difficulty]
  if (mastery === 'mastered') {
    return { fill: ramp.mastered, stroke: ramp.stroke, textColor: ramp.textOnMastered, fontSize: ramp.fontSize }
  }
  if (mastery === 'doubt') {
    return { fill: ramp.doubt, stroke: ramp.stroke, textColor: ramp.textOnDoubt, fontSize: ramp.fontSize }
  }
  return {
    fill: ramp.unmastered,
    stroke: ramp.stroke,
    textColor: ramp.textOnUnmastered,
    fontSize: ramp.fontSize,
  }
}

/** 尺寸参数：degree 0 → 48px，参考度数处 → 112px。 */
export const NODE_SIZE = {
  minDiameter: 46,
  maxDiameter: 112,
  /** 默认参考度数（图里最大度数小于它时，调用方应传真实最大值让差异更明显）。 */
  referenceDegree: 10 as number,
  minWidth: 96,
  maxWidth: 320,
  /** 椭圆宽高比：宽度不再随标题长度变化，只跟高度（关联度）成比例。 */
  aspectRatio: 2.2,
} as const

/**
 * 关联程度 → 节点高度。
 * referenceDegree 建议传「当前图里的最大度数」：这样即使整图都很稀疏，
 * 也能看出「谁连得多、谁连得少」，而不是所有节点挤在同一档。
 */
export function nodeDiameter(degree: number, referenceDegree = NODE_SIZE.referenceDegree): number {
  const safe = Number.isFinite(degree) ? Math.max(0, degree) : 0
  const reference = Number.isFinite(referenceDegree) ? Math.max(1, referenceDegree) : NODE_SIZE.referenceDegree
  const clamped = Math.min(safe, reference)
  const ratio = Math.sqrt(clamped / reference)
  return Math.round(NODE_SIZE.minDiameter + (NODE_SIZE.maxDiameter - NODE_SIZE.minDiameter) * ratio)
}

/**
 * 节点宽度（椭圆长轴）：**只由高度决定**，宽度 = 高度 × 比例。
 *
 * 之前的实现按标题长度估宽，导致「看起来大小由字数决定」。现在两个轴都由关联度驱动，
 * 标题只在框内两行截断（hover 可看全称）。
 */
export function nodeWidth(height: number): number {
  const desired = height * NODE_SIZE.aspectRatio
  return Math.round(Math.min(NODE_SIZE.maxWidth, Math.max(NODE_SIZE.minWidth, desired)))
}

/**
 * 无难度预测值时的中性样式（章节根等）。
 * 刻意不进 nodeStyle 的签名 —— 它是「没有数据」的显式分支，不得伪造深浅。
 */
export function neutralNodeStyle(diameter = 56): NodeStyle & { readonly diameter: number } {
  return {
    fill: '#475569',
    stroke: '#1e293b',
    textColor: '#e2e8f0',
    fontSize: 12,
    diameter,
  }
}
