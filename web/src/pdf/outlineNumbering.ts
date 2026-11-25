/**
 * 目录编号（章节标志）。
 *
 * 目录来自 PDF 书签，本身只有层级（level 1..n），没有「1.2.3」这样的编号。
 * 读者需要一眼看出「这是第几章、第几节」，所以这里按层级生成层级编号：
 *   [1,2,2,1,2] → ["1", "1.1", "1.2", "2", "2.1"]
 *
 * 边界：
 *  - PDF 目录可能从 level 2 开始（没有一级标题）→ 缺的父级补 1，得到 "1.1" 而不是 "0.1"；
 *  - 层级跳变（1 → 3）同样补 1；
 *  - level 收敛到 1..6，避免异常层级把编号撑爆。
 */

export const MAX_OUTLINE_LEVEL = 6

// 标题自带编号的常见写法：1 / 1.2 / 一、 / 第一章 / Chapter 3
const SELF_NUMBERED = /^\s*(?:\d+(?:\.\d+)*\s*[.、:：]?|[一二三四五六七八九十]+\s*[、.]|第\s*[一二三四五六七八九十百\d]+\s*[章节篇]|chapter\s*\d+|section\s*\d+)/i

/** 标题是否已经自带编号（自带就不再重复显示我们生成的编号）。 */
export function outlineTitleHasNumber(title: string): boolean {
  return SELF_NUMBERED.test(title)
}

export function outlineNumbers(nodes: readonly { level: number }[]): string[] {
  const counters: number[] = []

  return nodes.map((node) => {
    const level = Math.max(1, Math.min(MAX_OUTLINE_LEVEL, Math.round(node.level) || 1))
    counters.length = level

    // 缺的祖先层级先补 0 再统一修成 1（表示「没有一级标题时也给出可读编号」）
    for (let index = 0; index < level; index += 1) {
      if (!Number.isFinite(counters[index])) counters[index] = 0
    }
    counters[level - 1] = (counters[level - 1] ?? 0) + 1
    for (let index = 0; index < level - 1; index += 1) {
      if (counters[index] === 0) counters[index] = 1
    }

    return counters.join('.')
  })
}


/** 目录树节点（与 outline.ts 的 OutlineTreeNode 结构兼容，避免循环依赖）。 */
export interface NumberableEntry {
  readonly node: { readonly id: string }
  readonly children: readonly NumberableEntry[]
}

/**
 * 按**树的结构**做 DFS 编号（推荐用法）。
 *
 * 为什么不用扁平顺序：PDF 书签可能把「第一章的小节」排在第八章之后，
 * 按数组顺序编号会得到 8.1（这就是真实现象）；按树的父子关系 DFS 才会得到 1.1。
 */
export function outlineNumbersFromTree(tree: readonly NumberableEntry[]): Map<string, string> {
  const numbers = new Map<string, string>()
  const counters: number[] = []

  const walk = (entries: readonly NumberableEntry[], depth: number): void => {
    for (const entry of entries) {
      counters.length = depth + 1
      counters[depth] = (counters[depth] ?? 0) + 1
      numbers.set(entry.node.id, counters.join('.'))
      if (entry.children.length > 0) walk(entry.children, depth + 1)
    }
  }

  walk(tree, 0)
  return numbers
}
