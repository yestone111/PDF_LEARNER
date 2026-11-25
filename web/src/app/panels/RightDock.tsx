import type { ReactElement } from 'react'

import { ChatPanel } from '../../chat/ChatPanel'
import { NotePanel } from '../../notes/NotePanel'
import { useUiStore, type RightTab } from '../../stores/uiStore'

/**
 * 右栏：AI 伴读 / 笔记 双 Tab（第一轮 Q1 的决策）。
 *
 * 形态说明：Tab 而不是抽屉 —— 两处需求都写死「右侧固定聊天侧边栏 + 与笔记面板 Tab 切换」，
 * 抽屉会额外挤压中栏，也会和「点节点 → PDF 跳转并高亮」抢宽度。
 */
export function RightDock(): ReactElement {
  const rightTab = useUiStore((state) => state.rightTab)
  const setRightTab = useUiStore((state) => state.setRightTab)

  return (
    <aside
      data-testid="panel-right"
      className="flex min-w-0 flex-col border-l border-akn-border bg-akn-panel"
    >
      <div role="tablist" aria-label="右侧面板" className="flex border-b border-akn-border">
        <TabButton id="chat" label="AI 伴读" active={rightTab === 'chat'} onSelect={setRightTab} />
        <TabButton id="notes" label="笔记" active={rightTab === 'notes'} onSelect={setRightTab} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="right-dock-body">
        {rightTab === 'chat' ? <ChatPanel /> : <NotePanel />}
      </div>
    </aside>
  )
}

interface TabButtonProps {
  id: RightTab
  label: string
  active: boolean
  onSelect: (tab: RightTab) => void
}

function TabButton({ id, label, active, onSelect }: TabButtonProps): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      data-testid={`tab-${id}`}
      aria-selected={active}
      aria-controls={`tabpanel-${id}`}
      onClick={() => onSelect(id)}
      className={[
        'relative flex-1 px-3 py-2 text-xs font-medium transition-colors',
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
