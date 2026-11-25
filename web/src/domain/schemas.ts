/**
 * zod schema（第一轮交付物 ②）。
 *
 * 只做两件事：
 *   1) 服务 LLM 边界 —— 「未经 zod 校验的数据不得进入 IndexedDB 或渲染逻辑」；
 *   2) 服务 IndexedDB 读写 —— 从 Dexie 回来的数据也当成不可信输入再校验一次。
 *
 * 约定：这里只放 schema 与极薄的解析助手，不放业务逻辑（合并/跳转/颜色一律在 Step 3 之后）。
 */

import { z } from 'zod'

import type { TiptapNode } from './types'

import {
  CHAT_ROLES,
  CONTEXT_KINDS,
  MASTERY_STATES,
  MESSAGE_STATUSES,
  NODE_SCOPES,
  RELATION_LABELS,
  RELATION_TYPES,
  EXTRACTION_STAGES,
  EXTRACTION_STATUSES,
  EDGE_ORIGINS,
  IMPORTANCE_SOURCES,
  SYNC_TARGETS,
  type Importance,
} from './enums'

/* -------------------------------------------------------------------------- *
 * 基础枚举
 * -------------------------------------------------------------------------- */

/** zod 的 z.enum 只接受字符串字面量，数字分级用 literal 联合（1 = 最次要，5 = 最核心）。 */
const CognitiveLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])

const UnitKindSchema = z.enum(['concept', 'relation', 'inference', 'structure', 'keypoint'])

const ElaborationSchema = z.object({
  analogy: z.string().max(300).default(''),
  contrast: z.string().max(300).default(''),
  why: z.string().max(300).default(''),
  misconception: z.string().max(300).default(''),
})

export const ImportanceSchema: z.ZodType<Importance> = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
])

/* -------------------------------------------------------------------------- *
 * 基础几何 / 锚点
 * -------------------------------------------------------------------------- */

export const PdfRectSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  pageNumber: z.number().int().positive(),
})

export const KnowledgeAnchorSchema = z.object({
  page: z.number().int().positive(),
  quote: z.string().min(1),
  rects: z.array(PdfRectSchema).readonly(),
})

export const KnowledgeFigureSchema = z.object({
  kind: z.enum(['caption_only', 'vision']),
  label: z.string().min(1),
  caption: z.string(),
  page: z.number().int().positive(),
  rects: z.array(PdfRectSchema).readonly(),
})

/* -------------------------------------------------------------------------- *
 * 文档与目录
 * -------------------------------------------------------------------------- */

const epochMs = z.number().int().nonnegative()

export const KDocumentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  pageCount: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  fileId: z.string().min(1),
  status: z.enum(['uploaded', 'outline_parsed', 'analyzing', 'analyzed', 'failed']),
  createdAt: epochMs,
  updatedAt: epochMs,
})

export const PdfFileSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  name: z.string().min(1),
  mime: z.literal('application/pdf'),
  sizeBytes: z.number().int().nonnegative(),
  data: z.instanceof(ArrayBuffer),
  createdAt: epochMs,
})

export const OutlineNodeSchema = z
  .object({
    id: z.string().min(1),
    documentId: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    order: z.number().int().nonnegative(),
    level: z.number().int().min(1),
    title: z.string().min(1),
    page: z.number().int().positive().nullable(),
    predictedImportance: ImportanceSchema.nullable(),
    importanceSource: z.enum(IMPORTANCE_SOURCES),
    graphBuilt: z.boolean(),
    createdAt: epochMs,
    updatedAt: epochMs,
  })
  .superRefine((node, ctx) => {
    // 「不得伪造重要度」的结构性保证：没有预测值就必须是 none，反之亦然。
    if (node.predictedImportance === null && node.importanceSource !== 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['importanceSource'],
        message: 'predictedImportance 为 null 时 importanceSource 必须是 none（不得伪造重要度）',
      })
    }
    if (node.predictedImportance !== null && node.importanceSource === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['importanceSource'],
        message: 'predictedImportance 非空时 importanceSource 不能是 none',
      })
    }
  })

/* -------------------------------------------------------------------------- *
 * 知识图谱
 * -------------------------------------------------------------------------- */

