/**
 * 目录节点过滤。
 *
 * 目录（outline）本身**不是知识点**：它和谁都能「有关系」，若混进图谱会：
 *   - 把所有章节都连成一张星形图，稀释真正的语义关联；
 *   - 让「大小 = 关联程度」失真（目录条目天然被连很多次）；
 *   - 让「总纲」被章节标题占据。
 *
 * 因此：凡是与目录标题**归一化后完全相同**的节点，一律不进入知识点图谱（全局与章节视图都排除）。
 * 只做精确匹配，避免把「第三章的方法」这类真正的知识点误删。
 */

import { normalizeTitle } from './merge'

export interface OutlineLike {
  readonly title: string
}

/** 目录标题的归一化键集合（与节点 titleNorm 同一套规则）。 */
export function outlineTitleKeys(outline: readonly OutlineLike[]): Set<string> {
  const keys = new Set<string>()
  for (const item of outline) {
    const key = normalizeTitle(item.title)
    if (key !== '') keys.add(key)
  }
  return keys
}

/** 该标题是否就是目录条目本身（精确匹配，内部先归一化；不做模糊判断）。 */
export function isOutlineDerivedTitle(title: string, keys: ReadonlySet<string>): boolean {
  return keys.has(normalizeTitle(title))
}
