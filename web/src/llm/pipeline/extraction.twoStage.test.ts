import { describe, expect, it } from 'vitest'

import { runDocumentExtraction } from './extraction'

import type { ExtractionTransport } from './extraction'
import type { PageText } from './chunking'

/** 造 60 页文本，每页 300 字 → 约 13 个块；每块返回 15 个节点 → 约 195 个节点，触发两阶段汇总。 */
function pages(): PageText[] {
  const result: PageText[] = []
  for (let page = 1; page <= 60; page += 1) {
    result.push({ page, text: `第${page}页内容。`.repeat(60) })
  }
  return result
}

function chunkNodes(chunkIndex: number, count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `知识点-${chunkIndex}-${index}`,
    aliases: [],
    summary: `第 ${chunkIndex} 块的第 ${index} 个知识点`,
    importance: 3,
    difficulty: 3,
    cognitiveLevel: 1,
    unitKind: 'concept',
    quote: '',
    page: null,
    parentTitle: null,
    figure: null,
    isChapterRoot: false,
  }))
}

describe('大文档两阶段汇总', () => {
  it('节点超过批上限时会分批汇总，并做一次最终汇总', async () => {
    const calls: string[] = []
    let chunkCount = 0
    const transport: ExtractionTransport = async (input) => {
      calls.push(input.stage)
      if (input.stage === 'chunk_extract') {
        chunkCount += 1
        return {
          content: JSON.stringify({
            stage: 'chunk_extract',
            nodes: chunkNodes(chunkCount, 15),
            edges: [],
          }),
          mock: true,
        }
      }
      // reduce：把输入里的标题原样回显成节点，模拟「汇总」
      const prompt = input.messages.map((message) => message.content).join('\n')
      const titles = [...prompt.matchAll(/^- (.+?) \(importance=/gm)].map((match) => match[1]!)
      return {
        content: JSON.stringify({
          stage: 'global_reduce',
          nodes: titles.slice(0, 40).map((title) => ({
            title,
            aliases: [],
            summary: '汇总后的节点',
            importance: 4,
            difficulty: 3,
            cognitiveLevel: 4,
            unitKind: 'structure',
            priorKnowledge: [],
            elaboration: null,
            selfCheck: '',
            quote: '',
            page: null,
            parentTitle: null,
            figure: null,
            isChapterRoot: false,
          })),
          edges: [],
          merges: [],
        }),
        mock: true,
      }
    }

    const outcome = await runDocumentExtraction({
      documentId: 'doc-large',
      pages: pages(),
      outline: [],
      language: 'zh-CN',
      transport,
      cache: false,
    })

    const reduceCalls = calls.filter((stage) => stage === 'global_reduce').length
    expect(outcome.failedChunks).toHaveLength(0)
    expect(outcome.nodes.length).toBeGreaterThan(0)
    // 至少：两个批次 + 一次最终汇总（或零边重试）
    expect(reduceCalls).toBeGreaterThanOrEqual(2)
  })

  it('最终汇总失败时保留批次结果（部分图谱 + 明确警告），不整篇归零', async () => {
    let chunkCount = 0
    let reduceCalls = 0
    const transport: ExtractionTransport = async (input) => {
      if (input.stage === 'chunk_extract') {
        chunkCount += 1
        return {
          content: JSON.stringify({ stage: 'chunk_extract', nodes: chunkNodes(chunkCount, 15), edges: [] }),
          mock: true,
        }
      }
      reduceCalls += 1
      // 195 节点 / 每批 80 → 3 个批次，第 4 次才是最终汇总 → 故意返回非法 JSON
      if (reduceCalls >= 4) return { content: '{"stage":"global_reduce","nodes":', mock: true }
      const prompt = input.messages.map((message) => message.content).join('\n')
      const titles = [...prompt.matchAll(/^- (.+?) \(importance=/gm)].map((match) => match[1]!)
      return {
        content: JSON.stringify({
          stage: 'global_reduce',
          nodes: titles.slice(0, 20).map((title) => ({
            title, aliases: [], summary: '批次结果', importance: 4, difficulty: 3,
            cognitiveLevel: 4, unitKind: 'structure', priorKnowledge: [], elaboration: null,
            selfCheck: '', quote: '', page: null, parentTitle: null, figure: null, isChapterRoot: false,
          })),
          edges: [],
          merges: [],
        }),
        mock: true,
      }
    }

    const outcome = await runDocumentExtraction({
      documentId: 'doc-large-fallback',
      pages: pages(),
      outline: [],
      language: 'zh-CN',
      transport,
      cache: false,
    })

    expect(outcome.failedChunks.some((chunk) => chunk.chunkId === 'global-final')).toBe(true)
    expect(outcome.nodes.length).toBeGreaterThan(0)
  })
})
