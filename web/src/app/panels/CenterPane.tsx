import { GraphView } from '../../graph/GraphView'
import { useUiStore, type CenterTab } from '../../stores/uiStore'
import { PdfPane } from './PdfPane'

import type { ReactElement } from 'react'

/**
 * 中栏容器：PDF 阅读 / 知识图谱两个视图。
 * 用 Tab 而不是并排，是因为三栏已经吃满横向空间；图谱另有独立缩放/拖拽交互。
 */
export function CenterPane(): ReactElement {
  const centerTab = useUiStore((state) => state.centerTab)
  const setCenterTab = useUiStore((state) => state.setCenterTab)

  return (
    <main data-testid="panel-center" className="flex min-w-0 flex-col bg-akn-bg">
      <div role="tablist" aria-label="中栏视图" className="flex border-b border-akn-border bg-akn-panel/40">
        <CenterTabButton id="pdf" label="PDF 阅读" active={centerTab === 'pdf'} onSelect={setCenterTab} />
        <CenterTabButton id="graph" label="知识图谱" active={centerTab === 'graph'} onSelect={setCenterTab} />
      </div>
      {/*
        两个视图都挂载，图谱以覆盖层出现：
        PdfHighlighter 每次卸载都会重建 PDFViewer（重新解析 + 丢滚动位置），
        而「点节点 → PDF 跳转」要求 PDF 侧随时可定位，所以 PDF 必须常驻。
      */}
      <div className="relative min-h-0 flex-1">
        <PdfPane />
        {centerTab === 'graph' ? (
          <div className="absolute inset-0 z-10 bg-akn-bg">
            <GraphView />
          </div>
        ) : null}
      </div>
    </main>
  )
}

interface CenterTabButtonProps {
  readonly id: CenterTab
  readonly label: string
  readonly active: boolean
  readonly onSelect: (tab: CenterTab) => void
}

function CenterTabButton({ id, label, active, onSelect }: CenterTabButtonProps): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      id={`center-tab-${id}`}
      data-testid={`center-tab-${id}`}
      aria-selected={active}
      onClick={() => onSelect(id)}
      className={[
        'relative px-3 py-1.5 text-[11px] font-medium transition-colors',
        active ? 'text-akn-ink' : 'text-akn-muted hover:text-akn-ink/80',
      ].join(' ')}
    >
      {label}
      <span
        aria-hidden="true"
        className={[
          'absolute inset-x-2 bottom-0 h-[2px] rounded-full transition-colors',
          active ? 'bg-akn-accent' : 'bg-transparent',
        ].join(' ')}
      />
    </button>
  )
}
