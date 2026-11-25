import { create } from 'zustand'

import type { NoteDoc, NoteImage } from '../domain'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface QueuedChatCard {
  readonly id: string
  readonly messageId: string
  readonly question: string
  readonly answer: string
  readonly citations: readonly { page: number | null; quote: string; verified: boolean }[]
  readonly createdAt: number
}

interface NotesState {
  noteDoc: NoteDoc | null
  /** 已点「发送到总结笔记」的 AI 回答，Step 5 会把它们插入 TipTap 文档。 */
  queuedChatCards: readonly QueuedChatCard[]
  images: Readonly<Record<string, NoteImage>>
  /** TipTap 内容是否有未落库改动。 */
  dirty: boolean
  saveStatus: SaveStatus
  error: string | null

  setNoteDoc: (noteDoc: NoteDoc | null) => void
  queueChatCard: (card: QueuedChatCard) => void
  removeQueuedChatCard: (id: string) => void
  clearQueuedChatCards: () => void
  registerImage: (image: NoteImage) => void
  markDirty: (dirty: boolean) => void
  setSaveStatus: (status: SaveStatus, error?: string | null) => void
  clear: () => void
}

/**
 * 笔记骨架。TipTap JSON 是唯一真源（第一轮 D8），
 * Markdown 不落库、导出时实时序列化。
 */
export const useNotesStore = create<NotesState>()((set) => ({
  noteDoc: null,
  queuedChatCards: [],
  images: {},
  dirty: false,
  saveStatus: 'idle',
  error: null,

  setNoteDoc: (noteDoc) => set({ noteDoc, dirty: false }),

  queueChatCard: (card) =>
    set((state) => ({ queuedChatCards: [...state.queuedChatCards, card], dirty: true })),

  removeQueuedChatCard: (id) =>
    set((state) => ({ queuedChatCards: state.queuedChatCards.filter((card) => card.id !== id) })),

  clearQueuedChatCards: () => set({ queuedChatCards: [] }),
  registerImage: (image) => set((state) => ({ images: { ...state.images, [image.id]: image } })),
  markDirty: (dirty) => set({ dirty }),
  setSaveStatus: (saveStatus, error = null) => set({ saveStatus, error }),
  clear: () =>
    set({ noteDoc: null, queuedChatCards: [], images: {}, dirty: false, saveStatus: 'idle', error: null }),
}))
