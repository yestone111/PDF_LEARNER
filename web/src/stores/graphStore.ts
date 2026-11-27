import { create } from 'zustand'

import { MASTERY_NEXT } from '../domain'
import type { KnowledgeEdge, KnowledgeNode, MasteryState } from '../domain'

export type ExtractionStatus = 'idle' | 'running' | 'ready' | 'error'

export interface ExtractionProgress {
  readonly status: ExtractionStatus
  readonly completedChunks: number
  readonly totalChunks: number
  readonly error: string | null
  /** 质量闸门：因「条件新颖性」被合并的单元数。 */
  readonly gateMerged: number
  /** 质量闸门：前缀/层级违规数（0 表示学习路径自洽）。 */
  readonly gateViolations: number
}

const INITIAL_PROGRESS: ExtractionProgress = {
  status: 'idle',
  completedChunks: 0,
  totalChunks: 0,
  gateMerged: 0,
  gateViolations: 0,
  error: null,
}

interface GraphState {
  nodesById: Readonly<Record<string, KnowledgeNode>>
  edgesById: Readonly<Record<string, KnowledgeEdge>>
  selectedNodeId: string | null
  /** 正在打开学习对话框的节点（图谱优先学习流的核心入口）。 */
  learningNodeId: string | null
  extraction: ExtractionProgress
  /** 本次抽取是否来自本地 mock 上游（UI 必须显式标注，绝不能冒充真实模型结果）。 */
  mock: boolean

  setGraph: (nodes: readonly KnowledgeNode[], edges: readonly KnowledgeEdge[]) => void
  setMock: (mock: boolean) => void
  upsertNodes: (nodes: readonly KnowledgeNode[]) => void
  upsertEdges: (edges: readonly KnowledgeEdge[]) => void
  setExtractionStatus: (progress: ExtractionProgress) => void
  selectNode: (nodeId: string | null) => void
  openLearning: (nodeId: string) => void
  closeLearning: () => void
  /** 掌握状态切换：只动 mastery，不动 importance（两个维度正交）。 */
  toggleMastery: (nodeId: string) => void
  clear: () => void
}

function flip(mastery: MasteryState): MasteryState {
  return MASTERY_NEXT[mastery]
}

/**
 * 图谱数据骨架。Step 3 接入抽取流水线后，这里会再加「按章节子图筛选」的选择器。
 * 本轮不造任何示例节点：空图就渲染空态。
 */
export const useGraphStore = create<GraphState>()((set) => ({
  nodesById: {},
  edgesById: {},
  selectedNodeId: null,
  learningNodeId: null,
  extraction: INITIAL_PROGRESS,
  mock: false,

  setGraph: (nodes, edges) => {
    const nodesById: Record<string, KnowledgeNode> = {}
    for (const node of nodes) nodesById[node.id] = node
    const edgesById: Record<string, KnowledgeEdge> = {}
    for (const edge of edges) edgesById[edge.id] = edge
    set({ nodesById, edgesById, selectedNodeId: null, learningNodeId: null })
  },

  setMock: (mock) => set({ mock }),

  upsertNodes: (nodes) =>
    set((state) => {
      if (nodes.length === 0) return state
      const next = { ...state.nodesById }
      for (const node of nodes) next[node.id] = node
      return { nodesById: next }
    }),

  upsertEdges: (edges) =>
    set((state) => {
      if (edges.length === 0) return state
      const next = { ...state.edgesById }
      for (const edge of edges) next[edge.id] = edge
      return { edgesById: next }
    }),

  setExtractionStatus: (extraction) => set({ extraction }),

  selectNode: (selectedNodeId) => set({ selectedNodeId }),

  openLearning: (learningNodeId) => set({ learningNodeId }),

  closeLearning: () => set({ learningNodeId: null }),

  toggleMastery: (nodeId) =>
    set((state) => {
      const node = state.nodesById[nodeId]
      if (node === undefined) return state
      return {
        nodesById: {
          ...state.nodesById,
          [nodeId]: { ...node, mastery: flip(node.mastery), updatedAt: Date.now() },
        },
      }
    }),

  clear: () =>
    set({
      nodesById: {},
      edgesById: {},
      selectedNodeId: null,
      learningNodeId: null,
      extraction: INITIAL_PROGRESS,
      mock: false,
    }),
}))
