import { describe, expect, it } from 'vitest'

import { planReduceBatches } from './reducePlan'

describe('planReduceBatches', () => {
  it('节点少时单批、不需要最终汇总', () => {
    const plan = planReduceBatches(30)
    expect(plan.batches).toHaveLength(1)
    expect(plan.batches[0]).toHaveLength(30)
    expect(plan.needsFinal).toBe(false)
    expect(plan.dropped).toBe(0)
  })

  it('正好等于批大小时仍单批', () => {
    expect(planReduceBatches(80).batches).toHaveLength(1)
  })

  it('超过批大小 → 分批 + 需要最终汇总', () => {
    const plan = planReduceBatches(150, { batchSize: 80, maxBatches: 3 })
    expect(plan.batches).toHaveLength(2)
    expect(plan.batches[0]).toHaveLength(80)
    expect(plan.batches[1]).toHaveLength(70)
    expect(plan.needsFinal).toBe(true)
  })

  it('超过容量时按上限截断并记录 dropped', () => {
    const plan = planReduceBatches(500, { batchSize: 80, maxBatches: 3 })
    expect(plan.batches).toHaveLength(3)
    expect(plan.dropped).toBe(500 - 240)
    const indexes = plan.batches.flat()
    expect(indexes).toHaveLength(240)
    expect(Math.max(...indexes)).toBe(239)
  })

  it('空输入不产生批次', () => {
    expect(planReduceBatches(0)).toEqual({ batches: [], needsFinal: false, dropped: 0 })
  })
})
