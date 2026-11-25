import { describe, expect, it } from 'vitest'

import { chapterSummaryPrompt } from './chapterSummary'
import { chunkExtractPrompt } from './chunkExtract'
import { globalReducePrompt } from './globalReduce'

const chunkContext = {
  chunkId: 'c1',
  pageStart: 3,
  pageEnd: 4,
  outlineTitle: 'Model Architecture',
  text: 'Multi-head attention allows the model to jointly attend to information.',
}

const reduceContext = {
  nodes: [
    {
      title: 'Multi-Head Attention',
      importance: 4,
      difficulty: 4,
      page: 3,
      summary: '多个注意力头并行抽取不同子空间信息',
      cognitiveLevel: 3,
      unitKind: 'inference',
    },
  ],
  candidates: [
    { source: 'Multi-Head Attention', target: 'Scaled Dot-Product Attention', relationType: 'depends_on' as const, count: 3 },
  ],
}

function systemOf(messages: readonly { role: string; content: string }[]): string {
  return messages.find((message) => message.role === 'system')?.content ?? ''
}

describe('章节速览 prompt', () => {
  const summaryContext = {
    chapterTitle: '3 Model Architecture',
    nodes: [
      { title: 'Encoder', summary: '六层堆叠的编码器' },
      { title: 'Decoder', summary: '自回归解码器' },
    ],
  }

  it('要求按知识点分段、全覆盖、纯文本', () => {
    const system = systemOf(chapterSummaryPrompt.build({ ...summaryContext, language: 'zh-CN' }).messages)
    expect(system).toContain('逐段总结')
    expect(system).toContain('每一条')
    expect(system).toContain('都不许漏')
    expect(system).toContain('「」原样引出')
    expect(system).toContain('逐段总结')
    expect(system).toContain('不要写学习顺序建议')
    expect(system).toContain('纯文本')
  })

  it('按主要语言输出（英文时注入英文指令）', () => {
    const zh = systemOf(chapterSummaryPrompt.build({ ...summaryContext, language: 'zh-CN' }).messages)
    const en = systemOf(chapterSummaryPrompt.build({ ...summaryContext, language: 'en' }).messages)
    expect(zh).toContain('简体中文')
    expect(en).toContain('English')
  })

  it('输入带上章节与知识点摘要', () => {
    const built = chapterSummaryPrompt.build({ ...summaryContext, language: 'zh-CN' })
    const user = built.messages.find((message) => message.role === 'user')?.content ?? ''
    expect(user).toContain('3 Model Architecture')
    expect(user).toContain('Encoder：六层堆叠的编码器')
  })
})

describe('主要语言注入抽取 prompt', () => {
  it('中文：要求中文输出，并要求引文逐字不译', () => {
    const system = systemOf(chunkExtractPrompt.build({ ...chunkContext, language: 'zh-CN' }).messages)
    expect(system).toContain('简体中文')
    expect(system).toContain('逐字不变')
  })

  it('英文：要求英文输出，并要求引文不译', () => {
    const system = systemOf(chunkExtractPrompt.build({ ...chunkContext, language: 'en' }).messages)
    expect(system).toContain('English')
    expect(system).toContain('verbatim')
  })

  it('auto：不注入语言指令（跟随原文）', () => {
    const system = systemOf(chunkExtractPrompt.build({ ...chunkContext, language: 'auto' }).messages)
    expect(system).not.toContain('简体中文')
    expect(system).not.toContain('Output language')
  })

  it('全局汇总 prompt 同样受语言控制', () => {
    const zh = systemOf(globalReducePrompt.build({ ...reduceContext, language: 'zh-CN' }).messages)
    const en = systemOf(globalReducePrompt.build({ ...reduceContext, language: 'en' }).messages)
    expect(zh).toContain('简体中文')
    expect(en).toContain('English')
  })

  it('总纲优先：reduce prompt 要求先搭框架、禁止按章节机械分组', () => {
    const system = systemOf(globalReducePrompt.build({ ...reduceContext, language: 'zh-CN' }).messages)
    expect(system).toContain('总纲')
    expect(system).toContain('belongs_to')
    expect(system).toMatch(/不要按章节|禁止据此机械分组|按语义归属/)
  })

  it('reduce 的输入包含摘要与候选关系，且不再喂目录/章节（结构完全由语义决定）', () => {
    const built = globalReducePrompt.build({ ...reduceContext, language: 'zh-CN' })
    const user = built.messages.find((message) => message.role === 'user')?.content ?? ''
    expect(user).toContain('多个注意力头并行抽取不同子空间信息')
    expect(user).toContain('×3')
    expect(user).not.toContain('章节线索')
    expect(user).not.toContain('chapters=')
  })

  it('引文必须保留原语言这一点在两种语言下都写进了 prompt', () => {
    const zh = systemOf(chunkExtractPrompt.build({ ...chunkContext, language: 'zh-CN' }).messages)
    const en = systemOf(chunkExtractPrompt.build({ ...chunkContext, language: 'en' }).messages)
    expect(zh).toMatch(/引文|引用/)
    expect(en.toLowerCase()).toMatch(/quote/)
  })
})
