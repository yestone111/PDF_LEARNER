/** 笔记文档的加载与防抖保存（单一出口，组件不直接碰 Dexie）。 */

import { useCallback, useEffect, useRef } from 'react'

import { loadNoteDoc, saveNoteDoc } from '../db/repositories/notes'
import { newId } from '../lib/id'
import { useDocumentStore } from '../stores/documentStore'
import { useNotesStore } from '../stores/notesStore'

import type { TiptapDoc } from '../domain'

export const EMPTY_DOC: TiptapDoc = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
}

export function useNoteDoc(): {
  readonly ready: boolean
  readonly persist: (content: TiptapDoc) => void
} {
  const documentId = useDocumentStore((state) => state.document?.id ?? null)
  const noteDoc = useNotesStore((state) => state.noteDoc)
  const setNoteDoc = useNotesStore((state) => state.setNoteDoc)
  const setSaveStatus = useNotesStore((state) => state.setSaveStatus)
  const timer = useRef<number | null>(null)
  const latest = useRef<TiptapDoc | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (documentId === null) return
      try {
        const existing = await loadNoteDoc(documentId)
        if (cancelled) return
        if (existing !== null) {
          setNoteDoc(existing)
          return
        }
        const created = {
          id: newId(),
          documentId,
          title: '阅读笔记',
          tiptapJson: EMPTY_DOC,
          imageIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        await saveNoteDoc(created)
        if (!cancelled) setNoteDoc(created)
      } catch (error) {
        setSaveStatus('error', error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [documentId, setNoteDoc, setSaveStatus])

  const persist = useCallback(
    (content: TiptapDoc) => {
      latest.current = content
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        const current = useNotesStore.getState().noteDoc
        const body = latest.current
        if (current === null || body === null) return
        setSaveStatus('saving')
        void saveNoteDoc({ ...current, tiptapJson: body, updatedAt: Date.now() })
          .then(() => setSaveStatus('saved'))
          .catch((error: unknown) =>
            setSaveStatus('error', error instanceof Error ? error.message : String(error)),
          )
      }, 600)
    },
    [setSaveStatus],
  )

  return { ready: noteDoc !== null, persist }
}
