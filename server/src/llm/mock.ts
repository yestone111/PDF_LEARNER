/**
 * 本地 mock 上游 —— 仅在 `LLM_MOCK=1` 且用户明确开启时启用。
 *
 * 存在的理由：没有 DeepSeek key 时也要能验证整条流水线（切块→抽取→zod→缓存→合并→渲染）。
 * 纪律：
 *  - 每个响应都带 `x-akn-mock: 1` 头，前端必须显示「Mock 上游」标识；
 *  - 内容由**输入文本启发式推导**，不是硬编码的假知识图谱（换个文档内容就变）；
 *  - `LLM_MOCK_BROKEN_JSON=1` 时故意返回非法 JSON，用来验证「zod 拦截 + 修复失败 → 标 failed」。
 */

export interface MockStats {
  extractCalls: number
  repairCalls: number
  chatCalls: number
}

export const mockStats: MockStats = { extractCalls: 0, repairCalls: 0, chatCalls: 0 }

export function resetMockStats(): void {
  mockStats.extractCalls = 0
  mockStats.repairCalls = 0
  mockStats.chatCalls = 0
}

const META_PATTERN = /【块元信息】(\{[\s\S]*?\})/
// 兼容两代 prompt：旧版【全局节点】，新版【知识点】（含摘要与跨章线索）
const GLOBAL_NODES_PATTERN = /【(?:全局节点|知识点)】[^\n]*\n([\s\S]*?)(?:\n\n|$)/
const TEXT_PATTERN = /【块文本】\n([\s\S]*)$/

interface ChunkMeta {
  chunkId?: string
  pageStart?: number
  pageEnd?: number
  outlineTitle?: string
}

function parseMeta(prompt: string): ChunkMeta {
  const match = META_PATTERN.exec(prompt)
  if (match === null) return {}
  try {
    return JSON.parse(match[1]) as ChunkMeta
  } catch {
    return {}
  }
}

function pickSentences(text: string, limit: number): string[] {
  // 先按行切，再按句末标点切（真实 PDF 一行可能包含多个句子；长行也要能拆开）
  return text
    .split(/\n+|(?<=[.。!?])\s+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 12 && line.length <= 200)
    .slice(0, limit)
}

/** 从块文本里找 `Figure N:` / `Table N:` / `图 N:` / `表 N:` 的 caption（与前端 CAPTION_PATTERN 同义）。 */
function findCaption(text: string): { label: string; caption: string } | null {
  // PDF 文本层没有换行（items 直接拼接），所以不能要求 caption 在行首
  const match = /((?:Figure|Fig\.?|Table|图|表)\s*\d+[a-zA-Z]?\s*[:：.])\s*([^.\n]{0,120})/i.exec(text)
  if (match === null) return null
  const label = (match[1] ?? '').trim().replace(/[:：.]$/, '')
  const caption = `${label}: ${(match[2] ?? '').trim()}`.trim()
  return { label, caption }
}

function titleFromSentence(sentence: string): string {
  const head = sentence.split(/[.。;;:：]/)[0] ?? sentence
  return head.slice(0, 48).trim()
}

