/**
 * 「跳到原文」的兜底定位：用知识点标题/别名在 PDF 文本层里找。
 *
 * 场景（真实反馈）：抽取时模型给的 quote 在原文里定位不到（或干脆没给），
 * 节点就没有 anchor。以前这种节点点「跳到 PDF 原文」要么按钮禁用、要么直接返回，
 * 用户看到的是「点了没反应」。这里补一条确定性链路：
 *   标题 / 别名 → 全文文本索引 → 第一次命中的页码 + 原文片段 → 交给下划线闪烁。
 * 找不到就返回 null（调用方必须明确提示，不猜页码）。
 */

import { useDocumentStore } from '../stores/documentStore'
import { locateTextInIndex, type TextHit } from './textSearch'
import { getDocumentTextIndex } from './textIndexLoader'

import type { DocumentTextIndex } from './textIndex'
import type { KnowledgeNode, OutlineNode } from '../domain'

/**
 * 目录页：一页里出现 ≥3 个章节标题，就当作目录页。
 * 标题兜底定位要跳过它 —— 否则「界面导览」会命中目录页里的同名条目，跳到第 2 页而不是第 6 页。
 */
export function detectTocPages(index: DocumentTextIndex, outline: readonly OutlineNode[]): ReadonlySet<number> {
  const counts = new Map<number, number>()
  for (const node of outline) {
    const title = node.title.trim()
    if (title === '') continue
    const hit = locateTextInIndex(index, title)
    if (hit === null) continue
    counts.set(hit.page, (counts.get(hit.page) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, count]) => count >= 3).map(([page]) => page))
}

/** 用节点标题与别名在 PDF 里找位置（跳过目录页）；都找不到返回 null。 */
export async function findNodeTextInPdf(
  node: Pick<KnowledgeNode, 'title' | 'aliases'>,
): Promise<TextHit | null> {
  const state = useDocumentStore.getState()
  if (state.document === null || state.pdfDocument === null) return null
  const index = await getDocumentTextIndex(state.document.id, state.pdfDocument)
  const skipPages = detectTocPages(index, state.outline)
  const candidates = [node.title, ...node.aliases].map((item) => item.trim()).filter((item) => item !== '')
  for (const candidate of candidates) {
    const hit = locateTextInIndex(index, candidate, { skipPages })
    if (hit !== null) return hit
  }
  return null
}
