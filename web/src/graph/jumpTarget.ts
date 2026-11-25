/**
 * 「跳到原文」的目标解析。
 *
 * 普通知识点有 anchor（页码 + 逐字引文）；图表/表格占位节点（`figure`）常常只有
 * caption 与页码、没有可逐字定位的 quote —— 以前这种节点直接判为「没有锚点」，
 * 于是点了没反应。这里统一解析目标：
 *   1) 有 anchor 就用 anchor（页码 + 引文，能画下划线）；
 *   2) 没有 anchor 但有 figure：退到图表的页码，引文用 caption（能定位就画下划线，
 *      定位不到至少落到那一页并闪一下，明确提示「已标出该页」）；
 *   3) 两者都没有 → null（不猜页码）。
 *
 * 纯函数，可单测。
 */

import type { KnowledgeNode } from '../domain'

export interface JumpTarget {
  readonly page: number
  readonly quote: string
}

export function jumpTargetOf(node: Pick<KnowledgeNode, 'anchor' | 'figure'>): JumpTarget | null {
  if (node.anchor !== null) {
    return { page: node.anchor.page, quote: node.anchor.quote }
  }
  if (node.figure !== null) {
    const caption = node.figure.caption.trim() !== '' ? node.figure.caption : node.figure.label
    return { page: node.figure.page, quote: caption.trim() }
  }
  return null
}
