/** reduce 阶段 prompt：先搭总纲（语义归属），再挂细节。 */

import { languageDirective, type PrimaryLanguage } from './language'
import type { PromptTemplate } from './types'
import type { RelationType } from '../../domain/enums'

export const GLOBAL_REDUCE_VERSION = 'global-reduce@9'

export interface ReduceNodeSummary {
  readonly title: string
  readonly importance: number
  readonly difficulty: number
  readonly page: number | null
  /** 一句话摘要：让汇总阶段的模型「看得懂」概念，而不是只看标题。 */
  readonly summary: string
  readonly cognitiveLevel: number
  readonly unitKind: string
}

export interface ReduceEdgeCandidate {
  readonly source: string
  readonly target: string
  readonly relationType: RelationType
  /** 分块阶段有多少块给出了这条关系（越高越可靠）。 */
  readonly count: number
}

export interface GlobalReducePromptContext {
  readonly nodes: readonly ReduceNodeSummary[]
  readonly candidates: readonly ReduceEdgeCandidate[]
  readonly language: PrimaryLanguage
  /** 上一次输出没有任何关系边时置 true：追加一条「必须补关系」的强调（结果仍走同一校验）。 */
  readonly insistEdges?: boolean
}

export const globalReducePrompt: PromptTemplate<GlobalReducePromptContext> = {
  version: GLOBAL_REDUCE_VERSION,
  build: (context) => ({
    messages: [
      {
        role: 'system',
        content: [
          '你是知识框架构建器。目标不是罗列标题，而是**先搭总纲、再挂细节**，输出一张能顺着学的图。只输出 JSON。',
          '',
          '框架规则：',
          '1. 通读所有节点的标题与摘要，先识别 3–8 个覆盖全书的**总纲概念**（各自统摄一批细节）。',
          '2. 其余节点用 belongs_to 连到语义上最贴切的总纲；**完全按语义归属**——',
          '   同一个大概念的多个方面可能分散在文档不同位置，必须归到同一个总纲下。',
          '   文档目录（章节顺序）不作为结构依据，不要输出章节节点。',
          '3. 总纲之间用 depends_on（学习先后）或 contrasts_with（对照）连起来，形成主脊。',
          '4. 「已有关系候选」是分块阶段抽到的高频关系：可靠的采纳、错误的删掉、缺失的按语义补。',
          '5. 同一概念以不同名称/侧面出现时合并，并显式写进 merges：[{"canonical":"规范标题","aliases":["被合并的标题"]}]；有疑问就保留为两个节点。',
          '6. 总纲节点 importance 给 4–5；difficulty 1–5 表示掌握难度（5 最难），它决定图上颜色深浅。',
          '7. 不要编造输入里没有的技术点；不要输出「第 X 章」这类章节节点。',
          '7b. 总纲节点的 unitKind 用 structure、cognitiveLevel 给 4–5；细节节点沿用输入里的层级。',
          '8. merges 字段不可省略：即使没有合并也要输出 "merges": []。',
          '8b. 每个 importance ≥ 4 的节点写一道 selfCheck（≤60 字，能对着原文回答的检验题）；其余可留空。',
          '',
          ...(languageDirective(context.language) === '' ? [] : ['', languageDirective(context.language)]),
          '',
          '输出结构：',
          '{"stage":"global_reduce","nodes":[{"title":"","aliases":[],"summary":"","importance":4,"difficulty":4,"cognitiveLevel":4,"unitKind":"structure","priorKnowledge":[],"elaboration":null,"selfCheck":"","quote":"","page":null,"parentTitle":null,"figure":null,"isChapterRoot":false}],"edges":[{"sourceTitle":"","targetTitle":"","relationType":"belongs_to","relationLabel":null,"evidenceQuote":null}],"merges":[{"canonical":"","aliases":[]}]}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          '【知识点】（标题 | 重要度 | 难度 | 认知层级 | 单元类型 | 摘要）',
          ...context.nodes.map(
            (node) =>
              `- ${node.title} (importance=${node.importance}, difficulty=${node.difficulty}, level=${node.cognitiveLevel}, kind=${node.unitKind}) ${node.summary}`,
          ),
          '',
          ...(context.insistEdges === true
            ? [
                '',
                '【重要】上一次输出没有任何关系边。请基于语义至少补 3 条边（depends_on / belongs_to / extends 等），',
                '不要交出一整屏孤立节点。',
              ]
            : []),
          '【已有关系候选】（来源：分块抽取，×N 表示 N 个块都给出了这条关系）',
          ...(context.candidates.length === 0
            ? ['（无候选，请按语义自行补全）']
            : context.candidates.map(
                (edge) =>
                  `- ${edge.source} --${edge.relationType}--> ${edge.target} ×${edge.count}`,
              )),
        ].join('\n'),
      },
    ],
    maxTokens: 16000,
  }),
}
