# Step 3 交付：LLM 代理 + map-reduce 抽取 + 两级图谱

> 验收要求：真实多页 PDF 跑通完整抽取；断网/重复进入章节读缓存不重复调用；篡改上游返回验证 zod 拦截与 failed 状态；掌握勾选红绿深浅切换正确。
> **本期没有 DeepSeek key**，因此真实模型调用未验证；用本地 mock 上游（显式标识、可统计调用次数）验证整条流水线。这不等于「已跑通真实 DeepSeek」。

## 1. 落地内容

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 代理 | `server/src/llm/{client,errors,routes,mock}.ts` | 注入 key、90s 超时、最多 2 次指数退避（300ms→900ms）、状态码归一化、`hono/body-limit` 413、SSE 透传 |
| 代理端点 | `POST /api/llm/chat`（SSE）、`POST /api/llm/extract`、`GET /api/llm/status`、`GET /api/llm/mock-stats` | 密钥只在服务端；未配 key 且非 mock 时返回 503，**绝不伪造结果** |
| prompt | `web/src/llm/prompts/{chunkExtract,globalReduce,jsonRepair,index}.ts` | 每个模板带 `version`，参与缓存 key |
| 客户端 | `web/src/llm/client.ts` | 前端唯一出网口，只打同源 `/api/llm/*` |
| 切块 | `llm/pipeline/chunking.ts` | 按章节对齐，超长章节按页切；token 估算宁可高估 |
| 缓存 | `llm/pipeline/cache.ts` | key = `docId:stage:chunkHash｜global:promptVersion`；损坏条目视为未命中 |
| 合并 | `llm/pipeline/merge.ts` | titleNorm 完全相等 或 LLM merges 显式声明；不做模糊合并 |
| 锚点 | `llm/pipeline/anchor.ts` | quote 三级降级定位，失败即 null |
| 流水线 | `llm/pipeline/extraction.ts` | map → 合并 → reduce；失败块标 failed 可重试；全局节点继承同名章节节点的真实锚点、理解性字段与 figure；章节节点写库前先做认知层级校准 |
| 渲染 | `graph/GraphView.tsx`、`graph/KnowledgeNodeView.tsx` | React Flow；节点尺寸/颜色只来自 `domain/nodeStyle.ts`；有向边+关系标签；点节点展示上下游，弱化其余节点**与连线** |
| 存储 | `db/repositories/graph.ts` | 整图替换 / 章节子图替换（单事务） |

## 2. 关键验证点与证据

### 2.1 缓存复用（重复抽取 0 次新调用）

```
✅ 第一次抽取发生了真实上游调用（mock 计数增加） — calls=+14
✅ 重复抽取 0 次新增加上游调用（命中缓存） — calls=+0
✅ 章节子图复用全局抽取的块缓存（0 次新增调用） — calls=+0
```

统计来自服务端 `/api/llm/mock-stats`，是**真实调用计数**，不是前端猜测。

> 期间修掉一个真 bug：章节子图最初按 `outlineNodeId` 过滤块，而块被归属到了更深的子章节，
> 结果章节子图只剩一个根节点（0 个 chunk → 0 次调用，缓存「假命中」）。
> 改为：仍对全文切块（与全局一致），再按**页码区间重叠**筛选 → 块哈希与缓存 key 完全一致，
> 章节子图 12 个节点、0 次新调用。这才是真复用。

### 2.2 zod 拦截（篡改上游返回）

`LLM_MOCK_BROKEN_JSON=1` 让 mock 返回非法 JSON，跑 `AKN_EXPECT_FAIL=1 node scripts/step3-check.mjs`：

```
✅ 上游返回非法 JSON → 不产生任何节点（禁假数据） — nodes=0
✅ 错误被显式展示 — 13 个块抽取失败：chunk_extract 校验失败：nodes.0.title: Too small…
✅ 失败时不会渲染半成品图
✅ 失败仍计入了上游调用（不是静默跳过）
```

流程：首次调用 → zod 失败 → 一次 `json_repair` 调用 → 仍失败 → 写 `status='failed'` 缓存 → UI 显式报错，图不渲染。

### 2.3 颜色状态机

```
✅ 掌握状态切换 → 颜色改变且状态为 mastered — rgb(185, 28, 28) → rgb(21, 128, 61)
✅ 已掌握是绿系（绿通道 > 红通道） — rgb(21, 128, 61)
✅ 章节根节点使用中性色（不伪造重要度） — neutral=1
```

`nodeStyle(importance, mastery)` 6 个单测钉死：切掌握不换尺寸、重要度越高越大、深浅单调、红绿通道关系、无预测值走中性灰。

### 2.4 完整交互验收（20/20）

`LLM_MOCK=1 pnpm dev` + `node scripts/step3-check.mjs`：

```
✅ 未抽取时是明确空态 — 节点 0 · 边 0
✅ 抽取后节点出现 — nodes=12
✅ 有向边带标签渲染 — edges=11
✅ 标注了 Mock 上游（不冒充真实模型）
✅ 第一次抽取发生了真实上游调用（mock 计数增加） — calls=+14
✅ 重复抽取 0 次新增加上游调用（命中缓存） — calls=+0
✅ 重复抽取不改变图谱规模 — 12 → 12
✅ 节点详情含前置依赖/后置影响
✅ 掌握状态切换 → 颜色改变且状态为 mastered
✅ 已掌握是绿系（绿通道 > 红通道）
✅ 节点 → 切到 PDF 并跳到第 3 页 — indicator=3 / 15
✅ 至少有一个节点带原文锚点可跳转
✅ 刷新后图谱规模一致（从 IndexedDB 恢复） — 12 → 12
✅ 刷新后掌握状态持久化 — mastery=mastered
✅ 目录选中章节后图谱进入章节模式 — 章节：Encoder and Decoder Stacks
✅ 章节模式按钮文案为「AI 开启拆解」
✅ 章节子图复用全局抽取的块缓存（0 次新增调用）
✅ 章节子图有节点且含章节根（中性色） — nodes=12
✅ 页面全程无未捕获异常
通过 20 项，失败 0 项
```

截图：`docs/step3-screenshot.png`；失败态截图：`docs/step3-screenshot-failed.png`。

## 3. 单元测试

```
✓ src/llm/pipeline/chunking.test.ts (8)   ← 章节对齐/超长切分/token 估算
✓ src/llm/pipeline/merge.test.ts (10)     ← 合并规则/不模糊合并/conflict
✓ src/llm/pipeline/anchor.test.ts (7)     ← quote 三级降级
✓ src/domain/nodeStyle.test.ts (6)        ← 颜色状态机
+ 既有 45 个 → 共 71 passed
```

## 4. 未验证 / 已知限制

- **真实 DeepSeek 调用未验证**：没有 key。补 key 后需要重跑一次真实抽取（预期：prompt 输出格式与 zod 契约一致；若不一致会走 json_repair）。
- reduce 阶段一次性把全部节点标题喂给模型；超长文档（>200 节点）需要两级 reduce —— 当前未实现，已在文档标注。
- 图谱布局是圆环（未引入 dagre）：可读性对 12 节点足够，大图后续换力导向布局。
- 「章节根节点」parentId 暂为 null（未挂到全局节点），Step 4 联动时再补。
