import { HighlightSchema, parseStrict } from '../../domain'
import { getDb } from '../database'

import type { Highlight } from '../../domain'

export async function listHighlights(documentId: string): Promise<Highlight[]> {
  const db = getDb()
  const rows = await db.highlights.where('documentId').equals(documentId).toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function addHighlight(highlight: Highlight): Promise<void> {
  const checked = parseStrict(HighlightSchema, highlight, 'Highlight')
  if (!checked.ok) throw new Error(checked.message)
  await getDb().highlights.add(highlight)
}

export async function updateHighlightComment(
  highlightId: string,
  comment: Highlight['comment'],
  nodeId?: string | null,
): Promise<void> {
  const patch =
    nodeId === undefined
      ? { comment, updatedAt: Date.now() }
      : { comment, nodeId, updatedAt: Date.now() }
  await getDb().highlights.update(highlightId, patch)
}

export async function deleteHighlight(highlightId: string): Promise<void> {
  await getDb().highlights.delete(highlightId)
}

export async function linkHighlightToNode(
  highlightId: string,
  nodeId: string | null,
): Promise<void> {
  await getDb().highlights.update(highlightId, { nodeId, updatedAt: Date.now() })
}
