# 夜间自动实现报告（23:00 → 02:10）

> 授权：用户要求「晚上 11 点开始自动实现」。本报告记录 Step 2–5 的实际完成情况、真实验收输出、未验证项。
> 一切结论以「真实跑过的命令输出」为准；没验证的明确标注，不用预期语气冒充结果。

## 0. 一句话结论

**P0（任务书 Step 2–5）功能全部落地，5 步验收共 73 项 CDP 断言全绿（21 + 20 + 16 + 16），98 个单元测试通过，typecheck / build 通过。**
**唯一未验证的是「真实 DeepSeek 调用」**——本机没有 API key，全部 LLM 链路用本地 mock 上游验证（界面明确标注 Mock，不冒充真实结果）。

## 1. 完成清单（对照任务书）

| 任务书条目 | 状态 | 证据 |
| --- | --- | --- |
| §7 Step 2：PDF.js 接入、上传入 IndexedDB、outline 渲染、高亮/备注增删、刷新恢复 | ✅ | `docs/STEP2-PDF.md`，21 项断言 |
| §7 Step 3：Hono 代理、prompt 版本、map-reduce 与缓存、zod/重试、React Flow 两级图、nodeStyle、节点→PDF | ✅ | `docs/STEP3-LLM-GRAPH.md`，20 项断言 + zod 拦截 6 项 |
| §7 Step 4：双向联动、context chip、带页码引注的流式聊天、发送到笔记 | ✅ | `docs/STEP4-LINK-CHAT.md`，16 项断言 |
| §7 Step 5：TipTap 混排、Markdown 导出、SyncProvider 三空实现 | ✅ | `docs/STEP5-NOTES-EXPORT.md`，16 项断言 |
| 模块一：全局图谱 / 节点大小=重要度 / 有向带标签边 / 上下游高亮 / 红绿状态机 / 跳转 | ✅ | Step 3 验收 + `nodeStyle.test.ts` |
| 模块二：目录预测着色（不伪造）/ `🚀 AI 开启拆解` / 缓存 / 同实体层级 | ✅（无预测着色数据源） | Step 3 章节模式验收 |
| 模块三：高亮持久化 / 图表 caption_only 降级 / 双向联动 | ✅ | Step 2 + Step 4 |
| 模块四：AI 伴读 / context chip / 引注 + 无出处 / 发送到笔记 | ✅ | Step 4 |
| 模块五：TipTap 混排 / Markdown 导出 / 同步 P1 接口 | ✅ | Step 5 |
| §5.2 数据模型（类型 + Dexie + zod） | ✅ | `web/src/domain/**`、`db/database.ts` |
| §8.1 未经 zod 不进库 | ✅ | 所有仓储写入前校验；LLM 输出过 zod；失败态不落假数据 |
| §8.2 loading/error/empty 三态 | ✅ | 目录、PDF、图谱、聊天、笔记均有显式三态 |
| §8.3 关键纯逻辑配 Vitest | ✅ | 98 用例：nodeStyle、合并、锚点、引注、切块、Markdown、布局 |
| §8.4 每步自跑 typecheck/build/test | ✅ | 见下 |

## 2. 最终校验（真实输出）

```
$ pnpm -r typecheck
server typecheck: Done
web typecheck: Done

$ pnpm -r test
web test:  Test Files  11 passed (11)
web test:       Tests  98 passed (98)

$ pnpm -r build
server build: Done
web build: ✓ built in 388ms
web build: Done
```

## 3. 各步验收摘要（真实断言数）

| 步骤 | 脚本 | 结果 |
| --- | --- | --- |
| Step 1 布局 | `node scripts/ui-check.mjs` | 16/16 |
| Step 2 PDF | `node scripts/step2-check.mjs` | 21/21 |
| Step 3 图谱 | `AKN_EXPECT_FAIL=1` 失败态 | 6/6（zod 拦截 → 0 节点、错误显式、无半成品图） |
| Step 3 图谱 | `LLM_MOCK=1 node scripts/step3-check.mjs` | 20/20（含缓存 0 次新增调用、章节复用） |
| Step 4 联动/伴读 | `node scripts/step4-check.mjs` | 16/16 |
| Step 5 笔记/导出 | `node scripts/step5-check.mjs` | 16/16 |

