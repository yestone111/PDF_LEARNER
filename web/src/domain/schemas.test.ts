/**
 * 领域 schema 契约测试（第一轮交付物的自检）。
 *
 * 目的不是覆盖率，而是钉死几条硬规则：
 *  1) 类型与 schema 的推断结果必须能互相赋值（防止两份定义漂移）
 *  2) 重要度只有 1–5
 *  3) 没有预测值时必须 importanceSource='none'（不得伪造重要度）
 *  4) custom 关系必须自带标签，受控关系不得自带标签
 *  5) 已完成的助手回答必须至少带一条引注
 *  6) parseStrict 失败时给出可读路径
 */

import { describe, expect, it } from 'vitest'

// 只取类型：`import type` 在 verbatimModuleSyntax 下会被完全擦除，
// node 环境跑测试不会真去加载库的 React/pdfjs 运行时。
import type { Content, IHighlight, ScaledPosition } from 'react-pdf-highlighter'

import type {
  ChatMessage,
  ExtractionCache,
  Highlight,
  KDocument,
  KnowledgeEdge,
  KnowledgeNode,
  NoteDoc,
  OutlineNode,
  SyncConfig,
} from './types'

import {
  ChatMessageSchema,
  GlobalGraphResultSchema,
  ExtractionCacheSchema,
  HighlightSchema,
  KDocumentSchema,
  KnowledgeEdgeSchema,
  KnowledgeNodeSchema,
  NoteDocSchema,
  OutlineNodeSchema,
  SyncConfigSchema,
  parseStrict,
} from './schemas'

const now = 1_700_000_000_000

const validDocument: KDocument = {
  id: 'doc-1',
  name: 'attention-is-all-you-need.pdf',
  pageCount: 15,
  sizeBytes: 2_211_000,
  fileId: 'file-1',
  status: 'outline_parsed',
  createdAt: now,
  updatedAt: now,
}

const validOutlineNode: OutlineNode = {
  id: 'ol-1',
  documentId: 'doc-1',
  parentId: null,
  order: 0,
  level: 1,
  title: '3 Model Architecture',
  page: 3,
  predictedImportance: 5,
  importanceSource: 'outline_heuristic',
  graphBuilt: false,
  createdAt: now,
  updatedAt: now,
}

const validNode: KnowledgeNode = {
  id: 'kn-1',
  documentId: 'doc-1',
  parentId: null,
  chapterId: null,
  scope: 'global',
  title: 'Scaled Dot-Product Attention',
  titleNorm: 'scaled dot product attention',
  aliases: ['点积注意力'],
  summary: '把 Query/Key 归一化点积后 softmax 加权 Value。',
  difficulty: 4,
  cognitiveLevel: 2,
  unitKind: 'relation',
  priorKnowledge: ['Scaled Dot-Product Attention 的输入'],
  elaboration: null,
  selfCheck: '',
  importance: 5,
  importanceSource: 'llm',
  mastery: 'unmastered',
  anchor: { page: 4, quote: 'scaled dot-product attention', rects: [] },
  sourceChunkId: 'chunk-abc',
  figure: null,
  createdAt: now,
  updatedAt: now,
}

const validEdge: KnowledgeEdge = {
  id: 'ke-1',
  documentId: 'doc-1',
  sourceId: 'kn-1',
  targetId: 'kn-2',
  relationType: 'depends_on',
  relationLabel: '依赖',
  origin: 'llm',
  evidence: null,
  confidence: 0.8,
  createdAt: now,
}

const validHighlight: Highlight = {
  id: 'hl-1',
  documentId: 'doc-1',
  position: {
    boundingRect: { x1: 0, y1: 0, x2: 10, y2: 10, width: 10, height: 10, pageNumber: 1 },
    rects: [],
    pageNumber: 1,
  },
  content: { text: '原文片段' },
  comment: { text: '这里的关键是除以 sqrt(d_k)', emoji: '💡' },
  nodeId: 'kn-1',
  createdAt: now,
  updatedAt: now,
}

