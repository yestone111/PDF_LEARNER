import { describe, expect, it } from 'vitest'

import { buildOutlineNodes, assembleOutlineTree, MAX_OUTLINE_NODES } from './outline'

import type { RawOutlineItem } from './outline'

const T0 = 1_700_000_000_000

function makeIds(prefix = 'ol'): () => string {
  let index = 0
  return () => `${prefix}-${index++}`
}

const PAGE_BY_DEST: Record<string, number | null> = {
  'section.1': 1,
  'section.2': 2,
  'section.3': 3,
  'subsection.3.1': 3,
  'subsection.3.2': 4,
  missing: null,
}

const resolver = async (dest: unknown): Promise<number | null> =>
  typeof dest === 'string' ? (PAGE_BY_DEST[dest] ?? null) : null

const paperOutline: RawOutlineItem[] = [
  { title: 'Introduction', dest: 'section.1', items: [] },
  { title: 'Background', dest: 'section.2', items: [] },
  {
    title: '3 Model Architecture',
    dest: 'section.3',
    items: [
      { title: '3.1 Encoder and Decoder Stacks', dest: 'subsection.3.1', items: [] },
      {
        title: '3.2 Attention',
        dest: 'subsection.3.2',
        items: [
          { title: '3.2.1 Scaled Dot-Product Attention', dest: 'subsection.3.2.1', items: [] },
        ],
      },
    ],
  },
]

describe('buildOutlineNodes', () => {
  it('保持三级层级、同级 order 与 level', async () => {
    const nodes = await buildOutlineNodes({
      documentId: 'doc-1',
      items: paperOutline,
      resolvePage: resolver,
      createId: makeIds(),
      timestamp: T0,
    })

    expect(nodes).toHaveLength(6)
    const roots = nodes.filter((node) => node.parentId === null)
    expect(roots.map((node) => node.title)).toEqual([
      'Introduction',
      'Background',
      '3 Model Architecture',
    ])
    expect(roots.map((node) => node.order)).toEqual([0, 1, 2])
    expect(roots.every((node) => node.level === 1)).toBe(true)

    const children = nodes.filter((node) => node.parentId === roots[2].id)
    expect(children.map((node) => node.title)).toEqual([
      '3.1 Encoder and Decoder Stacks',
      '3.2 Attention',
    ])
    expect(children.every((node) => node.level === 2)).toBe(true)

    const grandChildren = nodes.filter((node) => node.parentId === children[1].id)
    expect(grandChildren).toHaveLength(1)
    expect(grandChildren[0].level).toBe(3)
  })

  it('页码来自 dest 解析；解析失败必须为 null，不得编造', async () => {
    const nodes = await buildOutlineNodes({
      documentId: 'doc-1',
      items: [
        { title: 'A', dest: 'section.1', items: [] },
        { title: 'B', dest: 'missing', items: [] },
        { title: 'C', dest: { weird: true }, items: [] },
      ],
      resolvePage: resolver,
      createId: makeIds(),
      timestamp: T0,
    })
    expect(nodes.map((node) => node.page)).toEqual([1, null, null])
  })

  it('不得伪造重要度：predictedImportance 恒为 null、source 恒为 none', async () => {
    const nodes = await buildOutlineNodes({
      documentId: 'doc-1',
      items: paperOutline,
      resolvePage: resolver,
      createId: makeIds(),
      timestamp: T0,
    })
    for (const node of nodes) {
      expect(node.predictedImportance).toBeNull()
      expect(node.importanceSource).toBe('none')
      expect(node.graphBuilt).toBe(false)
    }
  })

  it('解析器抛异常时降级为 null，而不是让整棵树失败', async () => {
    const nodes = await buildOutlineNodes({
      documentId: 'doc-1',
      items: [{ title: 'A', dest: 'boom', items: [] }],
      resolvePage: async () => {
        throw new Error('dest 解析失败')
      },
      createId: makeIds(),
      timestamp: T0,
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0].page).toBeNull()
  })

  it('空白标题给占位文案，不产生空字符串标题', async () => {
    const nodes = await buildOutlineNodes({
      documentId: 'doc-1',
      items: [{ title: '   ', dest: 'section.1', items: [] }],
      resolvePage: resolver,
      createId: makeIds(),
      timestamp: T0,
    })
    expect(nodes[0].title).toBe('（未命名章节）')
  })

  it('节点总数受上限保护（病态 PDF 不会撑爆 IndexedDB）', async () => {
    const many: RawOutlineItem[] = Array.from({ length: MAX_OUTLINE_NODES + 50 }, (_, i) => ({
      title: `S${i}`,
      dest: 'section.1',
      items: [],
    }))
    const nodes = await buildOutlineNodes({
      documentId: 'doc-1',
      items: many,
      resolvePage: resolver,
      createId: makeIds(),
      timestamp: T0,
    })
    expect(nodes).toHaveLength(MAX_OUTLINE_NODES)
  })
})

describe('assembleOutlineTree', () => {
  it('按 parentId/order 还原成树', async () => {
    const nodes = await buildOutlineNodes({
      documentId: 'doc-1',
      items: paperOutline,
      resolvePage: resolver,
      createId: makeIds(),
      timestamp: T0,
    })
    const tree = assembleOutlineTree(nodes)
    expect(tree.map((entry) => entry.node.title)).toEqual([
      'Introduction',
      'Background',
      '3 Model Architecture',
    ])
    expect(tree[2].children[1].children[0].node.title).toBe('3.2.1 Scaled Dot-Product Attention')
  })

  it('乱序输入也能被 order 排好', () => {
    const base = {
      documentId: 'doc-1',
      parentId: null,
      level: 1,
      page: 1,
      predictedImportance: null,
      importanceSource: 'none' as const,
      graphBuilt: false,
      createdAt: T0,
      updatedAt: T0,
    }
    const tree = assembleOutlineTree([
      { ...base, id: 'b', order: 1, title: 'B' },
      { ...base, id: 'a', order: 0, title: 'A' },
    ])
    expect(tree.map((entry) => entry.node.title)).toEqual(['A', 'B'])
  })
})
