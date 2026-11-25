import { useRef, useState } from 'react'

import { openPdfFile } from '../pdf/pdfController'

import type { ReactElement } from 'react'

interface OpenPdfButtonProps {
  readonly label?: string
}

/**
 * 「打开 PDF」按钮 + 隐藏 file input。
 * 用真实 `<input type="file">` 而不是自定义拖拽库：CDP 可以用 DOM.setFileInputFiles
 * 直接注入文件，天然可自动化验收。
 */
export function OpenPdfButton({ label = '打开 PDF' }: OpenPdfButtonProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        data-testid="pdf-input"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // 允许连续选择同一个文件
          event.target.value = ''
          if (file === undefined) return
          setBusy(true)
          void openPdfFile(file).finally(() => setBusy(false))
        }}
      />
      <button
        type="button"
        data-testid="open-pdf"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="rounded-md border border-akn-border px-2 py-1 text-[11px] text-akn-muted transition-colors hover:border-akn-accent/60 hover:text-akn-ink disabled:opacity-50"
      >
        {busy ? '解析中…' : label}
      </button>
    </>
  )
}
