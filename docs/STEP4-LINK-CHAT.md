# Step 4 交付：双向联动 + AI 伴读

## 1. 落地内容

| 能力 | 实现 | 文件 |
| --- | --- | --- |
| 点节点 → 跳 PDF | `requestScrollToPage` + `requestFlashQuote` → PDF 侧 `scrollIntoView` + 文本层临时高亮 | `graph/graphActions.ts`、`pdf/flashQuote.ts`、`app/panels/PdfPane.tsx` |
| 选中原文 → context chip | `selectionchange` 防抖 350ms，只接受 PDF 容器内的选区，去重后进 `chatStore` | 同上 |
| 点节点 → context chip | `GraphView.onNodeClick` 注入 `kind:'node'` chip（按 nodeId 去重） | `graph/GraphView.tsx` |
| 高亮 → 节点定位 | 按原文归一化「互相包含（≥12 字符）」匹配；气泡里显示关联节点 + 「定位」按钮；匹配不到给明确空态 | `graph/quoteMatch.ts`、`pdf/HighlightCommentEditor.tsx` |
| 流式伴读 | `streamChat` SSE 增量写同一条 store 消息，结束后才落库 | `chat/chatController.ts` |
| 引注校验 | 解析 `[引用] 第N页：「…」` → 回 PDF 文本层核对 → 不通过一律 `verified=false, page=null` | `chat/citation.ts` |
| 发送到笔记 | 回答入 `notesStore.queuedChatCards`，Step 5 插入 TipTap | `chat/ChatPanel.tsx` |

## 2. 引注策略（为什么敢说「不编造页码」）

模型的引注**一律视为待验证声明**：`citation.ts` 用与 `anchor.ts` 相同的三级降级（精确 → 空白折叠 → 大小写不敏感）回查 PDF 文本层。

- 命中 → `verified=true`，并且**用真实命中页**（模型写错页码会被纠正）；
- 未命中 → `verified=false`、`page=null`，UI 固定显示「无直接出处（原文中未定位到引文）」+ 灰色「模型声称：…」；
- 模型完全没给引注 → 仍生成一条 `verified=false` 条目（领域 schema 强制：`assistant && done` 必须至少一条引注）。

`citation.test.ts`（10 个用例）覆盖：页码写错、引文不存在、空白差异、无引注、部分成立。

## 3. 验收记录（16/16）

`LLM_MOCK=1 pnpm dev` + `node scripts/step4-check.mjs`：

```
✅ 索引里有带真实锚点的节点（quote 已定位） — count=63
✅ 存在可用的全局锚点节点 — Figure 1
✅ 点节点 → PDF 跳到锚点页并临时高亮原文 — page=3
✅ 页码指示器跳到第 3 页 — 3 / 15
✅ 在 PDF 中选中文本 → 自动生成可删除的 context chip
✅ 选中文本后弹出高亮确认气泡
✅ AI 回答到达并带引注条目
✅ 引注经原文核对后标记为「已验证」 — verified=1 unverified=0
✅ 每条回答都有「发送到总结笔记」按钮
✅ 「无直接出处」有独立渲染分支（未校验引注不会伪装成有出处）
✅ 「发送到总结笔记」把回答送入笔记 — 已收到 1 条 AI 回答
✅ 已存在持久化的高亮 — parts=1
✅ 点击已有高亮 → 弹出气泡并明确给出关联状态
✅ 关联状态二选一并显式呈现（有节点 / 明确空态） — linked="Figure 1定位" empty=false
✅ 点「定位」→ 切到图谱并选中关联节点 — Figure 1 重要度 3 · 状态 未掌握
✅ 页面全程无未捕获异常
通过 16 项，失败 0 项
```

截图：`docs/step4-screenshot.png`。

## 4. 已知限制

- 高亮→节点匹配是**启发式**（原文重叠 ≥12 字符），跨章节重复表述可能匹配到字典序更长的节点；UI 已标注「按原文匹配」，Step 5 之后可加「手动关联」下拉。
- `Highlight.nodeId` 仍未写入（匹配是实时算的），落库关联留待后续。
- mock 上游的引注来自 `【原文摘录】`，因此本轮验证的是「校验链路正确」，**不是**「真实 DeepSeek 会给出正确引注」——后者需要真 key 才能验证。