const validChatMessage: ChatMessage = {
  id: 'msg-1',
  threadId: 'th-1',
  documentId: 'doc-1',
  role: 'assistant',
  content: '注意力的复杂度是 O(n^2·d)。',
  citations: [{ page: 5, quote: 'O(n^2 · d)', nodeId: null, highlightId: null, verified: true }],
  context: [{ kind: 'node', label: '节点', text: 'Scaled Dot-Product Attention', page: 4, nodeId: 'kn-1', highlightId: null }],
  status: 'done',
  error: null,
  createdAt: now,
}

const validCache: ExtractionCache = {
  key: 'doc-1:chunk_extract:chunk-abc:v1',
  documentId: 'doc-1',
  stage: 'chunk_extract',
  promptVersion: 'chunk-extract@1',
  chunkId: 'chunk-abc',
  chunkHash: 'chunk-abc',
  status: 'success',
  rawResponse: '{"stage":"chunk_extract","nodes":[],"edges":[]}',
  payload: { stage: 'chunk_extract', nodes: [], edges: [] },
  error: null,
  attempts: 1,
  createdAt: now,
  updatedAt: now,
}

const validNoteDoc: NoteDoc = {
  id: 'note-1',
  documentId: 'doc-1',
  title: '阅读笔记',
  tiptapJson: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '注意力' }] },
      { type: 'nodeCard', attrs: { nodeId: 'kn-1', importance: 5 } },
    ],
  },
  imageIds: [],
  createdAt: now,
  updatedAt: now,
}

const validSyncConfig: SyncConfig = {
  id: 'sync-1',
  target: 'obsidian',
  enabled: 0,
  vaultUri: 'obsidian://new?vault=notes',
  folder: 'AKN',
  createdAt: now,
  updatedAt: now,
}

describe('领域 schema：正向契约', () => {
  it('合法实体可解析，且推断类型与手写接口互相兼容', () => {
    expect(KDocumentSchema.parse(validDocument)).toEqual(validDocument)
    expect(OutlineNodeSchema.parse(validOutlineNode)).toEqual(validOutlineNode)
    expect(KnowledgeNodeSchema.parse(validNode)).toEqual(validNode)
    expect(KnowledgeEdgeSchema.parse(validEdge)).toEqual(validEdge)
    expect(HighlightSchema.parse(validHighlight)).toEqual(validHighlight)
    expect(ChatMessageSchema.parse(validChatMessage)).toEqual(validChatMessage)
    expect(ExtractionCacheSchema.parse(validCache)).toEqual(validCache)
    expect(NoteDocSchema.parse(validNoteDoc)).toEqual(validNoteDoc)
    expect(SyncConfigSchema.parse(validSyncConfig)).toEqual(validSyncConfig)

    // 反向赋值：把 schema 的推断结果当业务类型用（编译期检查，不是运行期断言）
    const nodeFromSchema: KnowledgeNode = KnowledgeNodeSchema.parse(validNode)
    const docFromSchema: KDocument = KDocumentSchema.parse(validDocument)
    expect(nodeFromSchema.id).toBe('kn-1')
    expect(docFromSchema.pageCount).toBe(15)
  })

  it('importance 只允许 1–5', () => {
    expect(KnowledgeNodeSchema.safeParse({ ...validNode, importance: 6 }).success).toBe(false)
    expect(KnowledgeNodeSchema.safeParse({ ...validNode, importance: 0 }).success).toBe(false)
    expect(KnowledgeNodeSchema.safeParse({ ...validNode, importance: 3 }).success).toBe(true)
  })
})