export const ChapterBookmarkSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  outlineNodeId: z.string().min(1),
  label: z.string().min(1),
  page: z.number().int().positive(),
  createdAt: epochMs,
})

export const KnowledgeNodeSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  chapterId: z.string().min(1).nullable(),
  scope: z.enum(NODE_SCOPES),
  title: z.string().min(1).max(120),
  titleNorm: z.string().min(1),
  aliases: z.array(z.string().min(1)).readonly(),
  summary: z.string(),
  // 旧数据没有 difficulty：默认 3（中等难度），不至于渲染成全黑或全白
  difficulty: ImportanceSchema.default(3),
  cognitiveLevel: CognitiveLevelSchema.default(1),
  unitKind: UnitKindSchema.default('concept'),
  priorKnowledge: z.array(z.string()).default([]),
  elaboration: ElaborationSchema.nullable().default(null),
  selfCheck: z.string().max(200).default(''),
  importance: ImportanceSchema,
  importanceSource: z.enum(IMPORTANCE_SOURCES),
  mastery: z.enum(MASTERY_STATES),
  anchor: KnowledgeAnchorSchema.nullable(),
  sourceChunkId: z.string().min(1).nullable(),
  figure: KnowledgeFigureSchema.nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
})

export const KnowledgeEdgeSchema = z
  .object({
    id: z.string().min(1),
    documentId: z.string().min(1),
    sourceId: z.string().min(1),
    targetId: z.string().min(1),
    relationType: z.enum(RELATION_TYPES),
    relationLabel: z.string().min(1).max(12),
    origin: z.enum(EDGE_ORIGINS),
    evidence: KnowledgeAnchorSchema.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    createdAt: epochMs,
  })
  .superRefine((edge, ctx) => {
    if (edge.sourceId === edge.targetId) {
      ctx.addIssue({ code: 'custom', path: ['targetId'], message: '边不允许自环' })
    }
    if (edge.relationType !== 'custom' && edge.relationLabel !== RELATION_LABELS[edge.relationType]) {
      ctx.addIssue({
        code: 'custom',
        path: ['relationLabel'],
        message: `受控关系的标签必须与词表一致：应为「${RELATION_LABELS[edge.relationType]}」`,
      })
    }
  })

/* -------------------------------------------------------------------------- *
 * 高亮 / 备注
 * -------------------------------------------------------------------------- */

export const HighlightSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  position: z.object({
    boundingRect: PdfRectSchema,
    // 与库的 ScaledPosition.rects（可变数组）保持可赋值，故不加 .readonly()
    rects: z.array(PdfRectSchema),
    pageNumber: z.number().int().positive(),
    usePdfCoordinates: z.boolean().optional(),
  }),
  content: z.object({
    text: z.string().optional(),
    image: z.string().optional(),
  }),
  comment: z.object({
    text: z.string(),
    emoji: z.string(),
  }),
  nodeId: z.string().min(1).nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
})

export const NoteSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  highlightId: z.string().min(1).nullable(),
  nodeId: z.string().min(1).nullable(),
  page: z.number().int().positive().nullable(),
  text: z.string().min(1),
  createdAt: epochMs,
  updatedAt: epochMs,
})

/* -------------------------------------------------------------------------- *
 * LLM 产物：切块、草稿、缓存
 * -------------------------------------------------------------------------- */

export const ChunkSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  order: z.number().int().nonnegative(),
  outlineNodeId: z.string().min(1).nullable(),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  text: z.string().min(1),
  charCount: z.number().int().nonnegative(),
  tokenEstimate: z.number().int().nonnegative(),
  createdAt: epochMs,
})

/**
 * LLM 边界 schema：字段名与 prompt 输出契约一一对应。
 * 注意：这里不做「标题像不像技术点」之类的内容判断，只判断结构；
 * 内容质量归 prompt 与 reduce 阶段的合并逻辑。
 */
