/** 图谱动作：掌握状态切换（落库）+ 节点 → PDF 跳转。 */

import { setNodeMastery } from '../db/repositories/graph'
import { useDocumentStore } from '../stores/documentStore'
import { useGraphStore } from '../stores/graphStore'
import { useUiStore } from '../stores/uiStore'
import { requestPageNavigation } from '../pdf/pdfController'
import { jumpTargetOf } from './jumpTarget'

export async function toggleNodeMastery(nodeId: string): Promise<void> {
  const node = useGraphStore.getState().nodesById[nodeId]
  if (node === undefined) return
  const next = node.mastery === 'mastered' ? 'unmastered' : 'mastered'
  await setNodeMastery(nodeId, next)
  useGraphStore.getState().toggleMastery(nodeId)
}

/**
 * 点节点 → 切到 PDF 页并跳到锚点页。
 *
 * 图表/表格占位节点没有可逐字定位的 quote，退化为「图表页码 + caption」：
 * 能定位就画下划线，定位不到至少落到那一页并闪一下（明确提示，不假装命中）。
 * 两者都没有才明确提示「无页码」，不猜页码。
 */
export function jumpNodeToPdf(nodeId: string): void {
  const node = useGraphStore.getState().nodesById[nodeId]
  if (node === undefined) return
  const target = jumpTargetOf(node)
  if (target === null) {
    useDocumentStore
      .getState()
      .setStatus('ready', '该节点没有页码锚点（既没有原文引文，也不是图表节点），无法跳转')
    return
  }
  useUiStore.getState().setCenterTab('pdf')
  requestPageNavigation(target.page)
  if (target.quote.trim() !== '') {
    useDocumentStore.getState().requestFlashQuote(target.page, target.quote)
  }
}
