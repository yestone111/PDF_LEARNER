# 拆解方法：四套理论 → 具体实现

> 目标：把「读到哪、学到哪」从「模型自由发挥」变成**有认知约束的拆解流水线**。
> 本文只做设计，不改代码；末尾列出需要拍板的问题。

## 0. 理论核实结果（先说清楚哪些是查到的）

| 关键词 | 核实结果 |
| --- | --- |
| 认知负荷理论 CLT | ✅ Sweller 体系（内在/外在/相关负荷），成熟且可直接工程化 |
| SCoP 五级渐进技能 | ✅ 真实存在：[SCOP: Evaluating the Comprehension Process of LLMs from a Cognitive View](https://aclanthology.org/2025.acl-long.852/)（ACL 2025）。**注意**：它是「阅读理解过程的五项技能」，不是「技能等级」：<br>定位 Locating（单句）→ 推断 Inferring（多句）→ 解释 Interpreting = 连接 Connecting / 组织 Organizing / 选择 Selecting。三层级、五技能 |
| PICA 前缀连贯性 / 条件新颖性 | ⚠️ 未找到公开对应框架（同名 PICA 是 Principal Information Component Analysis，与本主题无关）。下文按你给的两条性质**自行定义**为确定性判据，可替换 |
| 图式理论 + 精细加工 | ✅ Ausubel 先行组织者 / 锚定；精细加工（elaborative interrogation、self-explanation、类比与对比） |

## 1. 总流程（在现有流水线上的改造点）

```
PDF
 └─① 切块（CLT 约束）           ← 改 chunking：不切「定义-例子」，控制每块新概念数
     └─② 单元抽取（SCoP 五技能） ← 改 prompt+schema：每个节点带 cognitiveLevel 与单元三段
         └─③ 质量闸门（PICA）    ← 新增确定性校验：前缀连贯 + 条件新颖，不过闸合并/上报
             └─④ 锚定（图式+精细加工） ← 新增字段：priorKnowledge / elaboration
                 └─⑤ 汇总搭总纲（已在 global-reduce@6） ← 保持，按语义归属不按章节
                     └─⑥ 学习路径视图（新增） ← 按 cognitiveLevel + 依赖拓扑排序
```

## 2. CLT：约束「切多细、切在哪」

**目标**：不增加**外在负荷**（extraneous），把**内在负荷**控制在可学区间。

| CLT 效应 | 实现动作 | 落点 |
| --- | --- | --- |
| 内在负荷（intrinsic） | 每块**新概念 ≤ 6 个**；超过则要求模型合并同义概念，或二次切块（按段落边界） | `pipeline/chunking.ts` + prompt 约束 |
| 分割注意（split-attention） | 「定义—例子」「图—图注」不能被切到两块：切块后做**配对修复**（若块尾出现 `例如/比如/for example` 且下一块开头是例子，向后合并） | `chunking.ts` 新增 `repairSplitAttention()` |
| 冗余（redundancy） | 同一概念在多块重复：合并节点（已有 `merges`），summary 取信息量最大的一条；相同 quote 只留一条 | `merge.ts`（已部分具备）+ 去重规则 |
| 信号化（signaling） | 标题统一为术语短句（≤24 字），关系只用受控词表（已有），单元类型显式标注 | prompt（已有 + 新增 level） |
| 相关负荷（germane） | 每个单元附「先修 → 本例 → 自测」三段，促发自解释 | 新增 schema 字段 |

**可测指标**（加进抽取结果统计）：每块概念数、块内跨页次数、前置缺失率。

## 3. SCoP：给拆解单元定义「认知操作类型 + 排序层级」

五技能 → 单元类型（`unitKind`）+ 层级（`cognitiveLevel` 1–5）：

| 级 | SCoP 技能 | 单元在问什么 | 单元类型 | 判据（可由模型+确定性校验） |
| --- | --- | --- | --- | --- |
| 1 | Locating 定位 | 这是什么？ | `concept` | 有定义句 / 术语首次出现 |
| 2 | Connecting 连接 | 和谁有关？ | `relation` | 至少一条指向已出现节点的边 |
| 3 | Inferring 推断 | 多句合起来说明什么？ | `inference` | 依赖 ≥2 个前置单元 |
| 4 | Organizing 组织 | 这一组怎么归类？ | `structure` | 有 ≥2 个子项的集合/分类 |
| 5 | Selecting 选择 | 最关键的是哪句？ | `keypoint` | 指向已有单元的摘要/要点 |

**排序约束**（可确定性校验）：沿 `depends_on` 边，前置单元的 `cognitiveLevel` **不得高于**后继单元。
违反 → 标记 `levelViolation`，由一次 LLM 修复调用改正，仍失败则按拓扑序重排并提示。

**阅读顺序**：`cognitiveLevel` 升序 → 同层按依赖深度 → 再按页码。这就是「① 全文档总览」从左到右的顺序。

## 4. PICA：单元质量闸门（自行定义，可替换）

对每个待入图单元 `u`，在「已接受前缀 P」上判定：

1. **前缀连贯性 prefix coherence**
   `prerequisites(u) ⊆ P`：它的所有前置知识点必须已经出现在前面。
   实现：建图后做拓扑排序；任何边违反「源在前」即不通过。
   失败处理：把缺失前置**补进队列**（从原文找该前置的定义块），或降级为「待补」。
2. **条件新颖性 conditional novelty**
   相对 P 必须有 ≥1 个新增：新概念 / 新关系 / 新条件限制。
   实现（确定性）：归一化标题去重 + `(source, target, type)` 关系去重 + summary 的 token Jaccard ≤ 0.85。
   新颖性 = 0 → **合并**进已有节点（不是丢弃），并在统计里记 `mergedByNovelty`。
3. 闸门结果必须**可见**：抽取结果里返回 `gated: { passed, merged, skipped, reasons[] }`，UI 展示「合并 X 个 / 跳过 Y 个」。

> 如果这两个词出自某篇论文/产品文档，把出处给我，我按其原始定义替换实现（特别是新颖性的阈值与度量）。

## 5. 图式理论 + 精细加工：把新概念锚到读者已有结构

| 概念 | 实现 |
| --- | --- |
| 图式锚定（schema anchoring） | 每个单元新增 `priorKnowledge: string[]`（≤3）：**读者应先掌握什么**。优先引用图谱中已存在的节点 → 自动生成 `depends_on` 边（语义锚定，不按章节） |
| 先行组织者（advance organizer） | 每个总纲节点在打开学习对话框时，先给一句「本章要解决的问题」，再展开细节 |
| 精细加工（elaboration） | 每个单元新增 `elaboration`：`analogy`（类比）、`contrast`（对比/反例）、`why`（为什么重要）、`misconception`（常见误解） |
| 自解释（self-explanation） | 学习对话框追加「用一句话解释它」输入框，保存进笔记（可选，不强制） |

**找不到锚点**时：标 `anchorMissing`，UI 提示「先学 X」（X 为前置总纲），不编造读者已知。

## 6. 需要改的文件与工作量

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 类型/校验 | `domain/types.ts`、`schemas.ts` | 节点加 `cognitiveLevel / unitKind / priorKnowledge / elaboration` |
| 切块 | `llm/pipeline/chunking.ts` | 分割注意修复 + 每块概念数上限 |
| prompt | `llm/prompts/chunkExtract.ts` | 五技能分类规则 + 三段式 + 精细加工字段；版本升 @6 |
| 归一化 | `pipeline/normalizeLlmJson.ts` | level 夹到 1–5、非法 kind → concept |
| 闸门 | 新 `pipeline/unitGate.ts` | 前缀连贯 + 条件新颖（纯函数 + 单测） |
| 汇总 | `prompts/globalReduce.ts` | 输入带上 level/unitKind，总纲优先 |
| UI | `graph/NodeLearningDialog.tsx` | 显示单元类型、先修 chips、精细加工四问、闸门统计 |
| 视图 | `graph/GraphView.tsx` | 可选「按学习路径」排序（level → 拓扑） |

**里程碑**（每步可独立验收）：
- A：schema + prompt + 归一化（单测覆盖分类与字段）
- B：unitGate 纯函数 + 抽取结果统计 + UI 展示
- C：学习路径视图
- D：真实手册跑通 + 调 prompt

## 7. 实施状态（2026-11-20 已落地 A/B/C）

| 计划项 | 状态 | 落点 |
| --- | --- | --- |
| 认知层级 / 单元类型 / 先修 / 精细加工字段 | ✅ | `domain/enums.ts`（COGNITIVE_LEVELS、UNIT_KINDS）、`types.ts`、`schemas.ts` |
| prompt 五技能分类 + 层级单调 + 图式锚定 | ✅ | `prompts/chunkExtract.ts`（@6）、`prompts/globalReduce.ts`（@7） |
| 归一化（层级夹取、类型回落、先修/四问清洗） | ✅ | `pipeline/normalizeLlmJson.ts` |
| 前缀连贯 + 条件新颖闸门 | ✅ | `pipeline/unitGate.ts`（11 个单测） |
| 全局节点继承章节节点的先修/精细加工 | ✅ | `pipeline/inherit.ts`（4 个单测） |
| 学习路径清单（层级贪心 + 拓扑） | ✅ | `graph/GraphView.tsx` `learning-path` |
| 节点层级徽标 / 对话框先修与四问 | ✅ | `KnowledgeNodeView.tsx`、`NodeLearningDialog.tsx` |
| 闸门统计可见 | ✅ | `graph-gate` chip（合并数 / 违规数） |
| 三段式里的「自测题」 | ✅ | `selfCheck` 字段 + 对话框「自测（先想再展开）」；chunk 与 reduce 两阶段都会写 |
| 分割注意修复（定义-例子不切两半） | ✅ | `chunking.ts` `repairSplitAttention`（同章节内合并，超 1.5× 预算不合并，5 个单测） |
| 认知层级校准 | ✅ | `calibrateLevels.ts`：语篇标记单向提升（只升不降），7 个单测，不增加模型调用 |
| 零边重试 | ✅ | reduce 输出 0 边时追加一次「必须补关系」的重试（仍走 zod，不伪造） |
| 目录退出结构划分 | ✅ | reduce 不再接收目录/章节；chunk prompt 不再带 outlineTitle（prompt 升到 @9） |
| 大文档两阶段汇总 | ✅ | `reducePlan.ts`：>80 节点分批、最终汇总；最终失败保留批次结果；超时 90s→300s（5 个单测 + 2 个流水线集成测试） |
| 目录不是知识点 | ✅ | 与目录标题同名的节点在全局/章节两条路径都被排除（`outlineFilter.ts`，4 个单测）；不再生成「章节根节点」 |
| 空节点按需分析 | ✅ | `node-enrich@1` + `pipeline/enrich.ts` + 对话框「点击进一步分析」（3 个单测） |

**为什么层级要校准**：真实实测模型偏保守，第一次只给出 L1/L4/L5。用「因此/所以 → L3」「标题含分类/组成 → L4」
这类**可解释的语篇标记**做单向提升，不额外调用模型、不增加耗时；模型给更高层级时永不压低。

**真实模型实测**：
- 手册（473s）：12 节点 / 6 条边（含 belongs_to）、层级 L1/L4/L5、先修与精细加工可见、学习路径 12 步；
- 手册（含零边重试那次，>10 分钟）：脚本超时，未拿到完整结果 —— 抽取耗时波动大，建议在本机跑；
- 2 页探针（快）：4 节点 / 3 条边（依赖/对比/属于）、层级 L5/L2/L4、自测题可见。

**已知波动**：同一份手册不同次运行，边数在 0–13 之间波动；0 边时会触发一次「必须补关系」重试，
仍可能补不出来（模型对说明性文档的关系判断偏保守）。这不是数据造假，而是模型输出本身的波动，需要在 prompt 上继续收紧。

## 8. 待你确认的问题

1. **SCoP 的用法**：我按「五技能 = 单元认知操作类型 + 1–5 排序层级」来映射（上表）。
   但 SCoP 原文是**阅读理解评测**的五个技能，不是「技能等级」。你要的是这个映射，还是 Dreyfus 新手→专家的五级？
2. **PICA 出处**：有论文/文档链接吗？没有的话就用第 4 节的自定义判据。
3. **新颖性阈值**：宁可多留（召回优先，图更全）还是严格去重（精度优先，图更干净）？
4. **三段式是否强制**：每个单元都要「先修/本例/自测」会显著增加 token 与抽取时长（当前 15 页 ≈ 6 分钟），只在总纲层强制、细节层可选？
