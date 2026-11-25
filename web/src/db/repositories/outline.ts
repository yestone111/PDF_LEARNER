import { OutlineNodeSchema, parseStrict } from '../../domain'
import { getDb } from '../database'

import type { OutlineNode } from '../../domain'

/** 整棵目录一次性替换（重新解析 outline 时的幂等写法）。 */
export async function replaceOutline(
  documentId: string,
  nodes: readonly OutlineNode[],
): Promise<void> {
  for (const node of nodes) {
    const checked = parseStrict(OutlineNodeSchema, node, 'OutlineNode')
    if (!checked.ok) throw new Error(checked.message)
  }

  const db = getDb()
  await db.transaction('rw', db.outlineNodes, async () => {
    await db.outlineNodes.where('documentId').equals(documentId).delete()
    if (nodes.length > 0) await db.outlineNodes.bulkAdd([...nodes])
  })
}

export async function loadOutline(documentId: string): Promise<OutlineNode[]> {
  const db = getDb()
  const rows = await db.outlineNodes.where('documentId').equals(documentId).toArray()
  return rows.sort((a, b) => a.level - b.level || a.order - b.order)
}

export async function markChapterGraphBuilt(
  outlineNodeId: string,
  built: boolean,
): Promise<void> {
  const db = getDb()
  await db.outlineNodes.update(outlineNodeId, { graphBuilt: built, updatedAt: Date.now() })
}
