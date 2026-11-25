/**
 * 抽取缓存（IndexedDB extractionCaches 表）。
 *
 * key = documentId:stage:chunkHash|global:promptVersion
 * 改 prompt 必须升 version —— 旧缓存自然失效，不做迁移、不猜语义。
 */

import { ExtractionCacheSchema, parseStrict } from '../../domain'
import { getDb } from '../../db/database'

import type { ExtractionCache, ExtractionPayload, ExtractionStage } from '../../domain'

export interface CacheKeyInput {
  readonly documentId: string
  readonly stage: ExtractionStage
  readonly chunkHash: string | null
  readonly promptVersion: string
}

export function makeCacheKey(input: CacheKeyInput): string {
  return [input.documentId, input.stage, input.chunkHash ?? 'global', input.promptVersion].join(':')
}

export async function readExtractionCache(key: string): Promise<ExtractionCache | null> {
  const found = await getDb().extractionCaches.get(key)
  if (found === undefined) return null
  const checked = parseStrict(ExtractionCacheSchema, found, 'ExtractionCache')
  if (!checked.ok) {
    // 损坏的缓存条目直接视为未命中，绝不把脏数据喂给下游
    console.warn('[cache] 缓存条目损坏，已忽略：', checked.message)
    return null
  }
  return checked.data
}

export interface WriteCacheInput {
  readonly key: string
  readonly documentId: string
  readonly stage: ExtractionStage
  readonly promptVersion: string
  readonly chunkId: string | null
  readonly chunkHash: string | null
  readonly rawResponse: string | null
  readonly payload: ExtractionPayload | null
  readonly status: 'success' | 'failed'
  readonly error: string | null
  readonly attempts: number
}

export async function writeExtractionCache(input: WriteCacheInput): Promise<void> {
  const timestamp = Date.now()
  const previous = await getDb().extractionCaches.get(input.key)

  const entry: ExtractionCache = {
    key: input.key,
    documentId: input.documentId,
    stage: input.stage,
    promptVersion: input.promptVersion,
    chunkId: input.chunkId,
    chunkHash: input.chunkHash,
    status: input.status,
    rawResponse: input.rawResponse,
    payload: input.payload,
    error: input.error,
    attempts: (previous?.attempts ?? 0) + input.attempts,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }

  const checked = parseStrict(ExtractionCacheSchema, entry, 'ExtractionCache')
  if (!checked.ok) throw new Error(checked.message)

  await getDb().extractionCaches.put(entry)
}

export async function listExtractionCaches(documentId: string): Promise<ExtractionCache[]> {
  return getDb().extractionCaches.where('documentId').equals(documentId).toArray()
}
