import { ChatMessageSchema, ChatThreadSchema, parseStrict } from '../../domain'
import { newId } from '../../lib/id'
import { getDb } from '../database'

import type { ChatMessage, ChatThread } from '../../domain'

export async function ensureThread(documentId: string, title: string): Promise<ChatThread> {
  const db = getDb()
  const existing = await db.chatThreads.where('documentId').equals(documentId).toArray()
  if (existing.length > 0) return existing[0]

  const thread: ChatThread = {
    id: newId(),
    documentId,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const checked = parseStrict(ChatThreadSchema, thread, 'ChatThread')
  if (!checked.ok) throw new Error(checked.message)
  await db.chatThreads.add(thread)
  return thread
}

export async function listMessages(threadId: string): Promise<ChatMessage[]> {
  return getDb().chatMessages.where('threadId').equals(threadId).sortBy('createdAt')
}

export async function addChatMessage(message: ChatMessage): Promise<void> {
  const checked = parseStrict(ChatMessageSchema, message, 'ChatMessage')
  if (!checked.ok) throw new Error(checked.message)
  await getDb().chatMessages.put(message)
}

export async function clearThreadMessages(threadId: string): Promise<void> {
  await getDb().chatMessages.where('threadId').equals(threadId).delete()
}
