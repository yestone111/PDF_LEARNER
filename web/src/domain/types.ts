/**
 * 领域实体类型（第一轮交付物 ②）。
 *
 * 命名约定：
 * - 业务实体 `Document` 一律导出为 `KDocument`（Knowledge Document），
 *   避免与 DOM 的全局 `Document` 冲突 —— 本应用大量操作 DOM/PDF 容器，混用极易出错。
 * - 所有时间戳都是 epoch 毫秒（number），与 Dexie 索引和排序天然兼容。
 * - 所有 id 都是字符串（`crypto.randomUUID()`），不使用自增，便于离线导入/合并。
 * - 所有跨表引用只存 id，不存嵌套对象，保证 IndexedDB 单表读写不被级联拖慢。
 */

import type {
  ChatRole,
  CognitiveLevel,
  ContextKind,
  DocumentStatus,
  EdgeOrigin,
  ExtractionStage,
  ExtractionStatus,
  FigureKind,
  Importance,
  ImportanceSource,
  MasteryState,
  MessageStatus,
  NodeScope,
  RelationType,
  SyncTarget,
  UnitKind,
} from './enums'

/** ------------------------------------------------------------------------ *
 * 基础几何 / 锚点
 * ------------------------------------------------------------------------- */

/**
 * PDF 内的归一化坐标（x1/y1/x2/y2 + width/height + pageNumber）。
 *
 * 对应 react-pdf-highlighter@8 的 `Scaled`：库的**持久化**结构是 `ScaledPosition`
 * （`boundingRect/rects` 用 Scaled），而 `LTWHP`（left/top/width/height）只用于视口渲染。
 * 本类型比 `Scaled` 更严格（pageNumber 必填），因此可以直接赋值给库的类型，不需要转换。
 */
export interface PdfRect {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly width: number
  readonly height: number
  readonly pageNumber: number
}

/**
 * 知识点在 PDF 中的锚点：page + 原文 quote + 高亮框。
 * quote 是「点击节点 → 跳转并临时高亮」和「引注校验」的唯一依据；
 * rects 为空时只能按页跳转，不能框选高亮（UI 需降级并提示）。
 */
export interface KnowledgeAnchor {
  readonly page: number
  readonly quote: string
  readonly rects: readonly PdfRect[]
}

/** 图表占位节点：v1 只来自 Caption 文本启发式（caption_only）。 */
export interface KnowledgeFigure {
  readonly kind: FigureKind
  /** 图号/表号标签，如 `Figure 3`、`表 2`、`Fig. 4`。 */
  readonly label: string
  /** 原始 caption 文本（可作为节点标题/摘要）。 */
  readonly caption: string
  readonly page: number
  /** 图表在页面上的区域坐标（启发式估算，允许为空）。 */
  readonly rects: readonly PdfRect[]
}

/** ------------------------------------------------------------------------ *
 * 文档与目录
 * ------------------------------------------------------------------------- */

/** 任务书中的 `Document`。PDF 原始字节放在独立的 pdfFiles 表，本表只存句柄。 */
export interface KDocument {
  readonly id: string
  readonly name: string
  readonly pageCount: number
  readonly sizeBytes: number
  /** → PdfFile.id */
  readonly fileId: string
  readonly status: DocumentStatus
  readonly createdAt: number
  readonly updatedAt: number
}

/** PDF 原始文件（Blob 走 ArrayBuffer 存 IndexedDB，避免额外依赖）。 */
export interface PdfFile {
  readonly id: string
  readonly documentId: string
  readonly name: string
  readonly mime: string
  readonly sizeBytes: number
  readonly data: ArrayBuffer
  readonly createdAt: number
}

/**
 * 目录节点（PDF outline 的一节）。
 * `predictedImportance` 只允许来自真实预测：没有预测值时必须为 null 且 source='none'，
 * UI 用中性占位色，不得伪造红色深浅。
 */
