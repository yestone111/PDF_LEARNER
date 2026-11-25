# DSH 插件实境验收（真实模型，无 Key 配置）

> 2026-11-20，装在用户本机 `dsh web`（127.0.0.1:3080）的 `web` profile 里，
> 用宿主当前模型 `deepseek-official / deepseek-flash` 跑真实抽取。
> **这是本项目第一次用真实模型跑通全链路**（此前都是本地 mock）。
>
> 注（2026-11-25，v1.2）：学习对话框的正文已从「原文摘录」改为「知识点描述」，
> 因此本文下面那条「引文能在原文中定位并生成摘录」属于 v1.1 的历史证据；
> `plugin-live-check.mjs` 已同步改为断言「知识点描述能显示且已无原文摘抄」。

## 1. 安装结果

```
$ dsh plugin --profile web add ./plugin
+ akn link:../../../work/PDF_learner/ai-knowledge-navigator/plugin
```

profile `package.json` 已写入依赖与 bundle：

```json
"dependencies": { "akn": "link:/home/yeshi/work/PDF_learner/ai-knowledge-navigator/plugin" },
"dsh": { "profile": { "bundles": [ ..., "akn" ] } }
```

无需额外配置、无需重启（profile HMR 直接加载）。

## 2. 实境验证结果（`node scripts/plugin-live-check.mjs`）

```
✅ DSH 里能打开 /akn/ 页面 — http://127.0.0.1:3080/akn/
✅ 浏览器同源访问 /api/akn/health 成功
✅ 确认走宿主进程内模型（非 mock） — deepseek-official/deepseek-flash
✅ 本地 PDF 在插件页里能打开
✅ 真实 DeepSeek 抽出知识点 — nodes=40 · 用时 246s
   抽样节点: Recurrent Networks(重要度4) / Attention Mechanisms(5) / Training Data and Batching(3)
✅ （v1.1，现已变更）真实模型的引文能在原文中定位并生成摘录 — segments=1
   摘录开头: "p.2 such as language modeling and machine translation [35, …"
📸 截图：docs/plugin-live.png
✅ 页面无未捕获异常
通过 7 项，失败 0 项
```

关键点：`/api/akn/llm/status` 返回 `{"configured":true,"mock":false,"model":"deepseek-flash","provider":"deepseek-official","mode":"in-process"}`
—— 模型来自宿主，插件内没有任何 Key 配置。

## 3. 真实调用暴露的两个契约问题（都已修）

这是「mock 永远发现不了」的那类问题，只有真模型能暴露。

### 问题 1：`global_reduce` 省略了 `merges`

```
❌ 失败：global_reduce 校验失败：merges: Invalid input: expected array, received undefined
```

真实模型在「没有可合并项」时直接不输出该字段。原 schema 把它当必填 → 整图被判失败。

修法：
- `GlobalGraphResultSchema.merges` 加 `.default([])`（省略 = 没有合并，是合法结果）；
- prompt 明确「merges 不可省略，即使为空也要输出 `[]`」；
- 升版本 `global-reduce@2`（缓存自然失效）。

### 问题 2：`relationType` 写成中文/大写

```
❌ 失败：edges.0.relationType: Invalid option: expected one of "depends_on" | …
```

模型输出了「依赖」「DEPENDS-ON」这类等价但字面不合枚举的值，整块被判失败。

修法：新增**归一化层** `web/src/llm/pipeline/normalizeLlmJson.ts`，在 zod 之前做确定性归一：

| 输入 | 输出 |
| --- | --- |
| `依赖 / 触发 / 属于 / 扩展 / 实现 / 对比` | 对应英文受控枚举 |
| `DEPENDS-ON`、`Depends On`、`belongs-to` | `depends_on`、`belongs_to` |
| 受控关系却带了 label | 丢弃 label（防止标签漂移） |
| 无法识别的类型（如 `inspired_by`） | `custom` + 原文保留为 label（语义不丢） |
| `importance: "7"` / `0` | 夹到 1–5 |
| 非对象 / 缺标题的节点、缺端点的边 | 丢弃（不补默认值凑数） |

原则是**宽进严出**：只做等价映射与非法条目丢弃，绝不凭空补内容；真正的结构校验仍然由 zod 兜底。
单测 12 个（`normalizeLlmJson.test.ts`），prompt 升到 `chunk-extract@2`。

## 4. 性能与成本（实测）

- 15 页论文、5 个块 + 1 次汇总，`deepseek-flash` **246 秒**；
- 结果缓存后，重复抽取 0 次新调用（mock 验收已证明缓存 key 逻辑，真实链路同理）；
- 这次是真实计费调用——请知悉。

## 5. 已知限制

- 抽取是串行逐块调用，40 节点量级约 4 分钟；后续可做并发（受 provider 限流约束）。
- 真实模型产出的标题偶尔偏长（如「This inherently sequential nature precludes parallelization」），
  这是 prompt 约束问题而非数据问题；可继续调 prompt。
- 插件默认不校验浏览器会话（本机使用）；暴露到局域网请开 `requireBrowserAuth: true`。
