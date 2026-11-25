/**
 * 伴读对话控制器：context chip → 组装 prompt → 流式接收 → 引注校验 → 落库。
 *
 * 纪律：
 * - 流式增量只写 store 里的同一条消息（status='streaming'），结束后才写 Dexie；
 * - 引注必须过 citation.ts 的二次校验（不信任模型给得页码）；
 * - 错误显式写进 store（不静默）。
 */

import { addChatMessage, ensureThread } from '../db/repositories/chat'
import { newId } from '../lib/id'
import { readAllPagesText } from '../llm/pipeline/controller'
import { useChatStore } from '../stores/chatStore'
import { useDocumentStore } from '../stores/documentStore'
import { streamChat } from '../llm/client'
import { languageDirective } from '../llm/prompts/language'
import { useUiStore } from '../stores/uiStore'
import { extractCitations } from './citation'

import type { ChatMessage, ContextSnapshot } from '../domain'
import type { PageText } from '../llm/pipeline/chunking'

const systemPrompt = [
  '你是 PDF 伴读助手，只根据【原文摘录】和【上下文】回答，不要编造。',
  '回答里每条关键结论都要给出引注，格式严格为：[引用] 第N页：「原文片段」',
  '引文必须逐字来自原文；原文里找不到依据时，明确写「无直接出处」，不要猜页码。',
  '用中文回答，简洁，可以用短列表。',
].join('\n')

/** 章节页文本按文档缓存，避免每次提问都重读整份 PDF。 */
const pageTextCache = new Map<string, PageText[]>()

async function getPageTexts(documentId: string): Promise<PageText[]> {
  const cached = pageTextCache.get(documentId)
  if (cached !== undefined) return cached
  const pages = await readAllPagesText()
  pageTextCache.set(documentId, pages)
  return pages
}

export function invalidatePageTextCache(documentId: string): void {
  pageTextCache.delete(documentId)
}

function buildUserContent(question: string, chips: readonly ContextSnapshot[], currentPage: number, pages: PageText[]): string {
  const excerpt = pages.find((page) => page.page === currentPage)?.text?.slice(0, 200) ?? ''
  const lines: string[] = []
  if (excerpt !== '') {
    lines.push(`【原文摘录】第${currentPage}页：「${excerpt}」`)
  }
  if (chips.length > 0) {
    lines.push('【上下文】')
    for (const chip of chips) lines.push(`- ${chip.label}（p.${chip.page ?? '?'}）：${chip.text.slice(0, 300)}`)
  }
  lines.push(`【问题】${question}`)
  return lines.join('\n')
}

export async function sendQuestion(question: string): Promise<void> {
  const trimmed = question.trim()
  if (trimmed === '') return

  const store = useChatStore.getState()
  const activeDocument = useDocumentStore.getState().document
  if (activeDocument === null) {
    store.setError('请先打开 PDF')
    return
  }
  if (store.streaming) return

  store.setError(null)

  const thread = await ensureThread(activeDocument.id, trimmed.slice(0, 24) || '新对话')
  useChatStore.getState().setThread(thread)

  const chips = store.contextChips
  const timestamp = Date.now()

  const userMessage: ChatMessage = {
    id: newId(),
    threadId: thread.id,
    documentId: activeDocument.id,
    role: 'user',
    content: trimmed,
    citations: [],
    context: chips,
    status: 'done',
    error: null,
    createdAt: timestamp,
  }
  useChatStore.getState().upsertMessage(userMessage)

  const assistantId = newId()
  const assistantMessage: ChatMessage = {
    id: assistantId,
    threadId: thread.id,
    documentId: activeDocument.id,
    role: 'assistant',
    content: '',
    citations: [],
    context: [],
    status: 'streaming',
    error: null,
    createdAt: timestamp + 1,
  }
  useChatStore.getState().upsertMessage(assistantMessage)
  useChatStore.getState().setStreaming(true)

  let streamed = ''
  try {
    const pages = await getPageTexts(activeDocument.id)
    const currentPage = useDocumentStore.getState().pageNumber
    const userContent = buildUserContent(trimmed, chips, currentPage, pages)

    const directive = languageDirective(useUiStore.getState().primaryLanguage)
    const system = directive === '' ? systemPrompt : `${systemPrompt}\n\n${directive}`

    for await (const delta of streamChat([
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ])) {
      streamed += delta
      useChatStore.getState().upsertMessage({ ...assistantMessage, content: streamed })
    }

    const citations = extractCitations(streamed, pages)
    const finished: ChatMessage = {
      ...assistantMessage,
      content: streamed,
      citations,
      status: 'done',
    }
    useChatStore.getState().upsertMessage(finished)
    useChatStore.getState().clearContextChips()

    try {
      await addChatMessage(userMessage)
      await addChatMessage(finished)
    } catch (error) {
      useChatStore.getState().setError(
        `回答已生成，但落库失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    useChatStore.getState().upsertMessage({
      ...assistantMessage,
      content: streamed,
      status: 'error',
      error: message,
    })
    useChatStore.getState().setError(message)
  } finally {
    useChatStore.getState().setStreaming(false)
  }
}