describe('领域 schema：必须拦住的坏数据', () => {
  it('没有预测值却声称有来源 → 拒绝（不得伪造重要度）', () => {
    const bad = { ...validOutlineNode, predictedImportance: null, importanceSource: 'llm' }
    expect(OutlineNodeSchema.safeParse(bad).success).toBe(false)
    expect(
      OutlineNodeSchema.safeParse({ ...validOutlineNode, predictedImportance: null, importanceSource: 'none' }).success,
    ).toBe(true)
  })

  it('受控关系的标签必须与词表一致', () => {
    const bad = { ...validEdge, relationLabel: '很强的关系' }
    expect(KnowledgeEdgeSchema.safeParse(bad).success).toBe(false)
  })

  it('custom 关系允许自定义标签，但不允许自环', () => {
    const custom = { ...validEdge, relationType: 'custom', relationLabel: '衍生' }
    expect(KnowledgeEdgeSchema.safeParse(custom).success).toBe(true)
    const selfLoop = { ...custom, targetId: custom.sourceId }
    expect(KnowledgeEdgeSchema.safeParse(selfLoop).success).toBe(false)
  })

  it('已完成的助手回答必须至少有一条引注', () => {
    const noCitation = { ...validChatMessage, citations: [] }
    expect(ChatMessageSchema.safeParse(noCitation).success).toBe(false)
    // 允许显式的「无直接出处」条目
    const unverified = {
      ...validChatMessage,
      citations: [{ page: null, quote: '', nodeId: null, highlightId: null, verified: false }],
    }
    expect(ChatMessageSchema.safeParse(unverified).success).toBe(true)
  })

  it('verified=true 的引注必须有页码和 quote', () => {
    const missingPage = {
      ...validChatMessage,
      citations: [{ page: null, quote: 'x', nodeId: null, highlightId: null, verified: true }],
    }
    expect(ChatMessageSchema.safeParse(missingPage).success).toBe(false)
  })

  it('LLM 产物进入缓存表前必须过 zod', () => {
    const badCache = {
      ...validCache,
      payload: { stage: 'chunk_extract', nodes: [{ title: 'x', importance: 9 }], edges: [] },
    }
    expect(ExtractionCacheSchema.safeParse(badCache).success).toBe(false)
  })
})

describe('与 react-pdf-highlighter@8 的结构对齐（高亮结构以库 schema 为准）', () => {
  it('持久化坐标可直接交给库：ScaledPosition', () => {
    // 编译期断言：Highlight.position → ScaledPosition（字段名与形状必须对齐）
    const libraryPosition: ScaledPosition = validHighlight.position
    expect(libraryPosition.pageNumber).toBe(1)
    expect(libraryPosition.boundingRect.width).toBe(10)
  })

  it('去掉本项目扩展字段后即可还原为 IHighlight', () => {
    // 编译期断言：content / comment / position 三者都能被库的类型接受
    const libraryContent: Content = validHighlight.content
    const libraryHighlight: IHighlight = {
      id: validHighlight.id,
      content: libraryContent,
      comment: validHighlight.comment,
      position: validHighlight.position,
    }
    expect(libraryHighlight.id).toBe('hl-1')
  })
})

describe('GlobalGraphResult：真实模型常见缺省字段', () => {
  it('省略 merges 时按「没有合并」处理，而不是校验失败', () => {
    const parsed = GlobalGraphResultSchema.safeParse({
      stage: 'global_reduce',
      nodes: [],
      edges: [],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.merges).toEqual([])
  })

  it('merges 结构不对仍然拒绝', () => {
    expect(
      GlobalGraphResultSchema.safeParse({ stage: 'global_reduce', nodes: [], edges: [], merges: 'nope' }).success,
    ).toBe(false)
  })
})

describe('parseStrict', () => {
  it('成功时返回数据', () => {
    const result = parseStrict(KDocumentSchema, validDocument, 'KDocument')
    expect(result.ok).toBe(true)
  })

  it('失败时返回带路径的可读错误，而不是抛异常', () => {
    const result = parseStrict(KDocumentSchema, { ...validDocument, pageCount: 0 }, 'KDocument')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('KDocument 校验失败')
      expect(result.message).toContain('pageCount')
    }
  })
})
