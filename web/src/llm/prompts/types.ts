export interface PromptMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface PromptTemplate<TContext> {
  /** 版本号参与缓存 key；改 prompt 必须升版本。 */
  readonly version: string
  readonly build: (context: TContext) => {
    readonly messages: readonly PromptMessage[]
    readonly maxTokens: number
  }
}
