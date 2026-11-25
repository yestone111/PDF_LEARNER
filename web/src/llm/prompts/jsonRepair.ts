/** zod 校验失败后的「只修格式」prompt（只允许尝试一次）。 */

import type { PromptTemplate } from './types'

export const JSON_REPAIR_VERSION = 'json-repair@1'

export interface JsonRepairPromptContext {
  readonly stage: string
  readonly validationError: string
  readonly rawOutput: string
}

export const jsonRepairPrompt: PromptTemplate<JsonRepairPromptContext> = {
  version: JSON_REPAIR_VERSION,
  build: (context) => ({
    messages: [
      {
        role: 'system',
        content: [
          '你的上一条输出没有通过 JSON/schema 校验。请**只修复格式**，不要增删信息、不要改变含义。',
          '只输出一个合法 JSON 对象，不要解释、不要代码块。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `阶段：${context.stage}`,
          `校验错误：${context.validationError}`,
          '原始输出：',
          context.rawOutput.slice(0, 4000),
        ].join('\n'),
      },
    ],
    maxTokens: 6000,
  }),
}
