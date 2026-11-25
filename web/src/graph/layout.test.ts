import { describe, expect, it } from 'vitest'

import { layeredLayout, type LayoutEdge, type LayoutNode } from './layout'

function node(id: string, degree = 1, width = 120, height = 60): LayoutNode {
  return { id, degree, width, height, title: id }
}

function layersOf(edges: LayoutEdge[], nodes: LayoutNode[]): Map<string, number> {
  return new Map(layeredLayout(nodes, edges).layers)
}

describe('layeredLayout：从左到右按依赖排列', () => {
  it('A → B → C：三层，X 单调递增', () => {
    const nodes = [node('A'), node('B'), node('C')]
    const edges: LayoutEdge[] = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
    ]
    const result = layeredLayout(nodes, edges)
    expect(result.layers.get('A')).toBe(0)
    expect(result.layers.get('B')).toBe(1)
    expect(result.layers.get('C')).toBe(2)
    const xs = ['A', 'B', 'C'].map((id) => result.positions.get(id)?.x ?? 0)
    expect(xs[0]!).toBeLessThan(xs[1]!)
    expect(xs[1]!).toBeLessThan(xs[2]!)
    expect(result.layerCount).toBe(3)
  })

  it('菱形依赖：汇聚节点取最长路径（A→B→D 与 A→C→D）', () => {
    const nodes = [node('A'), node('B'), node('C'), node('D')]
    const edges: LayoutEdge[] = [
      { source: 'A', target: 'B' },
      { source: 'A', target: 'C' },
      { source: 'B', target: 'D' },
      { source: 'C', target: 'D' },
    ]
    const layers = layersOf(edges, nodes)
    expect(layers.get('A')).toBe(0)
    expect(layers.get('B')).toBe(1)
    expect(layers.get('C')).toBe(1)
    expect(layers.get('D')).toBe(2)
  })

  it('依赖更深的节点排得更靠右', () => {
    const nodes = [node('X'), node('Y')]
    const deep: LayoutEdge[] = [
      { source: 'X', target: 'Y' },
    ]
    const result = layeredLayout(nodes, deep)
    expect(result.positions.get('X')!.x).toBeLessThan(result.positions.get('Y')!.x)
  })

  it('孤立节点放在第 0 层，不报错', () => {
    const result = layeredLayout([node('only')], [])
    expect(result.layers.get('only')).toBe(0)
    expect(result.layerCount).toBe(1)
  })

  it('环不会让布局卡死，环上的节点放最后一层', () => {
    const nodes = [node('A'), node('B'), node('C')]
    const edges: LayoutEdge[] = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'B' },
    ]
    const result = layeredLayout(nodes, edges)
    expect(result.positions.size).toBe(3)
    expect(result.layers.get('A')).toBe(0)
  })

  it('自环与指向不存在节点的边被忽略', () => {
    const nodes = [node('A')]
    const result = layeredLayout(nodes, [
      { source: 'A', target: 'A' },
      { source: 'A', target: 'ghost' },
    ])
    expect(result.layers.get('A')).toBe(0)
  })

  it('确定性：同一输入两次布局结果完全一致', () => {
    const nodes = [node('B', 2), node('A', 2), node('C', 1)]
    const edges: LayoutEdge[] = [
      { source: 'A', target: 'C' },
      { source: 'B', target: 'C' },
    ]
    const first = layeredLayout(nodes, edges)
    const second = layeredLayout(nodes, edges)
    for (const id of ['A', 'B', 'C']) {
      expect(first.positions.get(id)).toEqual(second.positions.get(id))
    }
  })

  it('同层内按关联度从高到低排序（上方＝度更高）', () => {
    const nodes = [node('low', 1), node('high', 9)]
    const result = layeredLayout(nodes, [])
    expect(result.positions.get('high')!.y).toBeLessThan(result.positions.get('low')!.y)
  })

  it('层内节点过多时折成多列，而不是堆成一根竖线', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => node(id))
    const result = layeredLayout(nodes, [], { maxRowsPerLayer: 4 })
    const ys = nodes.map((item) => result.positions.get(item.id)!.y)
    const xs = nodes.map((item) => result.positions.get(item.id)!.x)
    // 6 个节点、每列最多 4 → 两列；纵向最多 4 个不同 y
    expect(new Set(xs).size).toBe(2)
    expect(new Set(ys).size).toBeLessThanOrEqual(4)
  })

  it('层与层之间有水平间距（不会叠在一起）', () => {
    const nodes = [node('A'), node('B')]
    const result = layeredLayout(nodes, [{ source: 'A', target: 'B' }], { columnGap: 100 })
    expect(result.positions.get('B')!.x - result.positions.get('A')!.x).toBeGreaterThanOrEqual(100)
  })
})
