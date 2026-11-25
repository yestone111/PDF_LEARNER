/**
 * 抽取流程的控制器：pdf.js 取文本 → 跑流水线 → 校验后的图写库 → 灌进 store。
 * UI 只调用这里的函数，不直接触碰 pdfjs / Dexie / fetch。
 */

import { listDocumentGraph, replaceChapterGraph, replaceDocumentGraph } from '../../db/repositories/graph'
import { useDocumentStore } from '../../stores/documentStore'
import { useGraphStore } from '../../stores/graphStore'
import { useUiStore } from '../../stores/uiStore'
import { runChapterExtraction, runDocumentExtraction, type ExtractionOutcome } from './extraction'

import type { PageText } from './chunking'

/** 抽取全部页面文本（pdf.js 文本层）。15 页论文量级足够快；大文档后续可做增量。 */
export async function readAllPagesText(): Promise<PageText[]> {
  const pdfDocument = useDocumentStore.getState().pdfDocument
  if (pdfDocument === null) throw new Error('没有打开的 PDF')

  const pages: PageText[] = []
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    pages.push({ page: pageNumber, text })
  }
  return pages
}

export async function loadGraphIntoStore(): Promise<void> {
  const activeDocument = useDocumentStore.getState().document
  if (activeDocument === null) {
    useGraphStore.getState().clear()
    return
  }
  const { nodes, edges } = await listDocumentGraph(activeDocument.id)
  useGraphStore.getState().setGraph(nodes, edges)
}

/** 跑一次完整抽取（map-reduce）。失败块只记录、不填充假数据。 */
export async function extractWholeDocument(): Promise<ExtractionOutcome> {
  const state = useDocumentStore.getState()
  if (state.document === null || state.pdfDocument === null) throw new Error('请先打开 PDF')

  useGraphStore.getState().setExtractionStatus({
    status: 'running',
    completedChunks: 0,
    totalChunks: 0,
    error: null,
    gateMerged: 0,
    gateViolations: 0,
  })

  try {
    const pages = await readAllPagesText()
    const outcome = await runDocumentExtraction({
      documentId: state.document.id,
      pages,
      outline: state.outline,
      language: useUiStore.getState().primaryLanguage,
      onProgress: (progress) => {
        useGraphStore.getState().setExtractionStatus({
          status: 'running',
          completedChunks: progress.completed,
          totalChunks: progress.total,
          error: null,
          gateMerged: 0,
          gateViolations: 0,
        })
      },
    })

    if (outcome.nodes.length > 0) {
      await replaceDocumentGraph(state.document.id, outcome.nodes, outcome.edges)
      await loadGraphIntoStore()
    }

    useGraphStore.getState().setMock(outcome.mock)
    useGraphStore.getState().setExtractionStatus({
      status: outcome.failedChunks.length === 0 ? 'ready' : 'error',
      completedChunks: outcome.chunkCount,
      totalChunks: outcome.chunkCount,
      gateMerged: outcome.gate?.merged ?? 0,
      gateViolations: (outcome.gate?.prefixViolations ?? 0) + (outcome.gate?.levelViolations ?? 0) + (outcome.gate?.cycles ?? 0),
      error:
        outcome.failedChunks.length === 0
          ? null
          : `${outcome.failedChunks.length} 个块抽取失败：${outcome.failedChunks[0]?.error ?? ''}`,
    })

    return outcome
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    useGraphStore.getState().setExtractionStatus({
      status: 'error',
      completedChunks: 0,
      totalChunks: 0,
      error: message,
      gateMerged: 0,
      gateViolations: 0,
    })
    throw error
  }
}

/** 章节子图（模块二）。只跑该章节的块，缓存与全局抽取共用。 */
export async function extractChapterGraph(chapterId: string): Promise<ExtractionOutcome> {
  const state = useDocumentStore.getState()
  if (state.document === null) throw new Error('请先打开 PDF')
  const chapter = state.outline.find((node) => node.id === chapterId)
  if (chapter === undefined) throw new Error('章节不存在')

  useGraphStore.getState().setExtractionStatus({
    status: 'running',
    completedChunks: 0,
    totalChunks: 0,
    error: null,
    gateMerged: 0,
    gateViolations: 0,
  })

  try {
    const pages = await readAllPagesText()
    const nextStart = state.outline
      .filter((node) => node.page !== null && node.page > (chapter.page ?? 0) && node.level === 1)
      .map((node) => node.page ?? 0)
      .sort((a, b) => a - b)[0]
    const pageFrom = chapter.page ?? 1
    const pageTo = nextStart === undefined ? (state.document.pageCount ?? pageFrom) : nextStart - 1

    const outcome = await runChapterExtraction({
      documentId: state.document.id,
      pages,
      outline: state.outline,
      chapterId,
      chapterTitle: chapter.title,
      chapterPageFrom: pageFrom,
      chapterPageTo: pageTo,
      language: useUiStore.getState().primaryLanguage,
      onProgress: (progress) => {
        useGraphStore.getState().setExtractionStatus({
          status: 'running',
          completedChunks: progress.completed,
          totalChunks: progress.total,
          error: null,
          gateMerged: 0,
          gateViolations: 0,
        })
      },
    })

    if (outcome.nodes.length > 0) {
      await replaceChapterGraph(state.document.id, chapterId, outcome.nodes, outcome.edges)
      await loadGraphIntoStore()
    }

    useGraphStore.getState().setMock(outcome.mock)
    useGraphStore.getState().setExtractionStatus({
      status: outcome.failedChunks.length === 0 ? 'ready' : 'error',
      completedChunks: outcome.chunkCount,
      totalChunks: outcome.chunkCount,
      gateMerged: outcome.gate?.merged ?? 0,
      gateViolations: (outcome.gate?.prefixViolations ?? 0) + (outcome.gate?.levelViolations ?? 0) + (outcome.gate?.cycles ?? 0),
      error:
        outcome.failedChunks.length === 0
          ? null
          : `${outcome.failedChunks.length} 个块失败：${outcome.failedChunks[0]?.error ?? ''}`,
    })

    return outcome
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    useGraphStore.getState().setExtractionStatus({
      status: 'error',
      completedChunks: 0,
      totalChunks: 0,
      error: message,
      gateMerged: 0,
      gateViolations: 0,
    })
    throw error
  }
}
