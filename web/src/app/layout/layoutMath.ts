/**
 * 三栏布局的纯几何逻辑。
 *
 * 单独成文件的原因（工程纪律 §8.3）：
 * 宽度钳制是最容易被「感觉对」掩盖 bug 的地方（拖拽到头、窗口变窄、持久化脏数据），
 * 必须能脱离 DOM 单测。
 *
 * 契约：
 * - 任何输入都返回「不会让中间阅读区低于最小宽度」的整数像素；
 * - 中间区（PDF）优先：左右都让位给 MIN_CENTER；
 * - 窗口窄到连 MIN_CENTER + 两侧最小宽度都放不下时，优先保证不横向溢出（返回可用值）。
 */

export type PanelSide = 'left' | 'right'

export interface PanelWidths {
  readonly left: number
  readonly right: number
}

export const LAYOUT_LIMITS = {
  left: { min: 200, max: 480, default: 260 },
  right: { min: 320, max: 640, default: 380 },
  center: { min: 360 },
  /** 分隔条本身占的宽度（每条 6px，两条共 12px）。 */
  splitter: 6,
} as const

export const DEFAULT_PANEL_WIDTHS: PanelWidths = {
  left: LAYOUT_LIMITS.left.default,
  right: LAYOUT_LIMITS.right.default,
}

function clamp(value: number, lower: number, upper: number): number {
  if (Number.isNaN(value)) return lower
  return Math.min(Math.max(value, lower), upper)
}

/**
 * 左栏可用上限 = 容器宽 - 右栏 - 中间最小宽 - 两条分隔条。
 * 这里把「可用上限」当成硬约束：即使它小于左栏设计最小宽，也以它为准（宁可挤左栏，也不让 PDF 区被压没）。
 */
function leftBudget(containerWidth: number, rightWidth: number): number {
  return containerWidth - rightWidth - LAYOUT_LIMITS.center.min - LAYOUT_LIMITS.splitter * 2
}

function rightBudget(containerWidth: number, leftWidth: number): number {
  return containerWidth - leftWidth - LAYOUT_LIMITS.center.min - LAYOUT_LIMITS.splitter * 2
}

export function clampLeftWidth(desired: number, containerWidth: number, rightWidth: number): number {
  const budget = Math.max(0, leftBudget(containerWidth, rightWidth))
  const upper = Math.min(LAYOUT_LIMITS.left.max, budget)
  const lower = Math.min(LAYOUT_LIMITS.left.min, upper)
  return Math.round(clamp(desired, lower, upper))
}

export function clampRightWidth(desired: number, containerWidth: number, leftWidth: number): number {
  const budget = Math.max(0, rightBudget(containerWidth, leftWidth))
  const upper = Math.min(LAYOUT_LIMITS.right.max, budget)
  const lower = Math.min(LAYOUT_LIMITS.right.min, upper)
  return Math.round(clamp(desired, lower, upper))
}

/** 键盘微调用的步长（一次按方向键移动多少像素）。 */
export const KEYBOARD_STEP = 16

/**
 * 持久化脏数据归一：localStorage 里的宽度可能是旧版本、被手改、或根本不是数字。
 * 这里不做「聪明修复」，只做「合法就用，不合法就回默认」。
 */
export function normalizePanelWidths(value: unknown): PanelWidths {
  if (typeof value !== 'object' || value === null) return DEFAULT_PANEL_WIDTHS
  const candidate = value as { left?: unknown; right?: unknown }
  const pick = (raw: unknown, fallback: number, min: number, max: number): number => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
    return Math.round(clamp(raw, min, max))
  }
  return {
    left: pick(candidate.left, LAYOUT_LIMITS.left.default, LAYOUT_LIMITS.left.min, LAYOUT_LIMITS.left.max),
    right: pick(candidate.right, LAYOUT_LIMITS.right.default, LAYOUT_LIMITS.right.min, LAYOUT_LIMITS.right.max),
  }
}
