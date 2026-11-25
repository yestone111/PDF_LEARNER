/**
 * 领域层统一出口。
 * 业务代码只从这里 import（`@/domain`），不要跨文件深入内部路径，
 * 便于后续把 domain 抽成独立包时不改调用点。
 */

export * from './enums'
export * from './schemas'
export * from './types'
