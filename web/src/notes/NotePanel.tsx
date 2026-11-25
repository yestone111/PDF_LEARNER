import { useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { toPng } from 'html-to-image'

import { useDocumentStore } from '../stores/documentStore'
import { useGraphStore } from '../stores/graphStore'
import { useNotesStore } from '../stores/notesStore'
import { useUiStore } from '../stores/uiStore'
import { SYNC_PROVIDERS } from '../sync/providers'
import { serializeNoteDoc, type MarkdownResult } from './markdown'
import { ChatCard, GraphImage, HighlightQuote, NodeCard } from './tiptapNodes'
import { EMPTY_DOC, useNoteDoc } from './useNoteDoc'

import type { TiptapDoc } from '../domain'
import type { ReactElement } from 'react'

/**
 * 右侧「笔记」面板（模块五）：TipTap 混排 + Markdown 导出（P0）。
 * 自定义节点：图谱节点卡片 / 原文高亮 / AI 回答 / 图谱截图。
 */
export function NotePanel(): ReactElement {
  const noteDoc = useNotesStore((state) => state.noteDoc)
  const saveStatus = useNotesStore((state) => state.saveStatus)
  const queuedChatCards = useNotesStore((state) => state.queuedChatCards)
  const removeQueuedChatCard = useNotesStore((state) => state.removeQueuedChatCard)
  const exportPrefs = useUiStore((state) => state.exportPrefs)
  const { persist } = useNoteDoc()

  const [hint, setHint] = useState<string | null>(null)
  const [exportResult, setExportResult] = useState<MarkdownResult | null>(null)

  const extensions = useMemo(
    () => [StarterKit.configure({ heading: { levels: [1, 2, 3] } }), NodeCard, HighlightQuote, ChatCard, GraphImage],
    [],
  )

  const editor = useEditor({
    extensions,
    content: EMPTY_DOC as never,
    editorProps: {
      attributes: { class: 'akn-note-editor', 'data-testid': 'note-editor' },
    },
    onUpdate: ({ editor: instance }) => {
      persist(instance.getJSON() as TiptapDoc)
    },
  })

  // 文档切换后把持久化内容灌进编辑器（不触发 onUpdate，避免回环保存）
  useEffect(() => {
    if (editor === null || noteDoc === null) return
    const incoming = JSON.stringify(noteDoc.tiptapJson)
    if (JSON.stringify(editor.getJSON()) === incoming) return
    editor.commands.setContent(noteDoc.tiptapJson as never, { emitUpdate: false })
  }, [editor, noteDoc])

  const insertNodeCard = (): void => {
    const selectedId = useGraphStore.getState().selectedNodeId
    const node = selectedId === null ? undefined : useGraphStore.getState().nodesById[selectedId]
    if (node === undefined) {
      setHint('先在知识图谱里选中一个节点，再插入节点卡片')
      return
    }
    editor
      ?.chain()
      .focus('end')
      .insertContent({
        type: 'nodeCard',
        attrs: { nodeId: node.id, title: node.title, importance: node.importance, mastery: node.mastery },
      })
      .run()
    setHint(null)
  }

  const insertHighlight = (): void => {
    const highlights = useDocumentStore.getState().highlights
    const latest = highlights[highlights.length - 1]
    if (latest === undefined) {
      setHint('还没有任何 PDF 高亮，先在 PDF 里划选一段文字')
      return
    }
    editor
      ?.chain()
      .focus('end')
      .insertContent({
        type: 'highlightQuote',
        attrs: {
          quote: latest.content.text ?? '',
          page: latest.position.pageNumber,
          highlightId: latest.id,
        },
      })
      .run()
    setHint(null)
  }

  const insertChatCard = (): void => {
    const card = queuedChatCards[0]
    if (card === undefined) {
      setHint('还没有「发送到总结笔记」的 AI 回答')
      return
    }
    editor
      ?.chain()
      .focus('end')
      .insertContent({
        type: 'chatCard',
        attrs: { answer: card.answer, citations: card.citations },
      })
      .run()
    removeQueuedChatCard(card.id)
    setHint(null)
  }

  const insertGraphImage = async (): Promise<void> => {
    const target = document.querySelector('.react-flow__viewport') as HTMLElement | null
    const surface = (target?.parentElement ?? null) as HTMLElement | null
    if (surface === null) {
      setHint('先切到「知识图谱」并抽取图谱，再截图')
      return
    }
    try {
      const dataUrl = await toPng(surface, { backgroundColor: '#0b1020', pixelRatio: 1 })
      editor
        ?.chain()
        .focus('end')
        .insertContent({ type: 'graphImage', attrs: { src: dataUrl, alt: '知识图谱截图' } })
        .run()
      setHint(null)
    } catch (error) {
      setHint(`截图失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const runExport = (): void => {
    if (editor === null) return
    setExportResult(
      serializeNoteDoc(editor.getJSON() as TiptapDoc, { imageMode: exportPrefs.markdownImageMode }),
    )
  }

  const download = (): void => {
    if (exportResult === null) return
    const blob = new Blob([exportResult.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'ai-knowledge-navigator-note.md'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section
      id="tabpanel-notes"
      role="tabpanel"
      aria-labelledby="tab-notes"
      data-testid="pane-notes"
      className="flex h-full flex-col"
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-akn-border px-2 py-1.5">
        <ToolbarButton label="节点卡片" testId="insert-node-card" onClick={insertNodeCard} />
        <ToolbarButton label="原文高亮" testId="insert-highlight" onClick={insertHighlight} />
        <ToolbarButton
          label={`AI 回答${queuedChatCards.length > 0 ? `(${queuedChatCards.length})` : ''}`}
          testId="insert-chat-card"
          onClick={insertChatCard}
        />
        <ToolbarButton label="图谱截图" testId="insert-graph-image" onClick={() => void insertGraphImage()} />
        <ToolbarButton label="导出 .md" testId="export-markdown" onClick={runExport} accent />
      </div>

      {hint !== null ? (
        <p data-testid="notes-hint" className="mx-2 mt-1 rounded bg-akn-warn-soft px-2 py-1 text-[10px] text-akn-warn">
          {hint}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <EditorContent editor={editor} />
      </div>

      <footer className="flex items-center justify-between border-t border-akn-border px-2 py-1 text-[10px] text-akn-muted/70">
        <span data-testid="notes-save-status">
          {saveStatus === 'saving' ? '保存中…' : saveStatus === 'error' ? '保存失败' : '已保存到本机'}
        </span>
        <span title="P1 只交付接口与配置占位">同步：{SYNC_PROVIDERS.map((p) => p.target).join(' / ')}（P1）</span>
      </footer>

      {exportResult !== null ? (
        <div className="absolute inset-0 z-20 flex flex-col bg-akn-bg/95 p-3" data-testid="export-modal">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-akn-ink">Markdown 预览（真实导出内容）</p>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="export-download"
                onClick={download}
                className="rounded bg-akn-accent/25 px-2 py-1 text-[11px] text-akn-accent"
              >
                下载 .md
              </button>
              <button
                type="button"
                data-testid="export-close"
                onClick={() => setExportResult(null)}
                className="rounded border border-akn-border px-2 py-1 text-[11px] text-akn-muted"
              >
                关闭
              </button>
            </div>
          </div>
          <p className="mt-1 text-[10px] text-akn-muted">
            图片 {exportResult.imageCount} 张 · 降级 {exportResult.downgradedCount} 张 · 合计{' '}
            {Math.round(exportResult.totalImageBytes / 1024)} KB
          </p>
          <pre
            data-testid="markdown-preview"
            className="mt-2 min-h-0 flex-1 overflow-auto rounded border border-akn-border bg-akn-sunken p-2 text-[10px] leading-relaxed whitespace-pre-wrap text-akn-ink/90"
          >
            {exportResult.markdown}
          </pre>
        </div>
      ) : null}
    </section>
  )
}

interface ToolbarButtonProps {
  readonly label: string
  readonly testId: string
  readonly onClick: () => void
  readonly accent?: boolean
}

function ToolbarButton({ label, testId, onClick, accent = false }: ToolbarButtonProps): ReactElement {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={[
        'rounded px-1.5 py-1 text-[10px] transition-colors',
        accent
          ? 'bg-akn-accent/20 text-akn-accent hover:bg-akn-accent/30'
          : 'border border-akn-border text-akn-muted hover:border-akn-accent/50 hover:text-akn-ink',
      ].join(' ')}
    >
      {label}
    </button>
  )
}
