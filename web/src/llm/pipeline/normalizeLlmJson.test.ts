import { describe, expect, it } from 'vitest'

import { normalizeExtractionJson, normalizeRelationType } from './normalizeLlmJson'

describe('normalizeRelationType（宽进严出）', () => {
  it('英文受控值原样保留，且清掉多余的 label', () => {
    expect(normalizeRelationType('depends_on', '依赖')).toEqual({ relationType: 'depends_on', relationLabel: null })
  })

  it('中文标签映射成受控枚举', () => {
    expect(normalizeRelationType('依赖', null).relationType).toBe('depends_on')
    expect(normalizeRelationType('触发', null).relationType).toBe('triggers')
    expect(normalizeRelationType('属于', null).relationType).toBe('belongs_to')
    expect(normalizeRelationType('扩展', null).relationType).toBe('extends')
    expect(normalizeRelationType('实现', null).relationType).toBe('implements')
    expect(normalizeRelationType('对比', null).relationType).toBe('contrasts_with')
  })

  it('大写与连字符变体也能归一', () => {
    expect(normalizeRelationType('DEPENDS-ON', null).relationType).toBe('depends_on')
    expect(normalizeRelationType('Depends On', null).relationType).toBe('depends_on')
    expect(normalizeRelationType('belongs-to', null).relationType).toBe('belongs_to')
  })

  it('无法识别的类型降级为 custom，并保留原文为标签（不丢语义）', () => {
    const result = normalizeRelationType('inspired_by', null)
    expect(result.relationType).toBe('custom')
    expect(result.relationLabel).toBe('inspired_by')
  })

  it('custom 缺标签时给兜底标签', () => {
    expect(normalizeRelationType('custom', null).relationLabel).toBe('自定义')
  })
})

describe('normalizeExtractionJson', () => {
  const raw = {
    stage: 'chunk_extract',
    nodes: [
      { title: '  Attention  ', importance: '7', aliases: null, quote: null, page: '0' },
      { title: '', importance: 3 },
      42,
    ],
    edges: [
      { sourceTitle: 'A', targetTitle: 'B', relationType: '依赖', relationLabel: '强依赖' },
      { sourceTitle: '', targetTitle: 'B', relationType: 'depends_on' },
      { sourceTitle: 'A', targetTitle: 'B', relationType: 'inspired_by' },
    ],
  }

  it('标题裁空白、importance 夹到 1–5、空字段补成合法类型', () => {
    const result = normalizeExtractionJson(raw) as { nodes: Array<Record<string, unknown>> }
    expect(result.nodes).toHaveLength(1)
    const node = result.nodes[0]!
    expect(node.title).toBe('Attention')
    expect(node.importance).toBe(5)
    expect(node.aliases).toEqual([])
    expect(node.quote).toBe('')
    expect(node.page).toBeNull()
  })

  it('缺端点的边被丢弃，不补默认值', () => {
    const result = normalizeExtractionJson(raw) as { edges: Array<Record<string, unknown>> }
    expect(result.edges).toHaveLength(2)
    expect(result.edges[0]!.relationType).toBe('depends_on')
    expect(result.edges[0]!.relationLabel).toBeNull()
  })

  it('未知关系降级为 custom 且保留原文', () => {
    const result = normalizeExtractionJson(raw) as { edges: Array<Record<string, unknown>> }
    expect(result.edges[1]!.relationType).toBe('custom')
    expect(result.edges[1]!.relationLabel).toBe('inspired_by')
  })

  it('裸数组（节点列表）→ 包成对应 stage 的对象', () => {
    const result = normalizeExtractionJson([{ title: 'A' }], 'global_reduce') as {
      stage: string
      nodes: unknown[]
      edges: unknown[]
      merges: unknown[]
    }
    expect(result.stage).toBe('global_reduce')
    expect(result.nodes).toHaveLength(1)
    expect(result.edges).toEqual([])
    expect(result.merges).toEqual([])
  })

  it('缺 stage 时由调用方补上', () => {
    const result = normalizeExtractionJson({ nodes: [], edges: [] }, 'chunk_extract') as { stage: string }
    expect(result.stage).toBe('chunk_extract')
  })

  it('缺 nodes/edges 时补空数组（模型只回 merges 的情况）', () => {
    const result = normalizeExtractionJson({ merges: [] }, 'global_reduce') as {
      nodes: unknown[]
      edges: unknown[]
    }
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
  })

  it('字符串节点补成最小合法节点（标题不丢）', () => {
    const result = normalizeExtractionJson(['多头注意力'], 'chunk_extract') as {
      nodes: Array<{ title: string; importance: number; difficulty: number }>
    }
    expect(result.nodes[0]?.title).toBe('多头注意力')
    expect(result.nodes[0]?.importance).toBe(3)
  })

  it('global_reduce 缺 merges 时补空数组', () => {
    const result = normalizeExtractionJson({ stage: 'global_reduce', nodes: [], edges: [] }) as { merges: unknown[] }
    expect(result.merges).toEqual([])
  })

  it('merges 里的坏条目被丢弃', () => {
    const result = normalizeExtractionJson({
      stage: 'global_reduce',
      nodes: [],
      edges: [],
      merges: [{ canonical: 'Transformer', aliases: ['transformer 模型', 1] }, { aliases: [] }],
    }) as { merges: unknown[] }
    expect(result.merges).toEqual([{ canonical: 'Transformer', aliases: ['transformer 模型'] }])
  })
})
