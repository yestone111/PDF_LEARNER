import { describe, expect, it } from 'vitest'

import { calibrateLevel, calibrateLevels } from './calibrateLevels'

const base = { title: '注意力机制', summary: '把查询和键做点积后加权求和', cognitiveLevel: 1 as const, unitKind: 'concept' as const }

describe('calibrateLevel（只升不降）', () => {
  it('摘要含因果/推论标记 → 至少 L3 推断', () => {
    const result = calibrateLevel({ ...base, summary: '因为对齐方式不同，因此需要位置编码' })
    expect(result.cognitiveLevel).toBe(3)
    expect(result.unitKind).toBe('inference')
  })

  it('标题含分类/组成/框架 → 至少 L4 组织', () => {
    expect(calibrateLevel({ ...base, title: '编码器的组成' }).cognitiveLevel).toBe(4)
    expect(calibrateLevel({ ...base, title: '整体架构' }).cognitiveLevel).toBe(4)
  })

  it('标题含总结/要点/结论 → 至少 L5 选择', () => {
    expect(calibrateLevel({ ...base, title: '本章要点' }).cognitiveLevel).toBe(5)
  })

  it('标题含依赖/相比 → 至少 L2 连接', () => {
    const result = calibrateLevel({ ...base, title: '多头注意力依赖点积注意力' })
    expect(result.cognitiveLevel).toBe(2)
    expect(result.unitKind).toBe('relation')
  })

  it('模型已给出更高层级时不降级', () => {
    expect(calibrateLevel({ ...base, title: '本章要点', cognitiveLevel: 5 }).cognitiveLevel).toBe(5)
    expect(calibrateLevel({ ...base, cognitiveLevel: 4 }).cognitiveLevel).toBe(4)
  })

  it('没有任何标记时保持原层级', () => {
    const result = calibrateLevel(base)
    expect(result.cognitiveLevel).toBe(1)
    expect(result.unitKind).toBe('concept')
  })

  it('calibrateLevels 批量保持顺序与长度', () => {
    const result = calibrateLevels([base, { ...base, title: '整体架构' }])
    expect(result).toHaveLength(2)
    expect(result[1]?.cognitiveLevel).toBe(4)
  })
})