export const LlmNodeDraftSchema = z.object({
  title: z.string().min(1).max(120),
  aliases: z.array(z.string().min(1)).default([]),
  summary: z.string().max(400).default(''),
  importance: ImportanceSchema,
  // 可选：真实模型不一定给；缺失时回落 importance（见 normalizeLlmJson）
  difficulty: ImportanceSchema.optional(),
  cognitiveLevel: CognitiveLevelSchema.optional(),
  unitKind: UnitKindSchema.optional(),
  priorKnowledge: z.array(z.string().min(1).max(60)).max(3).default([]),
  elaboration: ElaborationSchema.nullable().optional(),
  selfCheck: z.string().max(200).default(''),
  quote: z.string().max(600).default(''),
  page: z.number().int().positive().nullable().default(null),
  parentTitle: z.string().min(1).nullable().default(null),
  figure: z
    .object({
      label: z.string().min(1),
      caption: z.string(),
      page: z.number().int().positive(),
      kind: z.enum(['caption_only', 'vision']).default('caption_only'),
    })
    .nullable()
    .default(null),
  isChapterRoot: z.boolean().default(false),
})

export const LlmEdgeDraftSchema = z
  .object({
    sourceTitle: z.string().min(1),
    targetTitle: z.string().min(1),
    relationType: z.enum(RELATION_TYPES),
    relationLabel: z.string().min(1).max(12).nullable().default(null),
    evidenceQuote: z.string().nullable().default(null),
  })
  .superRefine((edge, ctx) => {
    if (edge.relationType === 'custom' && edge.relationLabel === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['relationLabel'],
        message: 'relationType=custom 时必须给出 relationLabel',
      })
    }
    if (edge.relationType !== 'custom' && edge.relationLabel !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['relationLabel'],
        message: '受控关系不得自带 relationLabel（会被词表覆盖，容易造成标签漂移）',
      })
    }
  })

export const EntityMergeSchema = z.object({
  canonical: z.string().min(1),
  aliases: z.array(z.string().min(1)).readonly(),
})

export const ChunkExtractionResultSchema = z.object({
  stage: z.literal('chunk_extract'),
  nodes: z.array(LlmNodeDraftSchema),
  edges: z.array(LlmEdgeDraftSchema),
})

/** 单节点按需分析的结果（不写缓存，直接更新节点）。 */
export const NodeEnrichResultSchema = z.object({
  summary: z.string().max(400).default(''),
  quote: z.string().max(600).default(''),
  priorKnowledge: z.array(z.string().min(1).max(60)).max(3).default([]),
  elaboration: ElaborationSchema.nullable().default(null),
  selfCheck: z.string().max(200).default(''),
  difficulty: ImportanceSchema.default(3),
  cognitiveLevel: CognitiveLevelSchema.default(1),
  unitKind: UnitKindSchema.default('concept'),
})

export const GlobalGraphResultSchema = z.object({
  stage: z.literal('global_reduce'),
  nodes: z.array(LlmNodeDraftSchema),
  edges: z.array(LlmEdgeDraftSchema),
  // 真实模型经常在「没有可合并项」时直接省略该字段；省略 = 没有合并，不是错误。
  // （2026-11-20 第一次真实 DeepSeek 调用暴露：缺省被拦，导致整图不落库）
  merges: z.array(EntityMergeSchema).default([]),
})

export const ExtractionPayloadSchema = z.union([
  ChunkExtractionResultSchema,
  GlobalGraphResultSchema,
])

export const ExtractionCacheSchema = z.object({
  key: z.string().min(1),
  documentId: z.string().min(1),
  stage: z.enum(EXTRACTION_STAGES),
  promptVersion: z.string().min(1),
  chunkId: z.string().min(1).nullable(),
  chunkHash: z.string().min(1).nullable(),
  status: z.enum(EXTRACTION_STATUSES),
  rawResponse: z.string().nullable(),
  payload: ExtractionPayloadSchema.nullable(),
  error: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: epochMs,
  updatedAt: epochMs,
})

/* -------------------------------------------------------------------------- *
 * 伴读对话
 * -------------------------------------------------------------------------- */

export const ChatThreadSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  title: z.string().min(1),
  createdAt: epochMs,
  updatedAt: epochMs,
})

