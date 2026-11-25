/**
 * map 阶段 prompt（按块抽取）。
 * 改这个文件必须同时升 `CHUNK_EXTRACT_VERSION` —— 缓存 key 里含版本号，旧缓存自然失效。
 */

import { languageDirective, type PrimaryLanguage } from './language'
import type { PromptTemplate } from './types'

export const CHUNK_EXTRACT_VERSION = 'chunk-extract@10'

export interface ChunkPromptContext {
  readonly chunkId: string
  readonly language: PrimaryLanguage
  readonly pageStart: number
  readonly pageEnd: number
  readonly outlineTitle: string | null
  readonly text: string
}

export const chunkExtractPrompt: PromptTemplate<ChunkPromptContext> = {
  version: CHUNK_EXTRACT_VERSION,
  build: (context) => ({
    messages: [
      {
        role: 'system',
        content: [
          '你是技术文档的知识抽取器。只输出 JSON，不要任何解释、不要 markdown 代码块。',
          '',
          '抽取规则：',
          '0. **控制输出规模**：本块最多 6 个节点；每个字段都要短。宁可少而准，不要多而全。',
          '   summary ≤ 40 字；quote ≤ 80 字；aliases 最多 2 个；不要输出解释性长文。',
          '1. 节点标题 ≤ 24 字，是术语或技术点，不要整句照抄。',
          '2. importance 是 1–5 的整数（不要写字符串、不要越界）：5 = 全文级核心概念，3 = 章节级要点，1 = 细节术语。',
          '2b. difficulty 是 1–5 的整数，表示「掌握它有多难」：5 = 最难（抽象、前置知识多、推导链长），',
          '    3 = 需要一点背景，1 = 看一眼就懂。不要和 importance 混淆：重要≠难。',
          '3. quote 必须是块文本中**逐字出现**的片段（≤120 字）。找不到原文就填空字符串，严禁编造。',
          '4. page 用块元信息里的 pageStart（除非文本中明确出现其他页码）。',
          '5. relationType 必须使用英文枚举值，不要写中文、不要大写：',
          '   depends_on | triggers | belongs_to | extends | implements | contrasts_with。',
          '   都不贴切才用 custom，并同时给出 ≤12 字的 relationLabel；受控关系不要给 relationLabel。',
          '   正确示例：{"sourceTitle":"Multi-Head Attention","targetTitle":"Scaled Dot-Product Attention","relationType":"depends_on"}',
          '6. 没有把握的关系宁可不输出，严禁编造。',
          '6b. 但除非整块确实没有概念间联系，否则**必须为每个节点至少尝试连一条边**：',
          '    常见关系（前置依赖 depends_on、组成 belongs_to、扩展 extends、对比 contrasts_with）都要写出来。',
          '    整块一条边都不给是不合格的输出。',
          '7. 若文本含 `Figure N:` / `Fig. N` / `Table N:` / `表 N` 的 caption，额外输出一个图表占位节点：',
          '   figure = {"label":"Figure 1","caption":"原文 caption","page":页码,"kind":"caption_only"}。',
          '',
          '认知层级（SCoP 五技能，决定学习顺序，只能取 1–5）：',
          '   1 定位 = 这是什么（定义/术语）；2 连接 = 和谁有关；3 推断 = 多句合起来说明什么；',
          '   4 组织 = 这一组怎么归类；5 选择 = 最关键的是哪一句。',
          '   同时给出 unitKind：concept / relation / inference / structure / keypoint（与层级一一对应）。',
          '   硬约束：若 A depends_on B，则 A 的 cognitiveLevel 不得小于 B —— 前置必须先出现。',
          '   各层判据示例：L1「X 是一个 Y」；L2「X 依赖/不同于 Y」；L3「因此/由此可知……」；',
          '   L4「X 可分为 A、B 两类 / 由三部分组成」；L5「最关键的是 Z / 本章结论是 Z」。',
          '',
          '图式锚定与精细加工：',
          '   priorKnowledge：读者理解本单元**必须先掌握**的 0–3 个概念（尽量复用文中已出现的标题）。',
          '   elaboration：analogy（像什么）、contrast（不像什么/反例）、why（为什么重要）、misconception（常见误解）。',
          '   **只给 importance ≥ 4 的节点写**；其余节点两个字段都留空字符串（后续可按需分析）。',
          '   selfCheck：同样只给 importance ≥ 4 的节点写（≤40 字）；其余留空。',
          '',
          ...(languageDirective(context.language) === '' ? [] : ['', languageDirective(context.language)]),
          '',
          '输出结构：',
          '{"stage":"chunk_extract","nodes":[{"title":"","aliases":[],"summary":"","importance":3,"difficulty":3,"cognitiveLevel":1,"unitKind":"concept","priorKnowledge":[],"elaboration":{"analogy":"","contrast":"","why":"","misconception":""},"selfCheck":"","quote":"","page":1,"parentTitle":null,"figure":null,"isChapterRoot":false}],"edges":[{"sourceTitle":"","targetTitle":"","relationType":"depends_on","relationLabel":null,"evidenceQuote":null}]}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `【块元信息】${JSON.stringify({
            chunkId: context.chunkId,
            pageStart: context.pageStart,
            pageEnd: context.pageEnd,
          })}`,
          '【块文本】',
          context.text,
        ].join('\n'),
      },
    ],
    maxTokens: 8000,
  }),
}
