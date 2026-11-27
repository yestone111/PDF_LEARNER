/**
 * 领域枚举与受控词表（第一轮交付物 ② 的一部分）。
 *
 * 约束：
 * - 纯常量模块：无副作用、不依赖 DOM / Dexie / React，可被前端、测试、prompt 构造共用。
 * - 所有取值都是 `as const` 数组，同时产出类型与 zod enum 的取值来源，避免两处漂移。
 */

/** 重要度：1 = 最次要，5 = 最核心。用分级而非枚举，保证颜色加深是连续映射。 */
export const IMPORTANCE_VALUES = [1, 2, 3, 4, 5] as const
export type Importance = (typeof IMPORTANCE_VALUES)[number]

/** 掌握状态：与重要度正交，切换掌握状态时不得丢失重要度深浅。 */
/**
 * 掌握状态三态：
 *   unmastered 未掌握（红）
 *   mastered   已掌握（绿）
 *   doubt      有疑问（黄）—— 学过但还没吃透，需要回来再看
 *
 * 点击切换顺序固定为 未掌握 → 已掌握 → 有疑问 → 未掌握（MASTERY_NEXT），
 * 这样「点一下 = 标记已掌握」的老行为不变。
 */
export const MASTERY_STATES = ['unmastered', 'doubt', 'mastered'] as const
export type MasteryState = (typeof MASTERY_STATES)[number]

/** 展示用中文标签（图谱、学习路径、笔记卡片共用一份，避免各写一套）。 */
export const MASTERY_LABELS: Readonly<Record<MasteryState, string>> = {
  unmastered: '未掌握',
  doubt: '有疑问',
  mastered: '已掌握',
}

/** 点一下切到哪个状态（顺序：未掌握 → 已掌握 → 有疑问 → 未掌握）。 */
export const MASTERY_NEXT: Readonly<Record<MasteryState, MasteryState>> = {
  unmastered: 'mastered',
  mastered: 'doubt',
  doubt: 'unmastered',
}

/** 节点作用域：global 属于总览图，chapter 属于章节子图（同一实体表，靠 parentId 分层）。 */
export const NODE_SCOPES = ['global', 'chapter'] as const
export type NodeScope = (typeof NODE_SCOPES)[number]

/**
 * 重要度来源，用于「不得伪造重要度」：
 * - llm：LLM 抽取时给出
 * - outline_heuristic：仅凭版面/标题启发式预测（可信度低，UI 需区别对待）
 * - manual：用户手动调整
 * - none：无预测值，UI 必须用中性占位色
 */
export const IMPORTANCE_SOURCES = ['llm', 'outline_heuristic', 'manual', 'none'] as const
export type ImportanceSource = (typeof IMPORTANCE_SOURCES)[number]

/** 图表节点类型：v1 只生成 caption_only，vision 为 P1 预留（不实现渲染截图识别）。 */
export const FIGURE_KINDS = ['caption_only', 'vision'] as const
export type FigureKind = (typeof FIGURE_KINDS)[number]

/** 文档处理状态机（决定左栏目录与模块二按钮的可用性）。 */
export const DOCUMENT_STATUSES = [
  'uploaded',
  'outline_parsed',
  'analyzing',
  'analyzed',
  'failed',
] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/** 抽取阶段：chunk_extract = map 阶段按块抽取；global_reduce = reduce 汇总；json_repair = zod 失败后的修复尝试；node_enrich = 单节点按需分析；chapter_summary = 章节速览。 */
export const EXTRACTION_STAGES = ['chunk_extract', 'global_reduce', 'json_repair', 'node_enrich', 'chapter_summary'] as const
export type ExtractionStage = (typeof EXTRACTION_STAGES)[number]

/** 缓存条目状态：failed 允许单块重试，禁止用假数据填充。 */
export const EXTRACTION_STATUSES = ['pending', 'success', 'failed'] as const
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number]

export const CHAT_ROLES = ['system', 'user', 'assistant'] as const
export type ChatRole = (typeof CHAT_ROLES)[number]

export const MESSAGE_STATUSES = ['streaming', 'done', 'error'] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

