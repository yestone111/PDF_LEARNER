/**
 * prompt 版本注册表（任务书 §5.1 第 5 条：所有模板集中存放并带 version）。
 * 改任何 prompt 都必须改这里的版本号，否则缓存会把旧结果当成新 prompt 的答案。
 */

export { CHAPTER_SUMMARY_VERSION, chapterSummaryPrompt } from './chapterSummary'
export type { ChapterSummaryContext } from './chapterSummary'
export { CHUNK_EXTRACT_VERSION, chunkExtractPrompt } from './chunkExtract'
export { GLOBAL_REDUCE_VERSION, globalReducePrompt } from './globalReduce'
export type { ReduceEdgeCandidate, ReduceNodeSummary } from './globalReduce'
export { JSON_REPAIR_VERSION, jsonRepairPrompt } from './jsonRepair'
export type { PromptMessage, PromptTemplate } from './types'
export {
  DEFAULT_PRIMARY_LANGUAGE,
  PRIMARY_LANGUAGES,
  PRIMARY_LANGUAGE_LABELS,
  languageDirective,
  normalizePrimaryLanguage,
  type PrimaryLanguage,
} from './language'

export const PROMPT_VERSIONS = {
  chunkExtract: 'chunk-extract@5',
  globalReduce: 'global-reduce@6',
  jsonRepair: 'json-repair@1',
} as const
