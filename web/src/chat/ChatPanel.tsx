import { useRef, useState } from 'react'

import { newId } from '../lib/id'
import { useChatStore } from '../stores/chatStore'
import { useDocumentStore } from '../stores/documentStore'
import { useNotesStore } from '../stores/notesStore'
import { sendQuestion } from './chatController'

import type { ChatMessage, Citation } from '../domain'
import type { ReactElement } from 'react'

/**
 * 右侧 AI 伴读面板（模块四）。
 * 三态：空态 / 流式中 / 错误；引注分「已核对」与「无直接出处」两种展示，绝不混同。
 */
export function ChatPanel(): ReactElement {
  const messages = useChatStore((state) => state.messages)
  const chips = useChatStore((state) => state.contextChips)
  const streaming = useChatStore((state) => state.streaming)
  const error = useChatStore((state) => state.error)
  const removeContextChip = useChatStore((state) => state.removeContextChip)
  const activeDocument = useDocumentStore((state) => state.document)
  const queueChatCard = useNotesStore((state) => state.queueChatCard)

  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const submit = (): void => {
    const question = input.trim()
    if (question === '' || streaming) return
    setInput('')
    void sendQuestion(question)
  }

  return (
    <section
      id="tabpanel-chat"
      role="tabpanel"
      aria-labelledby="tab-chat"
      data-testid="pane-chat"
      className="flex h-full flex-col"
    >
      <div ref={listRef} data-testid="chat-messages" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div
            data-testid="chat-empty"
            className="rounded-lg border border-dashed border-akn-border px-3 py-8 text-center"
          >
            <p className="text-xs font-medium text-akn-ink/80">还没有对话</p>
            <p className="mt-2 text-[11px] leading-relaxed text-akn-muted">
              选中 PDF 原文或点击图谱节点，会自动作为 context 注入下一条提问。
            </p>
          </div>
        ) : (
          messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              question={findQuestion(messages, index)}
              onSendToNote={() => {
                const question = findQuestion(messages, index)
                queueChatCard({
                  id: newId(),
                  messageId: message.id,
                  question,
                  answer: message.content,
                  citations: message.citations.map((citation) => ({
                    page: citation.page,
                    quote: citation.quote,
                    verified: citation.verified,
                  })),
                  createdAt: Date.now(),
                })
              }}
            />
          ))
        )}
      </div>

      {error !== null ? (
        <p
          data-testid="chat-error"
          className="mx-3 mb-2 rounded border border-akn-danger/50 bg-akn-danger-soft px-2 py-1.5 text-[11px] text-akn-danger"
        >
          {error}
        </p>
      ) : null}

      <div className="border-t border-akn-border p-2">
        {chips.length > 0 ? (
          <div data-testid="context-chips" className="mb-2 flex flex-wrap gap-1">
            {chips.map((chip, index) => (
              <span
                key={`${chip.kind}-${index}`}
                data-testid="context-chip"
                className="flex max-w-full items-center gap-1 rounded-full border border-akn-accent/40 bg-akn-accent/10 px-2 py-0.5 text-[10px] text-akn-accent"
                title={chip.text}
              >
                <span className="max-w-[180px] truncate">
                  {chip.label}：{chip.text}
                </span>
                <button
                  type="button"
                  data-testid={`context-chip-remove-${index}`}
                  onClick={() => removeContextChip(index)}
                  className="text-akn-accent/70 hover:text-akn-ink"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <textarea
            data-testid="chat-input"
            value={input}
            rows={2}
            disabled={activeDocument === null}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
            }}
            placeholder={activeDocument === null ? '先打开 PDF…' : '基于当前 PDF 提问（⌘/Ctrl+Enter 发送）'}
            className="min-h-[40px] w-full resize-none rounded-lg border border-akn-border bg-akn-sunken px-2 py-1.5 text-xs text-akn-ink placeholder:text-akn-muted/60 disabled:opacity-50"
          />
          <button
            type="button"
            data-testid="chat-send"
            disabled={streaming || input.trim() === '' || activeDocument === null}
            onClick={submit}
            className="shrink-0 rounded-lg bg-akn-accent/25 px-3 py-2 text-xs font-medium text-akn-accent disabled:opacity-40"
          >
            {streaming ? '…' : '发送'}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-akn-muted/60">
          回答会带页码引注；原文核对不上时会明确标「无直接出处」。
        </p>
      </div>
    </section>
  )
}

function findQuestion(messages: readonly ChatMessage[], index: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor]
    if (candidate !== undefined && candidate.role === 'user') return candidate.content
  }
  return ''
}

interface MessageBubbleProps {
  readonly message: ChatMessage
  readonly question: string
  readonly onSendToNote: () => void
}

function MessageBubble({ message, onSendToNote }: MessageBubbleProps): ReactElement {
  const isUser = message.role === 'user'

  return (
    <div data-testid={`chat-message-${message.role}`} data-status={message.status}>
      <div
        className={[
          'rounded-lg px-2.5 py-2 text-xs whitespace-pre-wrap',
          isUser
            ? 'border border-akn-border bg-akn-raised text-akn-ink/90'
            : 'border border-akn-accent/20 bg-akn-accent/5 text-akn-ink/90',
        ].join(' ')}
      >
        {message.content === '' && message.status === 'streaming' ? '正在生成…' : message.content}
      </div>

      {message.citations.length > 0 ? (
        <ul data-testid="citation-list" className="mt-1 space-y-1">
          {message.citations.map((citation, index) => (
            <CitationItem key={`${message.id}-${index}`} citation={citation} />
          ))}
        </ul>
      ) : null}

      {message.role === 'assistant' && message.status === 'done' ? (
        <button
          type="button"
          data-testid="send-to-note"
          onClick={onSendToNote}
          className="mt-1 rounded border border-akn-border px-2 py-0.5 text-[10px] text-akn-muted hover:border-akn-accent/60 hover:text-akn-ink"
        >
          发送到总结笔记
        </button>
      ) : null}
    </div>
  )
}

function CitationItem({ citation }: { citation: Citation }): ReactElement {
  if (!citation.verified) {
    return (
      <li
        data-testid="citation-unverified"
        className="rounded border border-akn-warn/40 bg-akn-warn-soft px-2 py-1 text-[10px] text-akn-warn"
      >
        无直接出处（原文中未定位到引文）
        {citation.quote !== '' ? <span className="block text-akn-warn/70">模型声称：{citation.quote}</span> : null}
      </li>
    )
  }

  return (
    <li
      data-testid="citation-verified"
      className="rounded border border-akn-ok/40 bg-akn-ok-soft px-2 py-1 text-[10px] text-akn-ok"
    >
      第 {citation.page} 页：「{citation.quote}」
    </li>
  )
}
