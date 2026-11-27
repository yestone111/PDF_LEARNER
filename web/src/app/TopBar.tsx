import type { ReactElement } from 'react'

import { OpenPdfButton } from '../pdf/OpenPdfButton'
import {
  PRIMARY_LANGUAGES,
  PRIMARY_LANGUAGE_LABELS,
  type PrimaryLanguage,
} from '../llm/prompts/language'
import { useUiStore, type Theme } from '../stores/uiStore'
import { useServerHealth } from './useServerHealth'

/**
 * 顶栏：产品标识 + 后端连通探针 + 布局复位。
 * 「后端代理正常」不只是装饰：它证明 前端 → Vite 代理 → Hono 的整条链路通。
 */
export function TopBar(): ReactElement {
  const health = useServerHealth()
  const leftWidth = useUiStore((state) => state.panelWidths.left)
  const rightWidth = useUiStore((state) => state.panelWidths.right)
  const resetPanelWidths = useUiStore((state) => state.resetPanelWidths)
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const primaryLanguage = useUiStore((state) => state.primaryLanguage)
  const rightCollapsed = useUiStore((state) => state.rightCollapsed)
  const toggleRightDock = useUiStore((state) => state.toggleRightDock)
  const setPrimaryLanguage = useUiStore((state) => state.setPrimaryLanguage)

  return (
    <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-akn-border bg-akn-panel/80 px-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-akn-accent/20 text-[11px] font-bold text-akn-accent">
          AK
        </span>
        <h1 className="truncate text-sm font-semibold text-akn-ink">AI Knowledge Navigator</h1>
        <span className="shrink-0 rounded-full border border-akn-border px-2 py-0.5 text-[10px] text-akn-muted">
          Step 2 · PDF
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {import.meta.env.DEV ? (
          <span
            data-testid="dev-widths"
            className="hidden font-mono text-[10px] text-akn-muted/70 sm:inline"
          >
            左 {leftWidth} · 右 {rightWidth}
          </span>
        ) : null}

        <LanguageSelect value={primaryLanguage} onSelect={setPrimaryLanguage} />
        <ThemeSwitch theme={theme} onSelect={setTheme} />
        <OpenPdfButton />

        <button
          type="button"
          onClick={toggleRightDock}
          data-testid="toggle-right-dock"
          aria-pressed={rightCollapsed}
          title={rightCollapsed ? '展开右侧栏（AI 伴读 / 笔记）' : '收起右侧栏（AI 伴读 / 笔记）'}
          className={[
            'rounded-md border px-2 py-1 text-[11px] transition-colors',
            rightCollapsed
              ? 'border-akn-accent/50 bg-akn-accent/10 text-akn-accent'
              : 'border-akn-border text-akn-muted hover:border-akn-accent/60 hover:text-akn-ink',
          ].join(' ')}
        >
          {rightCollapsed ? '» 显示伴读' : '« 隐藏伴读'}
        </button>

        <button
          type="button"
          onClick={resetPanelWidths}
          data-testid="reset-widths"
          className="rounded-md border border-akn-border px-2 py-1 text-[11px] text-akn-muted transition-colors hover:border-akn-accent/60 hover:text-akn-ink"
        >
          重置栏宽
        </button>

        <ServerHealthDot health={health} />
      </div>
    </header>
  )
}

function LanguageSelect({
  value,
  onSelect,
}: {
  value: PrimaryLanguage
  onSelect: (language: PrimaryLanguage) => void
}): ReactElement {
  return (
    <label
      className="flex items-center gap-1 text-[10px] text-akn-muted"
      title="知识图谱、摘要与 AI 对话的输出语言（原文引文始终保留原语言）"
    >
      <span className="hidden sm:inline">语言</span>
      <select
        data-testid="language-select"
        value={value}
        onChange={(event) => onSelect(event.target.value as PrimaryLanguage)}
        className="rounded border border-akn-border bg-akn-panel px-1.5 py-0.5 text-[10px] text-akn-ink outline-none"
      >
        {PRIMARY_LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {PRIMARY_LANGUAGE_LABELS[language]}
          </option>
        ))}
      </select>
    </label>
  )
}

const THEME_OPTIONS: ReadonlyArray<{ id: Theme; label: string; icon: string }> = [
  { id: 'parchment', label: '羊皮卷', icon: '📜' },
  { id: 'night', label: '夜读', icon: '🌙' },
]

function ThemeSwitch({
  theme,
  onSelect,
}: {
  theme: Theme
  onSelect: (theme: Theme) => void
}): ReactElement {
  return (
    <div
      role="group"
      aria-label="主题"
      data-testid="theme-switch"
      className="flex items-center gap-0.5 rounded-full border border-akn-border p-0.5"
    >
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`theme-${option.id}`}
          aria-pressed={theme === option.id}
          title={`主题：${option.label}`}
          onClick={() => onSelect(option.id)}
          className={[
            'rounded-full px-2 py-0.5 text-[10px] transition-colors',
            theme === option.id
              ? 'bg-akn-accent/20 text-akn-accent'
              : 'text-akn-muted hover:bg-akn-raised hover:text-akn-ink',
          ].join(' ')}
        >
          <span aria-hidden="true">{option.icon}</span> {option.label}
        </button>
      ))}
    </div>
  )
}

function ServerHealthDot({ health }: { health: ReturnType<typeof useServerHealth> }): ReactElement {
  const tone =
    health.status === 'ready'
      ? { dot: 'bg-akn-ok', text: 'text-akn-ok', label: '代理正常' }
      : health.status === 'loading'
        ? { dot: 'bg-akn-muted/60', text: 'text-akn-muted', label: '检查中' }
        : { dot: 'bg-akn-danger', text: 'text-akn-danger', label: '代理异常' }

  const title =
    health.status === 'error'
      ? health.message
      : health.status === 'ready'
        ? `${health.data.service} v${health.data.version} · llmConfigured=${String(health.data.llmConfigured)}`
        : '正在检查 /api/health'

  return (
    <span
      data-testid="server-health"
      data-status={health.status}
      title={title}
      className={`flex items-center gap-1.5 text-[11px] ${tone.text}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {tone.label}
    </span>
  )
}
