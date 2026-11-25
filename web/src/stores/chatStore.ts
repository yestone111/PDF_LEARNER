import { create } from 'zustand'

import type { ChatMessage, ChatThread, ContextSnapshot } from '../domain'

interface ChatState {
  thread: ChatThread | null
  messages: readonly ChatMessage[]
  /** 下一条提问要带上的 context chip（选中文本 / 节点 / 高亮）。 */
  contextChips: readonly ContextSnapshot[]
  streaming: boolean
  error: string | null

  setThread: (thread: ChatThread | null) => void
  upsertMessage: (message: ChatMessage) => void
  addContextChip: (chip: ContextSnapshot) => void
  removeContextChip: (index: number) => void
  clearContextChips: () => void
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  clear: () => void
}

/**
 * 伴读对话骨架。
 * 注意：`messages` 里存的是**已过 zod 校验并落库**的消息（Step 4 实现）；
 * 流式过程中的增量文本只在组件本地状态里，不写进这里，避免半成品污染缓存。
 */
export const useChatStore = create<ChatState>()((set) => ({
  thread: null,
  messages: [],
  contextChips: [],
  streaming: false,
  error: null,

  setThread: (thread) => set({ thread, messages: [] }),

  upsertMessage: (message) =>
    set((state) => {
      const index = state.messages.findIndex((item) => item.id === message.id)
      if (index === -1) return { messages: [...state.messages, message] }
      const next = [...state.messages]
      next[index] = message
      return { messages: next }
    }),

  addContextChip: (chip) =>
    set((state) => ({ contextChips: [...state.contextChips, chip] })),

  removeContextChip: (index) =>
    set((state) => ({ contextChips: state.contextChips.filter((_, i) => i !== index) })),

  clearContextChips: () => set({ contextChips: [] }),

  setStreaming: (streaming) => set({ streaming }),
  setError: (error) => set({ error }),

  clear: () => set({ thread: null, messages: [], contextChips: [], streaming: false, error: null }),
}))
