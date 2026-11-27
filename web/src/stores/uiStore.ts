import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import {
  DEFAULT_PRIMARY_LANGUAGE,
  normalizePrimaryLanguage,
  type PrimaryLanguage,
} from '../llm/prompts/language'
import {
  DEFAULT_PANEL_WIDTHS,
  clampLeftWidth,
  clampRightWidth,
  normalizePanelWidths,
  type PanelSide,
  type PanelWidths,
} from '../app/layout/layoutMath'

export type RightTab = 'chat' | 'notes'

/** 中栏视图：PDF 阅读 / 知识图谱。 */
export type CenterTab = 'pdf' | 'graph'

/** 主题：羊皮卷（默认，阅读友好）/ 夜读。 */
export type Theme = 'parchment' | 'night'

export const DEFAULT_THEME: Theme = 'parchment'

/** 持久化数据不可信：只接受白名单，其余回落默认（羊皮卷）。 */
export function normalizeTheme(value: unknown): Theme {
  return value === 'night' ? 'night' : DEFAULT_THEME
}

/** Markdown 图片降级策略（第一轮 Q2 的默认选择，用户可覆盖）。 */
export type MarkdownImageMode = 'inline-base64' | 'placeholder'

export interface ExportPrefs {
  readonly markdownImageMode: MarkdownImageMode
}

interface UiState {
  rightTab: RightTab
  centerTab: CenterTab
  theme: Theme
  /** 主要语言：知识图谱/摘要/AI 对话的输出语言（引文仍保持原文）。 */
  primaryLanguage: PrimaryLanguage
  panelWidths: PanelWidths
  /** 右栏（AI 伴读 / 笔记）是否收起：不用时把中栏让出来。 */
  rightCollapsed: boolean
  exportPrefs: ExportPrefs
  /** 最近打开的文档 id：刷新页面后用它恢复现场（文档本体在 IndexedDB）。 */
  lastDocumentId: string | null
  setRightTab: (tab: RightTab) => void
  setCenterTab: (tab: CenterTab) => void
  setTheme: (theme: Theme) => void
  setPrimaryLanguage: (language: PrimaryLanguage) => void
  setLastDocumentId: (documentId: string | null) => void
  /** 写入前由调用方负责 clamp（拖拽 hook 已做）；这里只负责存储。 */
  setPanelWidth: (side: PanelSide, width: number) => void
  /** 窗口尺寸变化时把两侧宽度压回可用范围。 */
  clampPanelWidthsToContainer: (containerWidth: number) => void
  resetPanelWidths: () => void
  setRightCollapsed: (collapsed: boolean) => void
  toggleRightDock: () => void
  setMarkdownImageMode: (mode: MarkdownImageMode) => void
}

type PersistedUi = Pick<
  UiState,
  | 'rightTab'
  | 'centerTab'
  | 'theme'
  | 'primaryLanguage'
  | 'panelWidths'
  | 'rightCollapsed'
  | 'exportPrefs'
  | 'lastDocumentId'
>

const INITIAL_EXPORT_PREFS: ExportPrefs = { markdownImageMode: 'inline-base64' }

/**
 * 纯 UI 状态（与领域数据无关），持久化到 localStorage。
 * 业务状态一律不放这里 —— 文档/图谱/对话/笔记各有独立 store。
 */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      rightTab: 'chat',
      // 图谱优先：打开就是知识图谱，PDF 保留为第二个 Tab
      centerTab: 'graph',
      theme: DEFAULT_THEME,
      primaryLanguage: DEFAULT_PRIMARY_LANGUAGE,
      panelWidths: DEFAULT_PANEL_WIDTHS,
      rightCollapsed: false,
      exportPrefs: INITIAL_EXPORT_PREFS,
      lastDocumentId: null,

      setRightTab: (rightTab) => set({ rightTab }),
      setCenterTab: (centerTab) => set({ centerTab }),
      setTheme: (theme) => set({ theme }),
      setPrimaryLanguage: (primaryLanguage) => set({ primaryLanguage }),
      setLastDocumentId: (lastDocumentId) => set({ lastDocumentId }),

      setPanelWidth: (side, width) =>
        set((state) => ({
          panelWidths:
            side === 'left'
              ? { ...state.panelWidths, left: width }
              : { ...state.panelWidths, right: width },
        })),

      clampPanelWidthsToContainer: (containerWidth) =>
        set((state) => {
          // 右栏收起时视为 0 宽：中栏应该能占满，左栏也不该被一个看不见的右栏挤住
          const effectiveRight = state.rightCollapsed ? 0 : state.panelWidths.right
          const left = clampLeftWidth(state.panelWidths.left, containerWidth, effectiveRight)
          const right = state.rightCollapsed
            ? state.panelWidths.right
            : clampRightWidth(state.panelWidths.right, containerWidth, left)
          if (left === state.panelWidths.left && right === state.panelWidths.right) return state
          return { panelWidths: { left, right } }
        }),

      resetPanelWidths: () => set({ panelWidths: DEFAULT_PANEL_WIDTHS }),

      setRightCollapsed: (rightCollapsed) => set({ rightCollapsed }),

      toggleRightDock: () => set((state) => ({ rightCollapsed: !state.rightCollapsed })),

      setMarkdownImageMode: (markdownImageMode) =>
        set((state) => ({ exportPrefs: { ...state.exportPrefs, markdownImageMode } })),
    }),
    {
      name: 'akn.ui',
      version: 1,
      partialize: (state): PersistedUi => ({
        rightTab: state.rightTab,
        centerTab: state.centerTab,
        theme: state.theme,
        primaryLanguage: state.primaryLanguage,
        panelWidths: state.panelWidths,
        rightCollapsed: state.rightCollapsed,
        exportPrefs: state.exportPrefs,
        lastDocumentId: state.lastDocumentId,
      }),
      /**
       * 持久化数据视为不可信输入：旧版本、手改的 localStorage、半截 JSON 都可能出现。
       * 不合法就回落默认值，绝不让脏宽度把布局撑坏。
       */
      merge: (persisted, current) => {
        const raw = persisted as Partial<PersistedUi> | undefined
        return {
          ...current,
          rightTab: raw?.rightTab === 'notes' ? 'notes' : 'chat',
          centerTab: raw?.centerTab === 'pdf' ? 'pdf' : 'graph',
          theme: normalizeTheme(raw?.theme),
          primaryLanguage: normalizePrimaryLanguage(raw?.primaryLanguage),
          panelWidths: normalizePanelWidths(raw?.panelWidths),
          rightCollapsed: raw?.rightCollapsed === true,
          exportPrefs: {
            markdownImageMode:
              raw?.exportPrefs?.markdownImageMode === 'placeholder' ? 'placeholder' : 'inline-base64',
          },
          lastDocumentId: typeof raw?.lastDocumentId === 'string' ? raw.lastDocumentId : null,
        }
      },
    },
  ),
)
