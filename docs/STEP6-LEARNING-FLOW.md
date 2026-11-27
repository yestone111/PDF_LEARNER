# v1.2 交付：图谱优先学习流（知识对话框 · 知识点描述）

> 历史（v1.1，2026-11-20 用户口述）：
> 「使用者一般不需要切换到 PDF 原本界面，就跟着知识图学习；章节知识点展开后弹出对话框，摘录 PDF 重点原文；
> 在这个对话框内标注，原文也同步实现标注。」
>
> v1.2 变更（2026-11-25 用户口述）：
> ① 「点击知识图谱知识点之后，原文摘抄去掉，改成知识点描述」；
> ② 「点击之后，不相关的知识点暗下去，不相关的线也跟着暗下去」。

## 1. 交互变成什么样

```
打开应用 → 直接是「知识图谱」（PDF 收为第二个 Tab，保留）
点任意知识点 → 弹出学习对话框
   ├─ 标题 / 认知层级 / 单元类型 / 重要度 / 掌握状态（可切换）+ 锚点页码
   ├─ 知识点描述：一段话讲清「它是什么、解决什么问题」（抽取的 summary；按需分析可加长）
   │     └─ 空节点：显示「点击进一步分析」→ 调一次 node_enrich 补描述/先修/精细加工/自测
   ├─ 先修：学它之前应先掌握的概念
   ├─ 精细加工：类比 / 对比 / 为什么重要 / 常见误解
   ├─ 自测：先自己想，再展开答案要点（答案要点就是知识点描述）
   ├─ 图表：节点附近出现 Figure/Table caption 时，附 caption + 按 caption 估算的页面区域 PNG
   ├─ 知识点笔记 + 前置依赖 / 后置影响（点条目原地换到相邻知识点）
   └─ 不再展示「原文摘抄（±200 字、跨页分段）」，也不再在对话框内划选标注
底部：「跳到 PDF 原文」→ 切 PDF Tab、滚到锚点页并临时高亮原文（标注在 PDF 侧完成，同一条 Highlight 记录）
```

图谱侧（第 ② 条）：选中一个知识点后，**不相关的节点与连线一起变暗**（节点 0.18 / 连线 0.12 / 连线标签 0.15），
只保留「选中节点 + 它直接相连的上下游」这条亮带；点空白取消选中后全部恢复。

「学习路径」清单里的条目**只做高亮**（`selectNode`，不弹学习对话框）——想读详情就点图谱里的节点本身。
高亮同时会把该节点**平滑移到画布中心**（`FocusOnNode` 子组件用 `useReactFlow().setCenter`，保持当前缩放；
「减少动态效果」时动画时长归零）。章节速览里的可点关键词走同一套逻辑。
路径行与图谱节点共享同一份 `selectedNodeId`，所以两边选中态始终一致（`data-selected` 可断言）。

## 2. 关键技术实现

| 能力 | 文件 | 说明 |
| --- | --- | --- |
| 知识点描述 | `graph/NodeLearningDialog.tsx` | 正文取 `node.summary`；图表占位节点没有 summary 时回落到 `figure.caption`；空描述才显示「点击进一步分析」 |
| 按需补描述 | `llm/pipeline/enrich.ts` + `prompts/nodeEnrich.ts` | `node_enrich@1`：读该节点附近原文，重写 summary（≤120 字）并补先修/四问/自测；结果写回同一节点，不改图结构 |
| 图表摘抄 | `pdf/figureRender.ts` | caption 坐标 → 估算区域（上扩 35% 页高）→ pdf.js 渲染整页 → canvas 裁剪出 PNG；失败降级为文字提示 |
| 连线弱化 | `graph/GraphView.tsx` | 相关边 = 两端都在「选中节点 + 直接上下游」集合内；`style.opacity` + `labelStyle.opacity` + `labelBgStyle.fillOpacity` 一起降，边类名 `akn-edge-related / akn-edge-dimmed` 供验收断言 |
| 节点弱化 | `graph/KnowledgeNodeView.tsx` | 沿用 v1.1：`dimmed ? 0.18 : 1`；选中节点有 accent 外环 |
| 全文文本索引 | `pdf/textIndex.ts` | 仍用于「锚点定位 / 图表 caption 查找 / PDF 侧标注”，对话框不再渲染摘录 |

## 3. 验收记录（19 项通过 + 1 项按数据跳过）

`node scripts/step6-learning-dialog.mjs`（mock 上游，真实上传 15 页论文并抽取）：

