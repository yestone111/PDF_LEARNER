import { useState } from 'react'

import type { ReactElement } from 'react'

const EMOJIS = ['💡', '❓', '⚠️', '📌'] as const

interface HighlightTipProps {
  readonly onConfirm: (comment: { text: string; emoji: string }) => void
  readonly onCancel: () => void
  readonly busy?: boolean
}

/**
 * 划选文本后弹出的确认气泡（PdfHighlighter 的 onSelectionFinished 返回值）。
 * 备注允许留空 —— 任务书要求的是「高亮与备注」，备注不是强制项。
 */
export function HighlightTip({ onConfirm, onCancel, busy = false }: HighlightTipProps): ReactElement {
  const [text, setText] = useState('')
  const [emoji, setEmoji] = useState<string>(EMOJIS[0])

  return (
    <div
      data-testid="highlight-tip"
      className="w-64 rounded-lg border border-akn-border bg-akn-panel p-2 shadow-2xl"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        {EMOJIS.map((item) => (
          <button
            key={item}
            type="button"
            data-testid={`highlight-emoji-${item}`}
            onClick={() => setEmoji(item)}
            className={[
              'grid h-6 w-6 place-items-center rounded text-xs transition-colors',
              emoji === item ? 'bg-akn-accent/25' : 'hover:bg-akn-raised',
            ].join(' ')}
          >
            {item}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-akn-muted/70">添加高亮</span>
      </div>

      <textarea
        data-testid="highlight-comment-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        placeholder="备注（可留空）"
        className="mt-1.5 w-full resize-none rounded border border-akn-border bg-akn-sunken px-2 py-1 text-xs text-akn-ink placeholder:text-akn-muted/50"
      />

      <div className="mt-1.5 flex justify-end gap-1.5">
        <button
          type="button"
          data-testid="highlight-cancel"
          onClick={onCancel}
          disabled={busy}
          className="rounded px-2 py-1 text-[11px] text-akn-muted hover:bg-akn-raised"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="highlight-confirm"
          onClick={() => onConfirm({ text: text.trim(), emoji })}
          disabled={busy}
          className="rounded bg-akn-accent/25 px-2 py-1 text-[11px] font-medium text-akn-accent hover:bg-akn-accent/35 disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
