/** 章节速览 prompt：把一章的知识点压成 3–6 句，主要语言输出。 */

import { languageDirective, type PrimaryLanguage } from './language'
import type { PromptTemplate } from './types'

export const CHAPTER_SUMMARY_VERSION = 'chapter-summary@4'

export interface ChapterSummaryContext {
  readonly chapterTitle: string
  readonly nodes: readonly { readonly title: string; readonly summary: string }[]
  readonly language: PrimaryLanguage
}

export const chapterSummaryPrompt: PromptTemplate<ChapterSummaryContext> = {
  version: CHAPTER_SUMMARY_VERSION,
  build: (context) => ({
    messages: [
      {
        role: 'system',
        content: [
          '你是学习助教。输入是一章的知识点标题与摘要，请做一份**逐段总结**（纯文本，不要 JSON、不要 markdown）。',
          '',
          '要求：',
          '1. 覆盖【知识点】里的**每一条**，重要度高的多写、次要的少写，但都不许漏。',
          '2. **一个知识点一个自然段**（不是 bullet 列表）：只讲这一段在说什么——定义、机制、关键结论，',
          '   必要时说明它和哪个知识点相关。',
          '3. **不要写学习顺序建议**：不要出现「先学…再学…」「建议按…顺序」「容易卡在…」这类内容；',
          '   这一节只做内容总结，不做学习规划。',
          '4. 不要编造输入里没有的内容；不要只罗列标题。',
          '5. 每个知识点**第一次**出现时，用「」原样引出它在【知识点】里的标题（必须逐字一致，不要翻译），',
          '   后面再展开解释——这样读者能在图谱里定位到它。',
          '',
          ...(languageDirective(context.language) === '' ? [] : [languageDirective(context.language)]),
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `【章节】${context.chapterTitle}`,
          '【知识点】',
          ...context.nodes.map((node) => `- ${node.title}：${node.summary === '' ? '（暂无摘要）' : node.summary}`),
        ].join('\n'),
      },
    ],
    maxTokens: 4000,
  }),
}