```
✅ 默认打开就是知识图谱视图（PDF 保留为另一个 Tab） — graph=true
✅ 图谱里有可学习的节点 — nodes=12
✅ 点节点 → 打开学习对话框
✅ 对话框显示知识点标题
✅ 对话框有「知识点描述」区块
✅ 描述有正文（不是空壳） — chars=57
✅ 描述是概念解释而不是原文摘抄（没有页码分段） — excerptBody=false, segments=0
✅ 划选标注条已随摘抄一起移除
✅ 描述不是标题的复读（内容确实解释了知识点）
✅ 学习骨架仍在（先修 / 笔记输入）
⏭️  描述下方显示别名 — 该节点的抽取结果没有别名
✅ 节点带图表块（caption + 区域）
✅ 图表区域渲染成 PNG（按 caption 估算区域） — data:image/png
✅ 点上下游条目可在对话框内继续学习
✅ 对话框里可以切换掌握状态 — unmastered → mastered
✅ 知识点笔记可保存
✅ 笔记写入 IndexedDB（notes 表） — rows=1
✅ 点「跳到 PDF 原文」关闭对话框并切到 PDF
✅ 锚点页在 PDF 里存在
✅ 页面全程无未捕获异常
通过 19 项，失败 0 项，跳过 1 项
```

连线弱化由 `node scripts/graph-semantics-check.mjs` 的 6 条新增断言覆盖（几何/透明度都读真实 computed style）：

```
✅ 选中节点后每条连线都归入「相关 / 不相关」 — 21 条连线
✅ 与选中节点相连的连线保持高亮 — 选中节点 degree=2, related=3, opacity=1
✅ 不相关连线一起暗下去（透明度 ≤ 0.2） — dimmed=18/21, opacity=0.12
✅ 不相关连线的标签也跟着暗（不发亮地悬着） — 0.15
✅ 选中节点本身保持高亮 — opacity=1
✅ 不相关节点暗下去（与连线同步） — 亮 3 / 暗 9 / 共 12
✅ 点空白取消选中后，连线全部恢复亮度
```

截图：`docs/learning-dialog.png`（对话框）、`docs/graph-focus.png`（选中后的弱化带）。

## 4. 回归

| 脚本 | 结果 | 说明 |
| --- | --- | --- |
| `step3-check.mjs` | 20/20 | 对话框仍展示上游/下游与掌握切换 |
| `step4-check.mjs` | 16/16 | 「定位」仍会打开学习对话框 |
| `step5-check.mjs` | 16/16 | 读对话框标题后关闭 |
| `flash-check.mjs` | 8/8 | 「跳到 PDF 原文」下划线闪烁链路未受影响 |
| `learning-path-check.mjs` | 13/13 | 「空节点 → 点击进一步分析」改为按「没有描述」判定 |
| `manual-check.mjs` | 8/8（1 跳过） | 手册 PDF 重建后：目录/跳页/抽取/知识点描述 |
| `outline-encoding-check.mjs` | 8/8 | 目录标题改为读 `data-outline-title`（行内还有编号/「章」徽标，不能再用整行 textContent） |
| `graph-semantics-check.mjs` | 18/18 | 新增连线弱化断言 |
| `graph-ellipse-check.mjs` | 16/16 | 椭圆/角标未回归 |

`typecheck` / 单测（255 个）全绿。

## 5. 已知限制

- 描述长度有限：抽取阶段 summary ≤ 40 字，按需分析 ≤ 120 字；更长内容请用 AI 伴读或读原文。
- 对话框内不再能划选标注（原文入口改为「跳到 PDF 原文」）；标注仍在 PDF 侧完成，与图谱节点同一条 Highlight 记录。
- 图表区域仍是**按 caption 估算**的（只有 caption 坐标，没有图形本体框），真正的图片语义识别仍属 P1。
- 弱化规则是「两端都在选中节点及其直接上下游内才算相关」：当选中一个中心/根节点时，几乎所有节点都是相关，看起来就像没弱化 —— 这是数据形状，不是 bug。

## 6. v1.3 修复：图表/表格知识点跳不动原文

用户反馈：图谱里 `Table N` / `Figure N` 这类知识点点了跳不到原文。

根因链条（三处都补了）：

1. **锚点**：图表节点通常只有 caption、`quote` 为空，`toKnowledgeNode` 直接判 `anchor = null`。
   现在改用 caption 去原文定位（`locateQuote(caption, figure.page)`），命中就得到真实页码与可画下划线的引文。
2. **继承**：reduce 阶段常只回标题，全局图表节点的 `figure` 会丢。`inheritUnderstandingFields` 现在把 `figure`
   一起继承（并且改为在**全部同名候选**里找有 figure 的那个，避免挑到「有精细加工但没 figure」的节点）；
   同时修掉一个隐藏 bug：`enrichedGlobalNodes` 以前算出后就被丢弃（继承结果从没落库），
   `calibratedChapterNodes` 也没落库 —— 现在都真正写进图里。
3. **跳转兜底**：`jumpTargetOf()`（纯函数，4 个单测）定义目标解析：anchor 优先，其次 `figure.page + caption`，
   都没有才提示无页码。历史数据（`anchor=null` + 只有 figure）不需要重新抽取也能跳。

顺带：`findCaption` 不再要求 caption 出现在行首（PDF 文本层常把整页拼成一行），图摘抄因此不再莫名跳过。

验收：`node scripts/table-jump-check.mjs`（14 项）——新抽取路径 + 「注入一条无锚点旧数据再刷新」的旧数据路径都走一遍。

