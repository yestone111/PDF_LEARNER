/**
 * 依赖层级布局：从左到右，层内折行。
 *
 * X 轴 = 依赖层级（被依赖的排右边）；层内节点太多时**折成多列**，
 * 避免出现「一列几十个节点」的竖直高墙。
 * Y 轴 = 同层内按关联度排序后纵向排开。
 *
 * 纯函数、确定性；有环时环上节点统一放最后一层，不会卡死。
 */

export interface LayoutNode {
  readonly id: string
  readonly degree: number
  /** 椭圆长轴（宽度）。 */
  readonly width: number
  /** 椭圆短轴（高度）。 */
  readonly height: number
  readonly title: string
}

export interface LayoutEdge {
  readonly source: string
  readonly target: string
}

export interface LayoutOptions {
  /** 层与层之间的水平间距。 */
  readonly columnGap?: number
  /** 同一列内相邻节点的垂直间距。 */
  readonly rowGap?: number
  /** 同一层最多堆几个节点，超出折到右侧新列。 */
  readonly maxRowsPerLayer?: number
  /** 折列之间的水平间距。 */
  readonly foldGap?: number
}

export interface LayoutResult {
  readonly positions: ReadonlyMap<string, { x: number; y: number }>
  readonly layers: ReadonlyMap<string, number>
  readonly layerCount: number
}

export function layeredLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = {},
): LayoutResult {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const node of nodes) {
    indegree.set(node.id, 0)
    outgoing.set(node.id, [])
  }
  for (const edge of edges) {
    if (edge.source === edge.target) continue
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    if (outgoing.get(edge.source)?.includes(edge.target) === true) continue
    outgoing.get(edge.source)?.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }

  const layerOf = new Map<string, number>()
  for (const node of nodes) layerOf.set(node.id, 0)

  // Kahn 拓扑序：层号 = max(前置层号) + 1
  const queue: string[] = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
  queue.sort((a, b) => (byId.get(a)?.title ?? '').localeCompare(byId.get(b)?.title ?? ''))

  const pendingIn = new Map(indegree)
  const visited = new Set<string>()
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor]!
    if (visited.has(id)) continue
    visited.add(id)
    for (const next of outgoing.get(id) ?? []) {
      const candidate = (layerOf.get(id) ?? 0) + 1
      if (candidate > (layerOf.get(next) ?? 0)) layerOf.set(next, candidate)
      const remaining = (pendingIn.get(next) ?? 0) - 1
      pendingIn.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }

  const maxAssigned = Math.max(0, ...[...layerOf.values()])
  const orphans = nodes.filter((node) => !visited.has(node.id)).map((node) => node.id)
  if (orphans.length > 0) {
    for (const id of orphans) layerOf.set(id, maxAssigned + 1)
  }

  const layerCount = Math.max(0, ...[...layerOf.values()]) + 1
  const grouped = new Map<number, LayoutNode[]>()
  for (const node of nodes) {
    const layer = layerOf.get(node.id) ?? 0
    const bucket = grouped.get(layer) ?? []
    bucket.push(node)
    grouped.set(layer, bucket)
  }

  const columnGap = options.columnGap ?? 96
  const rowGap = options.rowGap ?? 30
  const maxRows = Math.max(1, options.maxRowsPerLayer ?? 4)
  const foldGap = options.foldGap ?? 28
  const positions = new Map<string, { x: number; y: number }>()

  let cursorX = 0
  for (const [layer, bucket] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    // 同层内：关联度高的排上面，标题作次级排序保证确定性
    bucket.sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title))

    const widest = Math.max(...bucket.map((node) => node.width))
    const tallest = Math.max(...bucket.map((node) => node.height))
    const step = tallest + rowGap

    // 折列：每列最多 maxRows 个，超出向右排新列
    const columnGroups: LayoutNode[][] = []
    for (let index = 0; index < bucket.length; index += maxRows) {
      columnGroups.push(bucket.slice(index, index + maxRows))
    }

    columnGroups.forEach((group, groupIndex) => {
      const x = cursorX + groupIndex * (widest + foldGap)
      const totalHeight = (group.length - 1) * step
      group.forEach((node, index) => {
        positions.set(node.id, {
          x: Math.round(x),
          y: Math.round(index * step - totalHeight / 2),
        })
      })
    })

    const layerWidth = columnGroups.length * widest + (columnGroups.length - 1) * foldGap
    cursorX += layerWidth + columnGap
  }

  return { positions, layers: layerOf, layerCount }
}