## 4. 这一夜修掉的真 bug（都有验收证据）

1. **StrictMode 双挂载 → 两份 PDFViewer**（15 页 PDF 出现 30 个页面容器）。处置：main.tsx 关闭 StrictMode 并在源码注释说明原因（库的命令式组件卸载不完整）。
2. **库的 `scrollRef(scrollTo)` 在本容器不生效**（点目录完全没滚动，scrollTop 不变）。处置：自研 `scrollIntoView` 跳页并在文档记录。
3. **章节子图假复用**：按 `outlineNodeId` 过滤导致章节只剩根节点（0 个 chunk → 0 次调用，缓存「假命中」）。处置：仍按全文切块 + 按页码区间重叠筛选 → 12 节点、0 次新增调用，真复用。
4. **刷新后图谱丢失**：`restoreLastDocument` 只恢复文档/目录/高亮，没恢复图谱。处置：open 后 `loadGraphIntoStore()`。
5. **TipTap `insertContent` 覆盖前一个节点**：插入原子节点后处于选中态，下一张卡片把上一张替换掉（导出里 AI 卡片消失）。处置：统一 `focus('end')` 追加。
6. **ResizeObserver 少算 2px 边框**导致窄窗口 2px 横向溢出（Step 1 抓到）。处置：观察 grid 自身 `clientWidth`。
7. **mock 全局节点标题带 `(importance=…)` 后缀**导致边按标题解析失败（0 条边）。处置：解析时剥离后缀。

## 5. 未验证 / 未实现（必须知情）

| 项 | 原因 | 补验证方式 |
| --- | --- | --- |
| **真实 DeepSeek 抽取与对话** | 无 `DEEPSEEK_API_KEY` | 配 key 后：`pnpm dev` → 打开 fixtures PDF → 点「AI 抽取全局图谱」；`scripts/step3-check.mjs` 去掉 mock 即可复跑 |
| 真实模型的引注质量 | 同上 | 真实调用后看是否出现 `citation-unverified` |
| 图表 `vision` 识图（P1） | 任务书列为 P1 | 数据模型已预留 `figure.kind='vision'` |
| PDF 导出（P1） | 任务书列为 P1 | — |
| 外部同步真实请求（P1） | 任务书列为 P1 | `sync/providers.ts` 三空实现已就位 |
| >200 节点的两级 reduce | 未实现 | 当前一次性 reduce；大文档需分批 |
| 图谱布局 | 圆环布局，未引入 dagre | 大图可读性待优化 |

## 6. 建议的下一步

1. 提供 `server/.env.local` 的 `DEEPSEEK_API_KEY`，我把真实抽取跑一遍（预期会暴露 prompt 与 zod 契约在真实模型下的偏差，需要调 prompt 版本）。
2. UI 精修：图谱换力导向布局、节点卡片可视化、笔记多篇管理。
3. 把 `Highlight.nodeId` 真正落库（现在是实时启发式匹配），支持「手动关联」。
4. 大文档两级 reduce + 增量抽取（按块重试）。

## 7. 07:30 复核（检查点续跑）

按检查点要求只做**复核与补齐**，未重跑长任务（没有重新下载 PDF / 重装依赖 / 重建图谱）。

复核结果：

```
$ pnpm -r typecheck   → server Done / web Done
$ pnpm -r test        → Test Files 11 passed · Tests 98 passed
$ pnpm -r build        → server Done / web ✓ built in 407ms

$ curl /api/health     → {"ok":true,...,"llmMock":true}
$ curl /api/llm/status → {"configured":false,"mock":true,...}
$ node scripts/ui-check.mjs   → 16/16（布局/Tab/拖拽/持久化回归）
$ node scripts/step5-check.mjs → 16/16（上传→抽取→笔记→截图→导出→刷新 全链路回归）
```

补齐项：
- 清理 `docs/.dev-step1.log`（Step 1 调试遗留文件）。
- `docs/ROUND1-DESIGN.md` 追加「实施偏差记录」：设计交付里的目录规划与实际落地存在若干路径差异，已如实登记，避免文档与代码对不上。

复核结论：**夜间交付完好、可复现**；未验证项仍只有「真实 DeepSeek 调用（缺 key）」与任务书明列的 P1 项。