## 7. v1.3.1 修复：短中文术语跳原文没有下划线

用户反馈：知识点「零拷贝卸载」点「跳到 PDF 原文」只跳页，没有下划线闪烁。

根因两处：

1. `flashQuoteInPage` 用 `quote.length < 6` 一刀切判「引文太短、不可定位」，
   而「零拷贝卸载」是 5 个汉字 —— 区分度完全够，却被直接拒掉。
   修法：改成**权重**判断（CJK 记 2、其它记 1，阈值 6），`quoteWeight()` / `isSearchableQuote()`
   带单测；长中文引文的前缀命中阈值也一并按权重算。
2. 降级提示写了但**渲染不出来**：`setStatus('ready', '…未能逐字匹配…')` 把消息塞进 `error` 字段，
   而 `PanePlaceholder` 只在「没有 PDF」时渲染 —— 用户什么都看不到。
   修法：PDF 头部新增 `pdf-flash-hint` 提示条（5 秒自动消失），三种降级各有明确文案：
   引文太短 / 未能逐字匹配 / 该页没有可选文本层；页面始终至少有一次整页闪烁。

验收：`node scripts/flash-short-quote-check.mjs`（8 项，往 IndexedDB 注入 4 字与 2 字引文两条节点）：
4 字 → 画出下划线（高 ≤ 4px）；2 字 → 不画框、整页闪、头部提示说明原因。
旧用例 `flash-check.mjs` 仍 8/8（长英文引文不受影响）。

## 8. v1.3.2 修复：没有引文锚点的知识点「点了没反应」

用户反馈：v1.3.1 之后「零拷贝卸载」依旧没有下划线、也没有琥珀色提示。

排查结论：这一类节点**根本没有 anchor**（抽取时模型给的 quote 在原文里定位不到，或没给），
于是 `jumpTargetOf()` 返回 null → 跳转按钮是禁用态 / 直接 return，连页面都不跳，
自然也没有闪烁和提示。v1.3.1 只修了「有引文但太短」这一种。

修法（三级目标解析，全部走同一条 `jumpNodeToPdf`）：

1. `anchor`（页码 + 逐字引文）；
2. `figure.page + caption`（图表/表格节点）；
3. **新增**：用标题 / 别名在 PDF 全文索引里搜（`pdf/textSearch.ts` + `pdf/jumpSearch.ts`）——
   找到就跳到那一页并给匹配到的**原文片段**画下划线；
   搜不到就切到 PDF 并给出「没能在 PDF 里找到「…」的原文」提示（不猜页码）。

配套：

- 跳转按钮改为「只要打开了 PDF 就能点」，底部文案「无引文锚点：按标题在 PDF 中搜索」；
- 标题兜底会**跳过目录页**（一页出现 ≥3 个章节标题即判为目录页），
  否则「界面导览」会命中目录里的同名条目跳到第 2 页，而不是正文第 6 页；
- 提示条改放 `documentStore.flashHint`（PdfPane 渲染、5 秒自动清空），
  `jumpNodeToPdf` 与降级分支都能设置它。

验收：`node scripts/flash-short-quote-check.mjs`（16 项，注入 4 条节点）：
4 字引文必须画框、2 字引文必须降级提示、无锚点标题必须搜到并画框（且落在正文页 6）、
标题不存在必须提示「没能在 PDF 里找到」。单测新增 `textSearch.test.ts` / `jumpSearch.test.ts`。

## 9. v1.3.3：掌握状态三态（未掌握 / 已掌握 / 有疑问）+ 学习路径同步标记

用户需求：① 图谱里点成绿色后，学习路径对应条目也要有打勾；② 增加「有疑问」状态，点击后变黄色。

- 领域：`MasteryState` 增加 `doubt`；`MASTERY_LABELS` / `MASTERY_NEXT` 统一文案与点击顺序
  （**未掌握 → 已掌握 → 有疑问 → 未掌握**，保证「点一下 = 已掌握」的旧行为不变）。
- 视觉：`nodeStyle.ts` 每个难度档新增黄色 ramp（1 最浅 `#fde047` → 5 最深 `#a16207`），
  只换色相、字号/尺寸不变；色相 35°–60° 有单测守着。
- 学习路径：`path-item` 增加 `data-mastery` 与行尾标记（`✓` 绿 / `?` 黄 / 未掌握不显示），
  与图谱共用同一份 store 状态，点节点立刻联动。
- 笔记卡片与 Markdown 导出同步三态文案；章节掌握度仍只把 `mastered` 计入（有疑问 = 还没掌握）。
- 对话框头部显示当前状态，按钮文案变成「标为<下一个状态>」。
- 验收：`graph-semantics-check` 扩到 25 项（点一次绿+路径 ✓、再点黄+路径 ?、再点红+标记消失、色相断言），
  单测 285 个（nodeStyle 黄色 ramp、chapterProgress「有疑问不算已掌握」）。
