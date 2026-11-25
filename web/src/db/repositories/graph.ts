import { KnowledgeEdgeSchema, KnowledgeNodeSchema, parseStrict } from '../../domain'
import { getDb } from '../database'

import type { KnowledgeEdge, KnowledgeNode } from '../../domain'

function validateAll(nodes: readonly KnowledgeNode[], edges: readonly KnowledgeEdge[]): void {
  for (const node of nodes) {
    const checked = parseStrict(KnowledgeNodeSchema, node, 'KnowledgeNode')
    if (!checked.ok) throw new Error(checked.message)
  }
  for (const edge of edges) {
    const checked = parseStrict(KnowledgeEdgeSchema, edge, 'KnowledgeEdge')
    if (!checked.ok) throw new Error(checked.message)
  }
}

/** 整图替换（重新抽取时使用；单事务避免「删了一半」的中间态）。 */
export async function replaceDocumentGraph(
  documentId: string,
  nodes: readonly KnowledgeNode[],
  edges: readonly KnowledgeEdge[],
): Promise<void> {
  validateAll(nodes, edges)
  const db = getDb()
  await db.transaction('rw', db.knowledgeNodes, db.knowledgeEdges, async () => {
    await db.knowledgeEdges.where('documentId').equals(documentId).delete()
    await db.knowledgeNodes.where('documentId').equals(documentId).delete()
    if (nodes.length > 0) await db.knowledgeNodes.bulkAdd([...nodes])
    if (edges.length > 0) await db.knowledgeEdges.bulkAdd([...edges])
  })
}

export async function listDocumentGraph(
  documentId: string,
): Promise<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }> {
  const db = getDb()
  const nodes = await db.knowledgeNodes.where('documentId').equals(documentId).toArray()
  const edges = await db.knowledgeEdges.where('documentId').equals(documentId).toArray()
  return { nodes, edges }
}

export async function setNodeMastery(
  nodeId: string,
  mastery: KnowledgeNode['mastery'],
): Promise<void> {
  await getDb().knowledgeNodes.update(nodeId, { mastery, updatedAt: Date.now() })
}

/** 章节子图替换：只动该章节的节点与边，不碰全局图。 */
export async function replaceChapterGraph(
  documentId: string,
  chapterId: string,
  nodes: readonly KnowledgeNode[],
  edges: readonly KnowledgeEdge[],
): Promise<void> {
  validateAll(nodes, edges)
  const db = getDb()
  await db.transaction('rw', db.knowledgeNodes, db.knowledgeEdges, async () => {
    const existing = await db.knowledgeNodes.where('documentId').equals(documentId).toArray()
    const chapterNodeIds = new Set(
      existing.filter((node) => node.chapterId === chapterId).map((node) => node.id),
    )
    const allEdges = await db.knowledgeEdges.where('documentId').equals(documentId).toArray()
    const removable = allEdges
      .filter((edge) => chapterNodeIds.has(edge.sourceId) || chapterNodeIds.has(edge.targetId))
      .map((edge) => edge.id)
    if (removable.length > 0) await db.knowledgeEdges.bulkDelete(removable)
    if (chapterNodeIds.size > 0) await db.knowledgeNodes.bulkDelete([...chapterNodeIds])
    if (nodes.length > 0) await db.knowledgeNodes.bulkAdd([...nodes])
    if (edges.length > 0) await db.knowledgeEdges.bulkAdd([...edges])
  })
}
