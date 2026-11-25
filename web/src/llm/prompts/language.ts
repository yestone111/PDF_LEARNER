/**
 * 主要语言（primary language）。
 *
 * 用户设置一种「输出语言」，无论读的是中文/英文/日文文档：
 *  - 知识图谱节点标题、摘要、关系标签 → 用它输出；
 *  - AI 对话正文 → 用它输出；
 *  - **原文引文（quote）必须保持原文语言逐字不变** —— 引文参与锚点定位与引注核对，
 *    翻译过的引文会在原文里找不到，整个「有出处」链路就废了。
 *
 * auto = 跟随文档（默认注入的语言指令为空，让模型自然跟随原文语言）。
 */

export const PRIMARY_LANGUAGES = ['zh-CN', 'en', 'auto'] as const
export type PrimaryLanguage = (typeof PRIMARY_LANGUAGES)[number]

export const DEFAULT_PRIMARY_LANGUAGE: PrimaryLanguage = 'zh-CN'

export const PRIMARY_LANGUAGE_LABELS: Readonly<Record<PrimaryLanguage, string>> = {
  'zh-CN': '简体中文',
  en: 'English',
  auto: '跟随文档',
}

/** 持久化数据不可信：只接受白名单。 */
export function normalizePrimaryLanguage(value: unknown): PrimaryLanguage {
  return PRIMARY_LANGUAGES.find((language) => language === value) ?? DEFAULT_PRIMARY_LANGUAGE
}

/** 注入 prompt 的语言指令；auto 返回空串（不干预）。 */
export function languageDirective(language: PrimaryLanguage): string {
  if (language === 'zh-CN') {
    return [
      '【输出语言】',
      '除原文引用外，所有面向用户的文本（节点标题、摘要、别名、关系标签、回答正文）一律使用简体中文。',
      '原文引用必须保持原文语言逐字不变，严禁翻译或改写引文。',
    ].join('\n')
  }
  if (language === 'en') {
    return [
      '[Output language]',
      'All user-facing text (node titles, summaries, aliases, relation labels, answer body) must be written in English.',
      'Quotes must stay verbatim in the source language. Never translate or paraphrase them.',
    ].join('\n')
  }
  return ''
}