export const CitationSchema = z
  .object({
    page: z.number().int().positive().nullable(),
    quote: z.string(),
    nodeId: z.string().min(1).nullable(),
    highlightId: z.string().min(1).nullable(),
    verified: z.boolean(),
  })
  .superRefine((citation, ctx) => {
    // 「无直接出处」必须是显式状态，不允许 verified=true 却没有页码。
    if (citation.verified && (citation.page === null || citation.quote.trim() === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['verified'],
        message: 'verified=true 的引注必须有页码且 quote 非空；否则应标记 verified=false',
      })
    }
  })

export const ContextSnapshotSchema = z.object({
  kind: z.enum(CONTEXT_KINDS),
  label: z.string().min(1),
  text: z.string(),
  page: z.number().int().positive().nullable(),
  nodeId: z.string().min(1).nullable(),
  highlightId: z.string().min(1).nullable(),
})

export const ChatMessageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    documentId: z.string().min(1),
    role: z.enum(CHAT_ROLES),
    content: z.string(),
    citations: z.array(CitationSchema).readonly(),
    context: z.array(ContextSnapshotSchema).readonly(),
    status: z.enum(MESSAGE_STATUSES),
    error: z.string().nullable(),
    createdAt: epochMs,
  })
  .superRefine((message, ctx) => {
    if (message.role === 'assistant' && message.status === 'done' && message.citations.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['citations'],
        message: '已完成的助手回答必须至少带一条引注（无可出处时应显式给出 verified=false 的条目）',
      })
    }
  })

/* -------------------------------------------------------------------------- *
 * 笔记
 * -------------------------------------------------------------------------- */

export const TiptapMarkSchema = z.object({
  type: z.string().min(1),
  attrs: z.record(z.string(), z.unknown()).optional(),
})

export const TiptapNodeSchema: z.ZodType<TiptapNode, TiptapNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(TiptapNodeSchema).optional(),
    marks: z.array(TiptapMarkSchema).optional(),
    text: z.string().optional(),
  }),
)

export const TiptapDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(TiptapNodeSchema).readonly(),
})

export const NoteDocSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  title: z.string().min(1),
  tiptapJson: TiptapDocSchema,
  imageIds: z.array(z.string().min(1)).readonly(),
  createdAt: epochMs,
  updatedAt: epochMs,
})

export const NoteImageSchema = z.object({
  id: z.string().min(1),
  noteDocId: z.string().min(1).nullable(),
  documentId: z.string().min(1),
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  blob: z.instanceof(Blob),
  caption: z.string().nullable(),
  createdAt: epochMs,
})

/* -------------------------------------------------------------------------- *
 * 同步配置（P1 占位）
 * -------------------------------------------------------------------------- */

const syncConfigBase = {
  id: z.string().min(1),
  enabled: z.union([z.literal(0), z.literal(1)]),
  createdAt: epochMs,
  updatedAt: epochMs,
}

export const ObsidianSyncConfigSchema = z.object({
  ...syncConfigBase,
  target: z.literal(SYNC_TARGETS[0]),
  vaultUri: z.string().startsWith('obsidian://'),
  folder: z.string(),
})

export const NotionSyncConfigSchema = z.object({
  ...syncConfigBase,
  target: z.literal(SYNC_TARGETS[1]),
  apiKey: z.string().min(1),
  databaseId: z.string().min(1),
})

export const FeishuSyncConfigSchema = z.object({
  ...syncConfigBase,
  target: z.literal(SYNC_TARGETS[2]),
  webhookUrl: z.string().startsWith('https://'),
  signSecret: z.string().nullable(),
})

export const SyncConfigSchema = z.discriminatedUnion('target', [
  ObsidianSyncConfigSchema,
  NotionSyncConfigSchema,
  FeishuSyncConfigSchema,
])

/* -------------------------------------------------------------------------- *
 * 解析助手
 * -------------------------------------------------------------------------- */

export type ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string }

/**
 * 把 zod 的 SafeParseReturnType 折叠成业务可用的三态结果。
 * 不做任何「宽松兜底」：不合法就是失败，绝不返回半成品对象。
 */
export function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string): ParseResult<T> {
  const parsed = schema.safeParse(value)
  if (parsed.success) {
    return { ok: true, data: parsed.data }
  }
  const detail = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
  return { ok: false, message: `${label} 校验失败：${detail}` }
}