export interface OutlineNode {
  readonly id: string
  readonly documentId: string
  readonly parentId: string | null
  /** 同级排序，从 0 开始。 */
  readonly order: number
  /** 层级，从 1 开始。 */
  readonly level: number
  readonly title: string
  /** 该章节的起始页（PDF 1-based）；解析不到时为 null。 */
  readonly page: number | null
  readonly predictedImportance: Importance | null
  readonly importanceSource: ImportanceSource
  /** 是否已生成章节子图谱（模块二的缓存命中标记）。 */
  readonly graphBuilt: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * 章节书签：把「某一章 + 它的起始页」钉住，下次打开这份文档时直接跳过去。
 * 用 outlineNodeId 而不是页码：手册重排/重新导入后页码可能变，章节 id 不变。
 */
export interface ChapterBookmark {
  readonly id: string
  readonly documentId: string
  /** → OutlineNode.id */
  readonly outlineNodeId: string
  /** 冗余保存标题：目录节点被清掉时书签提示仍可读。 */
  readonly label: string
  /** 该章节的起始页（1-based），跳转用。 */
  readonly page: number
  readonly createdAt: number
}

/** ------------------------------------------------------------------------ *
 * 知识图谱
 * ------------------------------------------------------------------------- */

/**
 * 知识点节点。总览图与章节子图共用本表：
 * - scope='global'：parentId = null（总览图根集合）
 * - scope='chapter'：chapterId = 所属 OutlineNode.id；
 *   parentId = 归并到的全局节点 id，若未归并则为该章节根节点 id。
 * 因此「子图谱节点」与「全局节点」是同一套实体 + 层级关系，不是两套数据。
 */
/** 精细加工四问（图式理论：把新概念挂到读者已有结构上）。 */
export interface Elaboration {
  /** 类比：像什么 */
  readonly analogy: string
  /** 对比/反例：不像什么 */
  readonly contrast: string
  /** 为什么重要 / 解决什么问题 */
  readonly why: string
  /** 常见误解 */
  readonly misconception: string
}

export interface KnowledgeNode {
  readonly id: string
  readonly documentId: string
  readonly parentId: string | null
  readonly chapterId: string | null
  readonly scope: NodeScope
  readonly title: string
  /** 归一化标题（NFKC → 小写 → 去标点/空格），实体合并的唯一依据。 */
  readonly titleNorm: string
  readonly aliases: readonly string[]
  readonly summary: string
  /**
   * 掌握难度 1–5（5 最难）。决定节点的**颜色深浅**（越深越难）。
   * 与 importance 分工：importance 表示「概念在全文中的重要度」，difficulty 表示「学会它有多费劲」。
   */
  readonly difficulty: Importance
  readonly importance: Importance
  readonly importanceSource: ImportanceSource
  /** SCoP 认知层级 1–5（定位/连接/推断/组织/选择），决定学习路径顺序。 */
  readonly cognitiveLevel: CognitiveLevel
  /** 单元类型（concept/relation/inference/structure/keypoint）。 */
  readonly unitKind: UnitKind
  /** 读者应先掌握什么（图式锚点，≤3 条）。 */
  readonly priorKnowledge: readonly string[]
  /** 精细加工四问；模型未给出时为 null。 */
  readonly elaboration: Elaboration | null
  /** 自测问题（检验是否真的学会）；空串表示没有。 */
  readonly selfCheck: string
  readonly mastery: MasteryState
  /** 指向 PDF 原文的锚点；LLM 未给出可定位 quote 时为 null（不得编造）。 */
  readonly anchor: KnowledgeAnchor | null
  /** → Chunk.id（map 阶段产出该节点的块），用于「来源块」追溯与重跑。 */
  readonly sourceChunkId: string | null
  readonly figure: KnowledgeFigure | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** 有向边。方向语义由 relationType 决定（source → target）。 */
export interface KnowledgeEdge {
  readonly id: string
  readonly documentId: string
  /** → KnowledgeNode.id */
  readonly sourceId: string
  /** → KnowledgeNode.id */
  readonly targetId: string
  readonly relationType: RelationType
  /** 显示用标签：受控关系取 RELATION_LABELS，custom 取用户/LLM 给出的短标签。 */
  readonly relationLabel: string
  readonly origin: EdgeOrigin
  /** 支持这条边的原文证据（可为 null）。 */
  readonly evidence: KnowledgeAnchor | null
  /** 0–1；LLM 未给出时为 null，不要默认 1。 */
  readonly confidence: number | null
  readonly createdAt: number
}

/** ------------------------------------------------------------------------ *
 * 高亮 / 备注
 * ------------------------------------------------------------------------- */

/**
 * 高亮：结构以 react-pdf-highlighter 的 `IHighlight` 为准，额外补 documentId / nodeId / 时间戳。
 *
 * 对齐关系（Step 2 会加一个编译期断言钉死）：
 *   IHighlight = { id, content: Content, comment: Comment, position: ScaledPosition }
 *   本类型的 position 与 ScaledPosition（boundingRect/rects: Scaled + pageNumber + usePdfCoordinates?）同构。
 * 因此「库给的坐标 → 直接落库」「落库的坐标 → 直接喂回库」都不需要中间转换。
 */
export interface Highlight {
  readonly id: string
  readonly documentId: string
  readonly position: {
    readonly boundingRect: PdfRect
    /** 故意用可变数组：库的 `ScaledPosition.rects` 是 `Array<Scaled>`，只读数组无法赋值给它。 */
    readonly rects: PdfRect[]
    readonly pageNumber: number
    /** 交给库的提示位：true 表示这些坐标是 PDF 坐标系而非视口坐标系。 */
    readonly usePdfCoordinates?: boolean
  }
  readonly content: {
    readonly text?: string
    readonly image?: string
  }
  readonly comment: {
    readonly text: string
    readonly emoji: string
  }
  /** 关联的知识点（可空：用户可以只标原文不建节点）。 */
  readonly nodeId: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** 独立备注（不属于某个高亮时使用，例如对某个节点写读书笔记）。 */
export interface Note {
  readonly id: string
  readonly documentId: string
  readonly highlightId: string | null
  readonly nodeId: string | null
  readonly page: number | null
  readonly text: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** ------------------------------------------------------------------------ *
 * LLM 产物：切块与缓存
 * ------------------------------------------------------------------------- */

/** map 阶段的块。id 即 chunkHash，作为缓存 key 的一部分。 */
export interface Chunk {
  readonly id: string
  readonly documentId: string
  readonly order: number
  /** 该块主要覆盖的章节（可为 null：跨章节切块）。 */
  readonly outlineNodeId: string | null
  readonly pageStart: number
  readonly pageEnd: number
  readonly text: string
  readonly charCount: number
  readonly tokenEstimate: number
  readonly createdAt: number
}

/** LLM 单块抽取产出的节点草稿（未合并、未定 id）。 */
export interface LlmNodeDraft {
  readonly title: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly importance: Importance
  /** 掌握难度 1–5（可选：旧缓存里只有 importance 时由代码回落）。 */
  readonly difficulty?: Importance
  /** SCoP 认知层级（可选，缺省按 1 处理）。 */
  readonly cognitiveLevel?: CognitiveLevel
  readonly unitKind?: UnitKind
  readonly priorKnowledge?: readonly string[]
  readonly elaboration?: Elaboration | null
  readonly selfCheck?: string
  /** 原文引用，必须能在块文本中定位；定位失败则不落锚点。 */
  readonly quote: string
  readonly page: number | null
  readonly parentTitle: string | null
  readonly figure: {
    readonly label: string
    readonly caption: string
    readonly page: number
    readonly kind: FigureKind
  } | null
  readonly isChapterRoot: boolean
}

/** LLM 单块抽取产出的边草稿。 */
export interface LlmEdgeDraft {
  readonly sourceTitle: string
  readonly targetTitle: string
  readonly relationType: RelationType
  /** relationType='custom' 时必填。 */
  readonly relationLabel: string | null
  readonly evidenceQuote: string | null
}

/** map 阶段（每块一次调用）的产物，也是 ExtractionCache.payload 的一种。 */
export interface ChunkExtractionResult {
  readonly stage: 'chunk_extract'
  readonly nodes: readonly LlmNodeDraft[]
  readonly edges: readonly LlmEdgeDraft[]
}

/** reduce 阶段的实体合并记录，用于追溯「为什么这两个标题被合成一个节点」。 */
export interface EntityMerge {
  readonly canonical: string
  readonly aliases: readonly string[]
}

/** reduce 阶段（全局汇总）的产物。 */
export interface GlobalGraphResult {
  readonly stage: 'global_reduce'
  readonly nodes: readonly LlmNodeDraft[]
  readonly edges: readonly LlmEdgeDraft[]
  readonly merges: readonly EntityMerge[]
}

export type ExtractionPayload = ChunkExtractionResult | GlobalGraphResult

/**
 * 抽取缓存。key = `${documentId}:${stage}:${chunkHash|'global'}:${promptVersion}`
 * 改 prompt 必须升 promptVersion，旧缓存自然失效（不做迁移、不猜语义）。
 */
export interface ExtractionCache {
  readonly key: string
  readonly documentId: string
  readonly stage: ExtractionStage
  readonly promptVersion: string
  readonly chunkId: string | null
  readonly chunkHash: string | null
  readonly status: ExtractionStatus
  /** 上游原始文本，失败排查用；成功时可截断保存。 */
  readonly rawResponse: string | null
  /** zod 校验通过后的结构化产物；未通过必须为 null。 */
  readonly payload: ExtractionPayload | null
  readonly error: string | null
  /** 该 key 已尝试次数（含 JSON 修复重试）。 */
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** ------------------------------------------------------------------------ *
 * 伴读对话
 * ------------------------------------------------------------------------- */

export interface ChatThread {
  readonly id: string
  readonly documentId: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * 引注。verified=false 表示没有可靠出处（UI 必须显示「无直接出处」，禁止编造页码）。
 */
export interface Citation {
  readonly page: number | null
  readonly quote: string
  readonly nodeId: string | null
  readonly highlightId: string | null
  readonly verified: boolean
}

/** 提问时注入的 context 快照（context chip 的持久化形态，回看时知道当时问了什么）。 */
export interface ContextSnapshot {
  readonly kind: ContextKind
  readonly label: string
  readonly text: string
  readonly page: number | null
  readonly nodeId: string | null
  readonly highlightId: string | null
}

export interface ChatMessage {
  readonly id: string
  readonly threadId: string
  readonly documentId: string
  readonly role: ChatRole
  readonly content: string
  readonly citations: readonly Citation[]
  readonly context: readonly ContextSnapshot[]
  readonly status: MessageStatus
  readonly error: string | null
  readonly createdAt: number
}

/** ------------------------------------------------------------------------ *
 * 笔记
 * ------------------------------------------------------------------------- */

/** TipTap 文档 JSON 的最小结构化描述（校验到「形状合法」，语义由编辑器负责）。 */
export interface TiptapMark {
  readonly type: string
  readonly attrs?: Record<string, unknown>
}

export interface TiptapNode {
  readonly type: string
  readonly attrs?: Record<string, unknown>
  readonly content?: readonly TiptapNode[]
  readonly marks?: readonly TiptapMark[]
  readonly text?: string
}

export interface TiptapDoc {
  readonly type: 'doc'
  readonly content: readonly TiptapNode[]
}

/** 笔记文档：TipTap JSON 是唯一真源；Markdown 一律由它实时序列化，不落库。 */
export interface NoteDoc {
  readonly id: string
  readonly documentId: string
  readonly title: string
  readonly tiptapJson: TiptapDoc
  /** 引用到的图片 id（→ NoteImage.id），用于导出时判断降级方式。 */
  readonly imageIds: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** 插入笔记的图片（图谱截图 / 高亮截图），二进制存 IndexedDB。 */
export interface NoteImage {
  readonly id: string
  readonly noteDocId: string | null
  readonly documentId: string
  readonly mime: string
  readonly sizeBytes: number
  readonly width: number
  readonly height: number
  readonly blob: Blob
  readonly caption: string | null
  readonly createdAt: number
}

/** ------------------------------------------------------------------------ *
 * 同步（P1 只交付接口与配置 schema）
 * ------------------------------------------------------------------------- */

export interface SyncConfigBase {
  readonly id: string
  readonly target: SyncTarget
  /** Dexie 无法索引 boolean，统一用 0|1。 */
  readonly enabled: 0 | 1
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ObsidianSyncConfig extends SyncConfigBase {
  readonly target: 'obsidian'
  /** obsidian:// URI 模板，如 `obsidian://new?vault=xxx&file=...`。 */
  readonly vaultUri: string
  readonly folder: string
}

export interface NotionSyncConfig extends SyncConfigBase {
  readonly target: 'notion'
  readonly apiKey: string
  readonly databaseId: string
}

export interface FeishuSyncConfig extends SyncConfigBase {
  readonly target: 'feishu'
  readonly webhookUrl: string
  readonly signSecret: string | null
}

export type SyncConfig = ObsidianSyncConfig | NotionSyncConfig | FeishuSyncConfig

export interface SyncPayload {
  readonly noteDocId: string
  readonly markdown: string
  readonly title: string
}

export interface SyncResult {
  readonly ok: boolean
  /** 失败原因或目标返回的可读摘要。 */
  readonly message: string
  readonly itemCount: number
}

/**
 * 同步提供者接口（P1 只交付契约 + 空实现，本期禁止发真实请求）。
 * 新增目标 = 新增一个 SyncConfig 变体 + 一个 implements SyncProvider 的空实现。
 */
export interface SyncProvider<C extends SyncConfig = SyncConfig> {
  readonly target: SyncTarget
  /** 只做纯函数校验，不联网。 */
  validateConfig(config: C): { ok: true } | { ok: false; message: string }
  /** P1 空实现固定返回 { ok:false, message:'未实现' }。 */
  testConnection(config: C): Promise<SyncResult>
  push(payload: SyncPayload, config: C): Promise<SyncResult>
}
