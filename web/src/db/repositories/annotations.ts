/** 节点笔记（Note 实体）的仓储。高亮本身走 highlights.ts。 */

import { NoteSchema, parseStrict } from '../../domain'
import { getDb } from '../database'

import type { Note } from '../../domain'

export async function saveNote(note: Note): Promise<void> {
  const checked = parseStrict(NoteSchema, note, 'Note')
  if (!checked.ok) throw new Error(checked.message)
  await getDb().notes.put(note)
}

export async function listNotesForNode(nodeId: string): Promise<Note[]> {
  const db = getDb()
  const rows = await db.notes.where('nodeId').equals(nodeId).toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function listNotesForDocument(documentId: string): Promise<Note[]> {
  return getDb().notes.where('documentId').equals(documentId).toArray()
}

export async function deleteNote(noteId: string): Promise<void> {
  await getDb().notes.delete(noteId)
}