/** 关系标签受控词表：6 个受控关系 + custom 逃生口（custom 必须自带 relationLabel）。 */
export const RELATION_TYPES = [
  'depends_on',
  'triggers',
  'belongs_to',
  'extends',
  'implements',
  'contrasts_with',
  'custom',
] as const
export type RelationType = (typeof RELATION_TYPES)[number]

/** 受控关系的中文显示名。边标签默认取这里；custom 取 KnowledgeEdge.relationLabel。 */
export const RELATION_LABELS: Readonly<Record<RelationType, string>> = {
  depends_on: '依赖',
  triggers: '触发',
  belongs_to: '属于',
  extends: '扩展',
  implements: '实现',
  contrasts_with: '对比',
  custom: '自定义',
}

/** SCoP 五技能：拆解单元的认知操作层级（1 定位 → 5 选择）。 */
export const COGNITIVE_LEVELS = [1, 2, 3, 4, 5] as const
export type CognitiveLevel = (typeof COGNITIVE_LEVELS)[number]

export const COGNITIVE_LEVEL_LABELS: Readonly<Record<CognitiveLevel, string>> = {
  1: '定位',
  2: '连接',
  3: '推断',
  4: '组织',
  5: '选择',
}

export const UNIT_KINDS = ['concept', 'relation', 'inference', 'structure', 'keypoint'] as const
export type UnitKind = (typeof UNIT_KINDS)[number]

export const UNIT_KIND_LABELS: Readonly<Record<UnitKind, string>> = {
  concept: '概念',
  relation: '关系',
  inference: '推断',
  structure: '结构',
  keypoint: '要点',
}

/** 层级 ↔ 单元类型的默认对应（模型漏填时按层级回落）。 */
export const UNIT_KIND_BY_LEVEL: Readonly<Record<CognitiveLevel, UnitKind>> = {
  1: 'concept',
  2: 'relation',
  3: 'inference',
  4: 'structure',
  5: 'keypoint',
}

/** 受控关系的英文显示名（主要语言选 English 时用）。 */
export const RELATION_LABELS_EN: Readonly<Record<RelationType, string>> = {
  depends_on: 'depends on',
  triggers: 'triggers',
  belongs_to: 'belongs to',
  extends: 'extends',
  implements: 'implements',
  contrasts_with: 'contrasts with',
  custom: 'custom',
}

/** 给 prompt 用的语义说明，保证「代码与 prompt 里的合并/关系规则同时体现」。 */
export const RELATION_DESCRIPTIONS: Readonly<Record<RelationType, string>> = {
  depends_on: 'source 要成立或工作，必须先理解/具备 target',
  triggers: 'source 的发生会导致 target 发生或被激活',
  belongs_to: 'source 是 target 的下级构成、分类或子技术',
  extends: 'source 在 target 的基础上做了扩展、增强或推广',
  implements: 'source 是对 target（标准/算法/协议）的具体实现',
  contrasts_with: 'source 与 target 是并列的对照/替代方案',
  custom: '以上都不贴切时使用，必须同时给出 relationLabel',
}

/** 边的视觉色（与掌握状态无关，避免和红绿状态机混淆）。 */
export const RELATION_EDGE_COLORS: Readonly<Record<RelationType, string>> = {
  depends_on: '#f59e0b',
  triggers: '#ef4444',
  belongs_to: '#64748b',
  extends: '#22c55e',
  implements: '#3b82f6',
  contrasts_with: '#a855f7',
  custom: '#94a3b8',
}

/** 边来源：llm = 抽取产出；user = 用户手动补的边。 */
export const EDGE_ORIGINS = ['llm', 'user'] as const
export type EdgeOrigin = (typeof EDGE_ORIGINS)[number]

/** 同步目标（P1 只留配置与空实现，不发真实请求）。 */
export const SYNC_TARGETS = ['obsidian', 'notion', 'feishu'] as const
export type SyncTarget = (typeof SYNC_TARGETS)[number]

/** 聊天 context chip 的来源类型。 */
export const CONTEXT_KINDS = ['selection', 'node', 'highlight'] as const
export type ContextKind = (typeof CONTEXT_KINDS)[number]

/** 自定义关系的兜底标签长度上限（防止把整段描述塞进边标签）。 */
export const CUSTOM_RELATION_LABEL_MAX = 12
