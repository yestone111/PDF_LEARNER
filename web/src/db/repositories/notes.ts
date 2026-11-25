import { NoteDocSchema, NoteImageSchema, parseStrict } from '../../domain'
import { getDb } from '../database'

import type { NoteDoc, NoteImage } from '../../domain'

export async function loadNoteDoc(documentId: string): Promise<NoteDoc | null> {
  const db = getDb()
  const found = await db.noteDocs.where('documentId').equals(documentId).first()
  if (found === undefined) return null
  const checked = parseStrict(NoteDocSchema, found, 'NoteDoc')
  if (!checked.ok) throw new Error(checked.message)
  return checked.data
}

export async function saveNoteDoc(note: NoteDoc): Promise<void> {
  const checked = parseStrict(NoteDocSchema, note, 'NoteDoc')
  if (!checked.ok) throw new Error(checked.message)
  await getDb().noteDocs.put(note)
}

export async function saveNoteImage(image: NoteImage): Promise<void> {
  const checked = parseStrict(NoteImageSchema, image, 'NoteImage')
  if (!checked.ok) throw new Error(checked.message)
  await getDb().noteImages.put(image)
}
