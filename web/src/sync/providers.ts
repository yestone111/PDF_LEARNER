/**
 * 同步能力（P1 —— 本期只交付接口与配置 schema，不写真实请求逻辑）。
 *
 * 三个目标各留一个空实现：调用即返回 { ok:false, message:'P1 未实现' }。
 * 这样 UI 与调用方可以完整接线，等到真正实现时只替换 provider 内部，不改调用点。
 */

import type { FeishuSyncConfig, NotionSyncConfig, ObsidianSyncConfig, SyncConfig, SyncPayload, SyncProvider, SyncResult } from '../domain'

const NOT_IMPLEMENTED: SyncResult = {
  ok: false,
  message: 'P1 未实现：本期只交付接口与配置占位，未发送任何真实请求',
  itemCount: 0,
}

function configLabel(config: SyncConfig): string {
  switch (config.target) {
    case 'obsidian':
      return `Obsidian（vault: ${config.vaultUri}）`
    case 'notion':
      return `Notion（database: ${config.databaseId}）`
    case 'feishu':
      return `飞书（webhook: ${config.webhookUrl.slice(0, 24)}…）`
  }
}

export const obsidianProvider: SyncProvider<ObsidianSyncConfig> = {
  target: 'obsidian',
  validateConfig: (config) =>
    config.vaultUri.startsWith('obsidian://')
      ? { ok: true }
      : { ok: false, message: 'vaultUri 必须以 obsidian:// 开头' },
  testConnection: async (config) => ({ ...NOT_IMPLEMENTED, message: `未连接：${configLabel(config)}` }),
  push: async (_payload: SyncPayload, config) => ({ ...NOT_IMPLEMENTED, message: `未推送：${configLabel(config)}` }),
}

export const notionProvider: SyncProvider<NotionSyncConfig> = {
  target: 'notion',
  validateConfig: (config) =>
    config.apiKey !== '' && config.databaseId !== ''
      ? { ok: true }
      : { ok: false, message: 'Notion 需要 apiKey 与 databaseId' },
  testConnection: async (config) => ({ ...NOT_IMPLEMENTED, message: `未连接：${configLabel(config)}` }),
  push: async (_payload: SyncPayload, config) => ({ ...NOT_IMPLEMENTED, message: `未推送：${configLabel(config)}` }),
}

export const feishuProvider: SyncProvider<FeishuSyncConfig> = {
  target: 'feishu',
  validateConfig: (config) =>
    config.webhookUrl.startsWith('https://')
      ? { ok: true }
      : { ok: false, message: 'webhookUrl 必须是 https 地址' },
  testConnection: async (config) => ({ ...NOT_IMPLEMENTED, message: `未连接：${configLabel(config)}` }),
  push: async (_payload: SyncPayload, config) => ({ ...NOT_IMPLEMENTED, message: `未推送：${configLabel(config)}` }),
}

export const SYNC_PROVIDERS = [obsidianProvider, notionProvider, feishuProvider] as const

export function getSyncProvider(target: SyncConfig['target']): SyncProvider | null {
  return SYNC_PROVIDERS.find((provider) => provider.target === target) ?? null
}
