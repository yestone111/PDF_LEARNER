/**
 * 章节速览：把一章的知识点压成 3–6 句（主要语言），可展开/收起。
 *
 * - 只读已有的章节节点（标题 + 摘要），不重新跑抽取；
 * - 结果缓存在 localStorage（按文档 + 章节 + prompt 版本），刷新后仍可秒开；
 * - 纯文本展示，不做结构化写入 —— 写库的东西必须过 zod，这里不落库。
 */

import { requestExtraction } from '../client'
import { CHAPTER_SUMMARY_VERSION, chapterSummaryPrompt } from '../prompts/chapterSummary'
import { useDocumentStore } from '../../stores/documentStore'
import { useGraphStore } from '../../stores/graphStore'
import { useUiStore } from '../../stores/uiStore'

const CACHE_PREFIX = 'akn.chapterSummary'
const MAX_NODES = 40

/** 超长时按句子边界收尾，避免硬切在半句。 */
export function trimToSentence(text: string, limit = 1600): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const head = trimmed.slice(0, limit)
  const lastStop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'))
  return (lastStop > limit * 0.5 ? head.slice(0, lastStop + 1) : head).trim()
}

function cacheKey(documentId: string, chapterId: string): string {
  return `${CACHE_PREFIX}.${documentId}.${chapterId}.${CHAPTER_SUMMARY_VERSION}`
}

export function readCachedChapterSummary(documentId: string, chapterId: string): string | null {
  try {
    return window.localStorage.getItem(cacheKey(documentId, chapterId))
  } catch {
    return null
  }
}

export interface ChapterSummaryResult {
  readonly summary: string
  readonly mock: boolean
  readonly cached: boolean
}

export async function summarizeChapter(chapterId: string): Promise<ChapterSummaryResult> {
  const document = useDocumentStore.getState().document
  if (document === null) throw new Error('请先打开 PDF')
  const chapter = useDocumentStore.getState().outline.find((node) => node.id === chapterId)
  if (chapter === undefined) throw new Error('章节不存在')

  const cached = readCachedChapterSummary(document.id, chapterId)
  if (cached !== null && cached.trim() !== '') {
    return { summary: cached, mock: false, cached: true }
  }

  const nodes = Object.values(useGraphStore.getState().nodesById)
    .filter((node) => node.scope === 'chapter' && node.chapterId === chapterId)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, MAX_NODES)
    .map((node) => ({ title: node.title, summary: node.summary }))

  if (nodes.length === 0) {
    throw new Error('这一章还没有拆解结果，先点「🚀 AI 开启拆解」')
  }

  const prompt = chapterSummaryPrompt.build({
    chapterTitle: chapter.title,
    nodes,
    language: useUiStore.getState().primaryLanguage,
  })

  // 模型偶发只回推理 chunk、不给正文（实测 1/4 概率空输出）：重试一次再放弃
  let summary = ''
  let mock = false
  let lastError = '模型没有返回内容'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await requestExtraction({
        messages: prompt.messages,
        promptVersion: CHAPTER_SUMMARY_VERSION,
        stage: 'chapter_summary',
        maxTokens: prompt.maxTokens,
      })
      mock = response.mock
      summary = trimToSentence(response.content)
      if (summary !== '') break
      lastError = '模型没有返回内容'
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : '请求失败'
    }
    if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 600))
  }

  if (summary === '') throw new Error(lastError)
  try {
    window.localStorage.setItem(cacheKey(document.id, chapterId), summary)
  } catch {
    // 缓存失败不影响展示
  }
  return { summary, mock, cached: false }
}
