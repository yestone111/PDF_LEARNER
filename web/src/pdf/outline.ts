/**
 * PDF outline → OutlineNode 的纯变换（可单测）。
 *
 * 两条硬规则（对应任务书「不得伪造重要度」）：
 * 1) 这里**从不**推断重要度：`predictedImportance` 一律 null、`importanceSource` 一律 'none'；
 * 2) `dest` 解析失败 → page 为 null，UI 只能显示但不能跳转，绝不编造页码。
 */

import type { OutlineNode } from '../domain/types'
import { repairPdfText } from './textDecoding'

/** pdfjs `getOutline()` 的条目形状（只取我们用到的字段）。 */
export interface RawOutlineItem {
  readonly title: string
  readonly dest: unknown
  readonly items?: readonly RawOutlineItem[]
}

export interface BuildOutlineParams {
  readonly documentId: string
  readonly items: readonly RawOutlineItem[]
  /** 解析 dest → 1-based 页码；无法解析必须返回 null。 */
  readonly resolvePage: (dest: unknown) => Promise<number | null>
  /** 注入 id 生成器，便于测试确定性。 */
  readonly createId: () => string
  readonly timestamp: number
}

/** 防御病态 PDF：目录层级/总数上限，超出部分直接丢弃（并保持结构不破）。 */
export const MAX_OUTLINE_DEPTH = 6
export const MAX_OUTLINE_NODES = 500

function cleanTitle(title: string): string {
  // 中文 PDF 的书签常把 GBK/UTF-8 字节塞进 PDF 字符串，按规范解出来就是乱码，
  // 这里先尝试还原（「ç®å½」→「目录」），再做空白归一。
  const repaired = repairPdfText(title)
  const normalized = repaired.replace(/\s+/g, ' ').trim()
  return normalized === '' ? '（未命名章节）' : normalized
}

/**
 * 深度优先展开成扁平数组：parentId 指向父节点，order 是同级序号（从 0 开始），level 从 1 开始。
 * 扁平存储的好处：一次 `where('documentId')` 就能取全树，UI 再按 parentId 组装。
 */
export async function buildOutlineNodes(params: BuildOutlineParams): Promise<OutlineNode[]> {
  const nodes: OutlineNode[] = []

  const walk = async (
    items: readonly RawOutlineItem[],
    parentId: string | null,
    level: number,
  ): Promise<void> => {
    if (level > MAX_OUTLINE_DEPTH) return

    let order = 0
    for (const item of items) {
      if (nodes.length >= MAX_OUTLINE_NODES) return

      const id = params.createId()
      const page = await params.resolvePage(item.dest).catch(() => null)

      nodes.push({
        id,
        documentId: params.documentId,
        parentId,
        order,
        level,
        title: cleanTitle(item.title),
        // 页码无效（0/负数/非整数）一律视为解析失败，不写入伪造页码
        page: typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : null,
        predictedImportance: null,
        importanceSource: 'none',
        graphBuilt: false,
        createdAt: params.timestamp,
        updatedAt: params.timestamp,
      })
      order += 1

      const children = item.items ?? []
      if (children.length > 0) {
        await walk(children, id, level + 1)
      }
    }
  }

  await walk(params.items, null, 1)
  return nodes
}

/** 把扁平数组组装成渲染树（UI 只做这一件事，不做排序魔法）。 */
export interface OutlineTreeNode {
  readonly node: OutlineNode
  readonly children: readonly OutlineTreeNode[]
}

export function assembleOutlineTree(nodes: readonly OutlineNode[]): OutlineTreeNode[] {
  const byParent = new Map<string | null, OutlineNode[]>()
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? []
    list.push(node)
    byParent.set(node.parentId, list)
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.order - b.order)
  }

  const build = (parentId: string | null): OutlineTreeNode[] =>
    (byParent.get(parentId) ?? []).map((node) => ({
      node,
      children: build(node.id),
    }))

  return build(null)
}
