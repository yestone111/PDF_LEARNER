/** 图谱动作：掌握状态切换（落库）+ 节点 → PDF 跳转。 */

import { setNodeMastery } from '../db/repositories/graph'
import { useDocumentStore } from '../stores/documentStore'
import { useGraphStore } from '../stores/graphStore'
import { useUiStore } from '../stores/uiStore'
import { requestPageNavigation } from '../pdf/pdfController'
import { findNodeTextInPdf } from '../pdf/jumpSearch'
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
export async function jumpNodeToPdf(nodeId: string): Promise<void> {
  const node = useGraphStore.getState().nodesById[nodeId]
  if (node === undefined) return

  // 目标解析三级：锚点 → 图表页码 → 用标题/别名在原文里搜
  let target = jumpTargetOf(node)
  if (target === null) {
    try {
      target = await findNodeTextInPdf(node)
    } catch {
      target = null
    }
  }

  // 找不到也要切到 PDF：提示条在 PDF 头部，用户得看得见
  useUiStore.getState().setCenterTab('pdf')
  if (target === null) {
    useDocumentStore
      .getState()
      .setFlashHint(`没能在 PDF 里找到「${node.title}」的原文，无法定位到具体页`)
    return
  }
  requestPageNavigation(target.page)
  if (target.quote.trim() !== '') {
    useDocumentStore.getState().requestFlashQuote(target.page, target.quote)
  }
}
