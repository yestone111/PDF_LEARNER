import { describe, expect, it } from 'vitest'

import { gateUnits, jaccard } from './unitGate'

import type { GateEdge, GateNode } from './unitGate'

function node(
  id: string,
  title: string,
  options: { level?: number; summary?: string; prior?: readonly string[] } = {},
): GateNode {
  return {
    id,
    title,
    summary: options.summary ?? '',
    cognitiveLevel: options.level ?? 1,
    priorKnowledge: options.prior ?? [],
  }
}

function edge(sourceId: string, targetId: string, relationType = 'depends_on'): GateEdge {
  return { sourceId, targetId, relationType }
}

describe('前缀连贯性', () => {
  it('依赖方向正确时零违规，顺序满足先修在前', () => {
    const nodes = [node('a', 'A'), node('b', 'B'), node('c', 'C')]
    const result = gateUnits(nodes, [edge('a', 'b'), edge('b', 'c')])
    expect(result.violations).toHaveLength(0)
    const order = result.order
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
  })

  it('循环依赖记为 violation（不会静默给出顺序）', () => {
    const nodes = [node('a', 'A'), node('b', 'B')]
    const result = gateUnits(nodes, [edge('a', 'b'), edge('b', 'a')])
    expect(result.violations.some((violation) => violation.kind === 'cycle')).toBe(true)
  })

  it('前置层级高于后继 → 记 level violation（前置必须先学）', () => {
    const nodes = [node('a', 'Advanced', { level: 5 }), node('b', 'Basic', { level: 1 })]
    const result = gateUnits(nodes, [edge('a', 'b')])
    expect(result.violations.some((violation) => violation.kind === 'level')).toBe(true)
  })

  it('belongs_to 不参与顺序判定（分类不是先后）', () => {
    const nodes = [node('detail', '细节', { level: 1 }), node('pillar', '总纲', { level: 5 })]
    const result = gateUnits(nodes, [edge('detail', 'pillar', 'belongs_to')])
    expect(result.violations).toHaveLength(0)
  })
})

describe('条件新颖性', () => {
  it('摘要几乎相同的两个单元 → 合并进更早那个，不丢弃', () => {
    const summary = '多头注意力把输入映射到多个子空间并行计算'
    const nodes = [node('a', 'Multi-Head Attention', { summary }), node('b', 'MultiHeadAttention', { summary })]
    const result = gateUnits(nodes, [])
    expect(result.mergedByNovelty.get('b')).toBe('a')
    expect(result.accepted).toEqual(['a'])
  })

  it('摘要差异足够大 → 两个都保留', () => {
    const nodes = [
      node('a', 'Attention', { summary: '把查询和键做点积再 softmax 加权求和' }),
      node('b', 'Positional Encoding', { summary: '给词向量加正弦位置信号以保留顺序' }),
    ]
    const result = gateUnits(nodes, [])
    expect(result.accepted).toHaveLength(2)
    expect(result.mergedByNovelty.size).toBe(0)
  })

  it('标题归一化重复也会被合并', () => {
    const nodes = [node('a', 'Transformer 模型'), node('b', 'transformer模型')]
    const result = gateUnits(nodes, [])
    expect(result.mergedByNovelty.size).toBe(1)
  })
})

describe('jaccard', () => {
  it('完全相同为 1，完全不同为 0', () => {
    expect(jaccard('注意力 机制 计算', '注意力 机制 计算')).toBe(1)
    expect(jaccard('注意力', '位置编码')).toBe(0)
  })

  it('空字符串不参与比较', () => {
    expect(jaccard('', '注意力')).toBe(0)
  })
})

describe('层级排序', () => {
  it('依赖允许时，就绪集合里层级最低的先出（贪心）', () => {
    // A(L1) 与 B(L5) 都无前置 → 先 A；C(L2) 依赖 B → 只能在 B 之后
    const nodes = [node('a', 'A', { level: 1 }), node('b', 'B', { level: 5 }), node('c', 'C', { level: 2 })]
    const result = gateUnits(nodes, [edge('b', 'c')])
    expect(result.order[0]).toBe('a')
    expect(result.order.indexOf('b')).toBeLessThan(result.order.indexOf('c'))
  })

  it('同层同深度时按层级低的先出现', () => {
    const nodes = [node('hi', '高', { level: 4 }), node('lo', '低', { level: 1 })]
    const result = gateUnits(nodes, [])
    expect(result.order[0]).toBe('lo')
  })
})
