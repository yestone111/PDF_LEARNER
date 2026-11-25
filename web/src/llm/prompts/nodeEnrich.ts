/** 单个知识点的「按需分析」prompt：用户点开一个还没内容的节点时调用。 */

import { languageDirective, type PrimaryLanguage } from './language'
import type { PromptTemplate } from './types'

export const NODE_ENRICH_VERSION = 'node-enrich@1'

export interface NodeEnrichPromptContext {
  readonly title: string
  readonly page: number
  /** 该节点附近的原文片段（已截断）。 */
  readonly text: string
  readonly language: PrimaryLanguage
}

export const nodeEnrichPrompt: PromptTemplate<NodeEnrichPromptContext> = {
  version: NODE_ENRICH_VERSION,
  build: (context) => ({
    messages: [
      {
        role: 'system',
        content: [
          '你是知识点的解释器。输入只有**一个知识点标题**和它附近的原文片段，请输出能帮读者真正学会它的 JSON。只输出 JSON。',
          '',
          '规则：',
          '1. quote 必须是【原文片段】里**逐字出现**的句子（≤120 字），用来回到 PDF 定位；找不到就留空字符串，严禁编造。',
          '2. summary：用 1–2 句话解释它是什么、解决什么问题（≤120 字）。',
          '3. priorKnowledge：读者理解它**必须先掌握**的 0–3 个概念（短名词）。',
          '4. elaboration：analogy（像什么）、contrast（不像什么/常见误解）、why（为什么重要）、misconception（最容易错在哪）。',
          '5. selfCheck：一道检验是否真学会的自测题（≤60 字）。',
          '6. difficulty 1–5（5 最难）；cognitiveLevel 1–5（1 定位 / 2 连接 / 3 推断 / 4 组织 / 5 选择）；',
          '   unitKind 取 concept / relation / inference / structure / keypoint。',
          '',
          ...(languageDirective(context.language) === '' ? [] : ['', languageDirective(context.language)]),
          '',
          '输出结构：',
          '{"summary":"","quote":"","priorKnowledge":[],"elaboration":{"analogy":"","contrast":"","why":"","misconception":""},"selfCheck":"","difficulty":3,"cognitiveLevel":1,"unitKind":"concept"}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [`【标题】${context.title}`, `【页码】${context.page}`, '【原文片段】', context.text].join('\n'),
      },
    ],
    maxTokens: 3000,
  }),
}
