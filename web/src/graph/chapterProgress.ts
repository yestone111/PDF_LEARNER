/**
 * 章节掌握度（给左栏目录画三种状态圈）。
 *
 * 三种状态（用户定义）：
 *   complete（实心绿圈） = 这一章的知识点全部已掌握
 *   partial （半实心绿圈） = 掌握了一部分
 *   none    （灰色空心圈） = 还没开始 / 一个都没掌握（含「本章没有知识点」）
 *
 * 归属规则（一条知识点只算一次，避免父子重复计数）：
 *   1) 章节子图里的节点有 `chapterId`：直接算给那一章；
 *   2) 其余节点按锚点页码找「当前章」：在所有起始页 ≤ 该页的章节里，
 *      取起始页最大、层级最深的那一个（区间查询，不需要知道章节结束页）；
 *   3) 无锚点又无 chapterId 的节点不计入。
 *   最后沿 parentId 逐级上卷，父章节拿到整棵子树的合计。
 *
 * 纯函数：不碰 store / Dexie，可单测。
 */

import type { KnowledgeNode, OutlineNode } from '../domain'

export type ChapterMasteryState = 'none' | 'partial' | 'complete'

export interface ChapterProgress {
  readonly state: ChapterMasteryState
  readonly total: number
  readonly mastered: number
}

export const EMPTY_PROGRESS: ChapterProgress = { state: 'none', total: 0, mastered: 0 }

interface Entry {
  readonly id: string
  readonly parentId: string | null
  readonly start: number | null
  readonly depth: number
  readonly order: number
}

function buildEntries(outline: readonly OutlineNode[]): Entry[] {
  const byId = new Map(outline.map((node) => [node.id, node]))
  const children = new Map<string | null, OutlineNode[]>()
  for (const node of outline) {
    const parent = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null
    const bucket = children.get(parent) ?? []
    bucket.push(node)
    children.set(parent, bucket)
  }
  for (const bucket of children.values()) bucket.sort((a, b) => a.order - b.order)

  const startById = new Map<string, number | null>()
  const depthById = new Map<string, number>()
  const orderById = new Map<string, number>()
  let counter = 0

  // 后序遍历：没有自身页码的章节，用子树里第一个有页码的后代兜底
  const walk = (node: OutlineNode, depth: number): number | null => {
    depthById.set(node.id, depth)
    orderById.set(node.id, counter)
    counter += 1
    let start: number | null = node.page
    for (const child of children.get(node.id) ?? []) {
      const childStart = walk(child, depth + 1)
      if (start === null && childStart !== null) start = childStart
    }
    startById.set(node.id, start)
    return start
  }
  for (const root of children.get(null) ?? []) walk(root, 0)

  return outline.map((node) => ({
    id: node.id,
    parentId: node.parentId !== null && byId.has(node.parentId) ? node.parentId : null,
    start: startById.get(node.id) ?? null,
    depth: depthById.get(node.id) ?? 0,
    order: orderById.get(node.id) ?? 0,
  }))
}

/** 页码 → 所属章节（起始页 ≤ 页码，取最靠后/最深的那个）。 */
function chapterForPage(entries: readonly Entry[], page: number): Entry | null {
  let best: Entry | null = null
  for (const entry of entries) {
    if (entry.start === null || entry.start > page) continue
    if (
      best === null ||
      entry.start > (best.start ?? -1) ||
      (entry.start === best.start && entry.depth > best.depth) ||
      (entry.start === best.start && entry.depth === best.depth && entry.order > best.order)
    ) {
      best = entry
    }
  }
  return best
}

/**
 * 把「全局节点 + 章节细化节点」折成「概念」集合。
 *
 * 抽取会为同一批知识点写两份记录：`scope='global'`（① 总览图）与
 * `scope='chapter'`（② 章节拆解，parentId 可能指向全局节点，也可能为空）。
 * 直接数记录会把同一个概念算两次（手册实测 12 个点被数成 69 条），所以按 **titleNorm** 归并：
 *   1) 一个概念 = 同一个 titleNorm；mastery 取「任一记录已掌握」（① ② 两个视图里学都算）；
 *   2) 归属章节优先用章节记录的 chapterId，没有就按锚点页码找当前章；
 *   3) 页码取任一记录的锚点（没有锚点的概念不参与章节归属）。
 */
export interface Concept {
  readonly key: string
  readonly mastered: boolean
  readonly chapterId: string | null
  readonly page: number | null
}

export function collectConcepts(nodes: readonly KnowledgeNode[]): Concept[] {
  const byKey = new Map<string, { mastered: boolean; chapterId: string | null; page: number | null }>()
  for (const node of nodes) {
    const key = node.titleNorm !== '' ? node.titleNorm : node.title
    const acc = byKey.get(key) ?? { mastered: false, chapterId: null, page: null }
    if (node.mastery === 'mastered') acc.mastered = true
    if (acc.chapterId === null && node.chapterId !== null) acc.chapterId = node.chapterId
    if (acc.page === null && node.anchor !== null) acc.page = node.anchor.page
    byKey.set(key, acc)
  }
  return [...byKey.entries()].map(([key, acc]) => ({
    key,
    mastered: acc.mastered,
    chapterId: acc.chapterId,
    page: acc.page,
  }))
}

export function computeChapterProgress(
  outline: readonly OutlineNode[],
  nodes: readonly KnowledgeNode[],
): ReadonlyMap<string, ChapterProgress> {
  const entries = buildEntries(outline)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const parentOf = new Map(entries.map((entry) => [entry.id, entry.parentId]))

  const total = new Map<string, number>()
  const mastered = new Map<string, number>()

  const attribute = (chapterId: string, isMastered: boolean): void => {
    // 逐级上卷：这一章 + 所有祖先各 +1
    let cursor: string | null = chapterId
    const seen = new Set<string>()
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor)
      total.set(cursor, (total.get(cursor) ?? 0) + 1)
      if (isMastered) mastered.set(cursor, (mastered.get(cursor) ?? 0) + 1)
      cursor = parentOf.get(cursor) ?? null
    }
  }

  for (const concept of collectConcepts(nodes)) {
    if (concept.chapterId !== null && byId.has(concept.chapterId)) {
      attribute(concept.chapterId, concept.mastered)
      continue
    }
    if (concept.page === null) continue
    const chapter = chapterForPage(entries, concept.page)
    if (chapter === null) continue
    attribute(chapter.id, concept.mastered)
  }

  const result = new Map<string, ChapterProgress>()
  for (const entry of entries) {
    const nodeTotal = total.get(entry.id) ?? 0
    const nodeMastered = mastered.get(entry.id) ?? 0
    const state: ChapterMasteryState =
      nodeTotal === 0 || nodeMastered === 0
        ? 'none'
        : nodeMastered >= nodeTotal
          ? 'complete'
          : 'partial'
    result.set(entry.id, { state, total: nodeTotal, mastered: nodeMastered })
  }
  return result
}
