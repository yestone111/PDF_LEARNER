import { useState } from 'react'

import type { ReactElement } from 'react'

export interface LinkedNodeRef {
  readonly id: string
  readonly title: string
}

interface HighlightCommentEditorProps {
  readonly highlightId: string
  readonly initialComment: { readonly text: string; readonly emoji: string }
  readonly linkedNode: LinkedNodeRef | null
  readonly onLocateNode: () => void
  readonly onSave: (comment: { text: string; emoji: string }) => void
  readonly onDelete: () => void
  readonly onClose: () => void
}

/** 点击已有高亮时弹出的备注编辑气泡。 */
export function HighlightCommentEditor({
  highlightId,
  initialComment,
  linkedNode,
  onLocateNode,
  onSave,
  onDelete,
  onClose,
}: HighlightCommentEditorProps): ReactElement {
  const [text, setText] = useState(initialComment.text)
  const [emoji, setEmoji] = useState(initialComment.emoji)

  return (
    <div
      data-testid="highlight-comment-editor"
      data-highlight-id={highlightId}
      className="w-64 rounded-lg border border-akn-border bg-akn-panel p-2 shadow-2xl"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        {['💡', '❓', '⚠️', '📌'].map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setEmoji(item)}
            className={[
              'grid h-6 w-6 place-items-center rounded text-xs transition-colors',
              emoji === item ? 'bg-akn-accent/25' : 'hover:bg-akn-raised',
            ].join(' ')}
          >
            {item}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-akn-muted/70">编辑备注</span>
      </div>

      <textarea
        data-testid="comment-editor-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        placeholder="写点备注…"
        className="mt-1.5 w-full resize-none rounded border border-akn-border bg-akn-sunken px-2 py-1 text-xs text-akn-ink placeholder:text-akn-muted/50"
      />

      <div className="mt-2 rounded border border-akn-border/70 bg-akn-sunken px-2 py-1.5">
        <p className="text-[10px] font-semibold tracking-wider text-akn-muted uppercase">关联图谱节点</p>
        {linkedNode === null ? (
          <p data-testid="highlight-node-empty" className="mt-1 text-[11px] text-akn-muted/70">
            未关联任何知识节点（也没有能按原文匹配到的节点）
          </p>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-akn-ink/90">{linkedNode.title}</span>
            <button
              type="button"
              data-testid="highlight-locate-node"
              onClick={onLocateNode}
              className="shrink-0 rounded border border-akn-accent/50 px-1.5 py-0.5 text-[10px] text-akn-accent"
            >
              定位
            </button>
          </div>
        )}
      </div>

      <div className="mt-1.5 flex items-center justify-between">
        <button
          type="button"
          data-testid="comment-delete"
          onClick={onDelete}
          className="rounded px-2 py-1 text-[11px] text-akn-danger hover:bg-akn-danger-soft"
        >
          删除
        </button>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[11px] text-akn-muted hover:bg-akn-raised"
          >
            关闭
          </button>
          <button
            type="button"
            data-testid="comment-save"
            onClick={() => onSave({ text: text.trim(), emoji })}
            className="rounded bg-akn-accent/25 px-2 py-1 text-[11px] font-medium text-akn-accent hover:bg-akn-accent/35"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