/** 模拟一次 chunk_extract：从块文本里挑几行当「知识点」。 */
export function mockChunkExtraction(prompt: string): string {
  const meta = parseMeta(prompt)
  const text = TEXT_PATTERN.exec(prompt)?.[1] ?? prompt
  const sentences = pickSentences(text, 4)

  if (sentences.length === 0) {
    return JSON.stringify({ stage: 'chunk_extract', nodes: [], edges: [] })
  }

  const caption = findCaption(text)

  interface MockNode {
    title: string
    aliases: string[]
    summary: string
    importance: number
    difficulty: number
    cognitiveLevel: number
    unitKind: string
    priorKnowledge: string[]
    elaboration: { analogy: string; contrast: string; why: string; misconception: string } | null
    selfCheck: string
    quote: string
    page: number
    parentTitle: string | null
    figure: { label: string; caption: string; page: number; kind: string } | null
    isChapterRoot: boolean
  }

  const nodes: MockNode[] = sentences.map((sentence, index) => ({
    title: titleFromSentence(sentence) || `片段 ${index + 1}`,
    aliases: [],
    summary: sentence.slice(0, 120),
    importance: Math.max(1, 5 - index),
    // 难度与重要度刻意错开，验证「深浅 ≠ 大小」
    difficulty: Math.min(5, Math.max(1, 1 + (index % 5))),
    // SCoP 认知层级：按出现顺序渐进，便于验证学习路径
    cognitiveLevel: Math.min(5, 1 + (index % 5)),
    unitKind: ['concept', 'relation', 'inference', 'structure', 'keypoint'][index % 5],
    priorKnowledge: index === 0 ? [] : ['前置概念示例'],
    elaboration:
      index === 0
        ? { analogy: '像查字典时先建立索引', contrast: '不是全文背诵', why: '', misconception: '' }
        : null,
    selfCheck: index < 3 ? `能否用一句话说明本块第 ${index + 1} 个要点是什么？` : '',
    quote: sentence.slice(0, 120),
    page: meta.pageStart ?? 1,
    parentTitle: meta.outlineTitle ?? null,
    figure: null,
    isChapterRoot: false,
  }))

  if (caption !== null) {
    // 图表/表格占位节点：真实模型通常只给 caption、不给 quote（这正是「点 Table 跳不动」的成因）；
    // 这里照样输出空 quote，让上层的 caption 锚点兜底链路被真实覆盖到。
    nodes.push({
      title: caption.label,
      aliases: [],
      summary: caption.caption.slice(0, 120),
      importance: 4,
      difficulty: 2,
      cognitiveLevel: 4,
      unitKind: 'structure',
      priorKnowledge: [],
      elaboration: null,
      selfCheck: '',
      quote: '',
      page: meta.pageStart ?? 1,
      parentTitle: meta.outlineTitle ?? null,
      figure: { label: caption.label, caption: caption.caption, page: meta.pageStart ?? 1, kind: 'caption_only' },
      isChapterRoot: false,
    })
  }

  const edges = nodes.slice(1).map((node, index) => ({
    sourceTitle: node.title,
    targetTitle: nodes[index].title,
    relationType: 'depends_on',
    relationLabel: null,
    evidenceQuote: node.quote,
  }))

  return JSON.stringify({ stage: 'chunk_extract', nodes, edges })
}

/** 模拟一次 chapter_summary：把章节标题与知识点揉成一段速览。 */
export function mockChapterSummary(prompt: string): string {
  const chapter = /【章节】(.+)/.exec(prompt)?.[1]?.trim() ?? '这一章'
  const titles = [...prompt.matchAll(/^- (.+?)：/gm)].map((match) => match[1])
  const paragraphs = titles.map((title, index) => `第 ${index + 1} 个要点「${title}」：先理解它是什么、解决什么问题，再往下接下一段。`)
  return `（mock 速览）${chapter}按知识点分段：\n\n${paragraphs.join('\n\n')}\n\n学习建议：按 L1→L5 顺序学，遇到前置缺失先补。`
}

/** 模拟一次 node_enrich：给节点补摘要/引文/先修/四问/自测。 */
export function mockNodeEnrich(prompt: string): string {
  const title = /【标题】(.+)/.exec(prompt)?.[1]?.trim() ?? '该知识点'
  const page = Number(/【页码】(\d+)/.exec(prompt)?.[1] ?? 1)
  const quote = /【原文片段】\n([^\n]{8,80})/.exec(prompt)?.[1]?.trim() ?? ''
  return JSON.stringify({
    summary: `（mock 分析）${title} 是原文中的一个知识点，用来把前后概念串起来。`,
    quote,
    priorKnowledge: ['前置概念示例'],
    elaboration: {
      analogy: '像地图上的一个地标',
      contrast: '不是死记硬背的条目',
      why: '它决定了后面几步怎么理解',
      misconception: '容易和相邻概念混淆',
    },
    selfCheck: `能否用一句话说明「${title}」是什么？`,
    difficulty: 3,
    cognitiveLevel: 2,
    unitKind: 'relation',
    page,
  })
}

