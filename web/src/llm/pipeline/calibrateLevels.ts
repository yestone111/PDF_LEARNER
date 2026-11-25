/**
 * 认知层级校准（确定性，不额外调用模型）。
 *
 * 真实实测发现模型偏保守：大量单元被判成 L1（定位），而「连接/推断/组织」偏少。
 * 这里用**可解释的语篇标记**做单向校准（只升不降）：
 *   - 标题含「分类/组成/框架/流程/步骤…」→ 至少 L4（组织）
 *   - 标题含「总结/要点/关键/结论…」→ 至少 L5（选择）
 *   - 标题含「依赖/基于/相比…」→ 至少 L2（连接）
 *   - 摘要含因果/推论标记（因此/所以/从而/说明…）→ 至少 L3（推断）
 *
 * 为什么只升不降：模型给出更高层级时说明它读到了更多操作，不该被规则压低。
 * 规则可测、可解释，且不增加抽取耗时（不做第二次模型调用）。
 */

import { UNIT_KIND_BY_LEVEL } from '../../domain/enums'
import type { CognitiveLevel, UnitKind } from '../../domain/enums'

export interface LevelCandidate {
  readonly title: string
  readonly summary: string
  readonly cognitiveLevel: CognitiveLevel
  readonly unitKind: UnitKind
}

const RELATION_MARKERS = /依赖|基于|相比|对比|关系|前置|depends|related|contrast/i
const INFERENCE_MARKERS = /因此|所以|从而|可见|这说明|由此|导致|意味着|therefore|thus|hence|implies/i
const STRUCTURE_MARKERS = /分类|类型|组成|包含|框架|结构|架构|流程|步骤|体系|层级|taxonomy|framework|architecture|pipeline|components/i
const KEYPOINT_MARKERS = /总结|要点|关键|结论|核心思想|归纳|一句话|summary|key ?point|takeaway/i

function atLeast(level: CognitiveLevel, minimum: CognitiveLevel): CognitiveLevel {
  return (level >= minimum ? level : minimum) as CognitiveLevel
}

export function calibrateLevel(node: LevelCandidate): LevelCandidate {
  let level = node.cognitiveLevel
  if (RELATION_MARKERS.test(node.title)) level = atLeast(level, 2)
  if (INFERENCE_MARKERS.test(node.summary)) level = atLeast(level, 3)
  if (STRUCTURE_MARKERS.test(node.title)) level = atLeast(level, 4)
  if (KEYPOINT_MARKERS.test(node.title)) level = atLeast(level, 5)
  if (level === node.cognitiveLevel) return node
  return { ...node, cognitiveLevel: level, unitKind: UNIT_KIND_BY_LEVEL[level] }
}

export function calibrateLevels<T extends LevelCandidate>(nodes: readonly T[]): T[] {
  return nodes.map((node) => calibrateLevel(node) as T)
}