/** 模拟一次 global_reduce：把请求里给出的节点标题汇总成全局图。 */
export function mockGlobalReduce(prompt: string): string {
  const block = GLOBAL_NODES_PATTERN.exec(prompt)?.[1] ?? ''
  // 节点行格式：- 标题 (importance=4, difficulty=3, chapters=第1章/第2章) 摘要
  const allTitles = block
    .split('\n')
    .map((line) => /^-\s+(.+?)\s+\(/.exec(line.trim())?.[1]?.trim() ?? '')
    .filter((line) => line.length > 0)
  // 图表/表格标题优先保留：它们数量少，但最容易在截断里被丢掉（跳转链路要靠它们验收）
  const isCaptionTitle = (title: string): boolean => /^(?:Figure|Fig\.?|Table|图|表)\s*\d+/i.test(title)
  const titles = [...allTitles.filter(isCaptionTitle), ...allTitles.filter((title) => !isCaptionTitle(title))].slice(0, 12)


  // 「空节点」留在一个普通知识点上（图表节点会用 caption 兜底描述，不能用来测空态）
  const emptyIndex = Math.max(0, titles.findIndex((title) => !isCaptionTitle(title)))
  const nodes = titles.map((title, index) => ({
    title,
    aliases: [],
    // 故意留一个节点没有摘要/自测：验证「点击进一步分析」按钮
    summary: index === emptyIndex ? '' : `（mock 汇总）${title}`,
    importance: index < 3 ? 5 : index < 6 ? 4 : 3,
    difficulty: index < 2 ? 5 : index < 5 ? 3 : 2,
    cognitiveLevel: index === 0 ? 4 : Math.min(5, 1 + (index % 5)),
    unitKind: index === 0 ? 'structure' : ['concept', 'relation', 'inference', 'keypoint'][index % 4],
    priorKnowledge: index === 0 ? [] : [titles[0] ?? ''],
    elaboration:
      index === 0
        ? { analogy: '像先看整本书的地图再进房间', contrast: '不是逐页背诵', why: '先搭总纲', misconception: '' }
        : null,
    selfCheck: index < 3 ? `能否说出「${title}」与相邻概念的关系？` : '',
    quote: '',
    page: null,
    parentTitle: null,
    figure: null,
    isChapterRoot: false,
  }))

  // 模拟「先搭总纲」：第一个节点当总纲，其余 belongs_to 挂上去，总纲之间串成主脊
  const pillar = nodes[0]
  const edges = nodes.slice(1).map((node) => ({
    sourceTitle: node.title,
    targetTitle: pillar?.title ?? node.title,
    relationType: 'belongs_to',
    relationLabel: null,
    evidenceQuote: null,
  }))
  // 再给两条总纲之间的 depends_on，模拟「主脊」
  if (nodes.length >= 4 && nodes[1] !== undefined && nodes[3] !== undefined) {
    edges.push({
      sourceTitle: nodes[1].title,
      targetTitle: nodes[3].title,
      relationType: 'depends_on',
      relationLabel: null,
      evidenceQuote: null,
    })
  }

  return JSON.stringify({ stage: 'global_reduce', nodes, edges, merges: [] })
}

/** 模拟一次对话补全（带一条「引注」，格式与真实模型约定一致）。 */
export function mockChatAnswer(prompt: string): string {
  // 若 prompt 里带了【原文摘录】，就逐字回显其中一段 —— 这样引注校验能通过，
  // 用来验证「引注 → 原文核对」的正向链路（真实模型也应当这样引用）。
  const excerpt = /【原文摘录】第(\d+)页：「([\s\S]{5,200}?)」/.exec(prompt)
  if (excerpt !== null) {
    const page = Number(excerpt[1])
    const quote = excerpt[2].trim()
    return `（Mock 上游回答，用于验证链路，不代表真实模型结论）\n\n概览：这一页在讨论 ${quote.slice(0, 40)}…\n\n[引用] 第${page}页：「${quote}」`
  }
  return `（Mock 上游回答，用于验证链路，不代表真实模型结论）\n\n无直接出处`
}

export function mockStreamChunks(answer: string): string[] {
  const size = 8
  const chunks: string[] = []
  for (let index = 0; index < answer.length; index += size) {
    chunks.push(answer.slice(index, index + size))
  }
  return chunks
}

