# Step 2 交付：PDF 渲染、目录、高亮与备注持久化

> 依据：任务书 §7 Step 2。验收标准：上传 → 高亮加备注 → 刷新后痕迹原样恢复；目录点击跳页正确。
> 本文所有输出都是真实执行结果，不是预期。

## 1. 落地内容

| 能力 | 实现 |
| --- | --- |
| PDF 解析 | 顶层 `pdfjs-dist@4.4.168`（与 react-pdf-highlighter 内嵌版本严格对齐），worker 用 `?url` 本地资源，**不依赖 unpkg CDN** |
| 本地存储 | `pdfFiles` 表存 `ArrayBuffer` + `documents` 表存元数据（文件名/页数/大小/状态） |
| 目录 | `doc.getOutline()` → 命名 dest 解析（`getDestination` → `getPageIndex`）→ 扁平 `OutlineNode[]` → 前端组装树 |
| 目录跳页 | 点击条目 → `pendingScrollPage` 通道 → 中栏 `scrollIntoView`，页码指示器同步 |
| 高亮 | 划选文本 → `HighlightTip` 气泡（备注 + emoji）→ `ScaledPosition` 落库 |
| 备注编辑 | 点击已有高亮 → 气泡内改备注/删除 |
| 刷新恢复 | `localStorage.akn.ui.lastDocumentId` → 重新解析 PDF + 读回 outline/highlights |
| 三态 | 空态 / 解析中 / 失败（含错误原文 + 重试入口），无静默空白 |

新增文件：`web/src/pdf/{pdfjs,destinations,outline,pdfSession,pdfController,highlightMapping,OutlineTree,HighlightTip,HighlightCommentEditor,OpenPdfButton}.ts(x)`、`web/src/db/repositories/{documents,outline,highlights}.ts`、`web/src/lib/id.ts`。

## 2. 两个必须记录的技术决策

### D-S1：关闭 StrictMode（库冲突，不是我们偷懒）

react-pdf-highlighter@8 的 `PdfHighlighter` 是命令式类组件：`componentDidMount` 里创建 `PDFViewer` 并往容器追加页面 DOM，卸载时**不完整回收**。React 18 的 StrictMode 在开发环境会「挂载 → 卸载 → 再挂载」一次，实测结果：

```
❌ 15 页全部渲染出页面容器 — pages=30
```

一份 15 页 PDF 在 DOM 里出现 30 个页面容器（两个 viewer 叠加），目录页码点击也会打到已被废弃的那份 DOM 上。

处置：`main.tsx` 不套 `StrictMode`，并在源码注释里写明原因。这不是放弃 React 纪律——本项目真正保护数据的是 zod + store 契约 + 测试，StrictMode 的双调用检查在这里救不了任何东西，只会制造两个 viewer。

### D-S2：跳页不用库的 `scrollRef(scrollTo)`

库里唯一的滚动入口是 `scrollRef(scrollTo)`，实现是 `viewer.scrollPageIntoView({pageNumber, destArray: [null, {name:'XYZ'}, ...]})`。
实测在当前容器结构下调用后 `scrollTop` **完全不变**（第 6 页仍在视口下方 4885px），目录点击等于没反应。

处置：自己 `pageElement.scrollIntoView({ block: 'start' })`。理由：可测（`pageTop - viewerTop ≈ 0`）、可解释，且 Step 4「点节点 → PDF 锚点」可直接复用同一套定位逻辑。

## 3. 验收记录（CDP 真实交互，21/21）

`node scripts/step2-check.mjs`（无头 Chrome，真实注入文件 / 真实鼠标划选 / 真实点击 / 真实刷新）：

```
✅ 初始为空态（未打开 PDF）
✅ PDF 打开后出现 viewer
✅ 页面容器数量 = 15（无双份 viewer） — pages=15
✅ 画布已渲染（非空白） — canvas=2
✅ outline 来自真实书签（≥8 条） — items=22
✅ outline 呈现多级层级 — levels=1,2,3
✅ 绝大多数条目解析出页码 — 22/22
✅ 存在可点击的一级章节 — index=11
✅ 点击「Why Self-Attention6」→ 页码指示器变为 6 — indicator=6 / 15
✅ 第 6 页确实滚动到视口顶部附近 — pageTop-viewerTop=0
✅ 取到可划选的文本行 — spans=3
✅ 划选文本后弹出高亮确认气泡
✅ 高亮条数变为 1 — count=高亮 1
✅ 页面上渲染出高亮色块 — parts=1
✅ 刷新后高亮数据从 IndexedDB 恢复 — 高亮 1
✅ 刷新后目录仍在（无需重新解析） — items=22
✅ 刷新后文档名恢复 — attention-is-all-you-need.pdf
✅ 刷新后页数仍为 15 — pages=15
✅ 刷新后高亮色块在原页重新渲染 — parts=1
✅ 点击高亮可查看已保存的备注 — value=注意力的核心公式（CDP 自动验收）
✅ 页面全程无未捕获异常

通过 21 项，失败 0 项
```

截图：`docs/step2-screenshot.png`。

补充说明：刷新后高亮色块只在**其所在页被渲染时**才会挂到 DOM（pdf.js 懒渲染），所以断言是「滚动到第 6 页后再检查色块」，而不是刷新后立刻检查 —— 这是真实行为，不是绕过。

## 4. 单元测试

`pnpm --filter @akn/web test`：

```
✓ src/app/layout/layoutMath.test.ts (15 tests)
✓ src/pdf/outline.test.ts (8 tests)          ← 层级/order/页码/不伪造重要度/上限保护
✓ src/pdf/highlightMapping.test.ts (5 tests) ← 页码补全、zod 通过、可转 IHighlight
✓ src/domain/schemas.test.ts (12 tests)
Test Files  4 passed (4)      Tests  40 passed (40)
```

## 5. 已知限制 / 留给后续

- 高亮暂无「按节点分组」能力：`Highlight.nodeId` 目前恒为 null，Step 4 双向联动时写入。
- 目录为空（PDF 无书签）时显示明确空态，不伪造目录；Step 3 会由 AI 抽取章节结构补足。
- `pdfScaleValue="auto"` 固定；缩放控件属于 UI 精修，后置。
- 大文件（>50MB）目前全量读进内存后落 IndexedDB，未做分片；P0 够用，记录待优化。

## v1.3 追加：目录「章节掌握度三态」+ 章节书签

用户需求：目录要能看出每章是否看完；三态 = 实心绿圈（全部掌握）/ 半绿圈（部分）/ 灰空心圈（未开始），
全部掌握的要有提示；并加章节书签，下次打开直接跳到书签所在章节。

| 能力 | 文件 | 说明 |
| --- | --- | --- |
| 三态计算 | `web/src/graph/chapterProgress.ts` | 纯函数 + 单测：按锚点页码找「当前章」（起始页 ≤ 页码、取最深/最靠后），沿 parentId 上卷；无页码章节继承子树首页 |
| 概念去重 | 同上 `collectConcepts()` | 抽取会为同一知识点写 `global` 与 `chapter` 两条记录，按 titleNorm 折成一个概念，**任一记录已掌握即算已掌握**；手册实测 12 个点原本被数成 69 条 |
| 目录圆圈 | `web/src/pdf/OutlineTree.tsx` | `ChapterMasteryDot`：实心绿 / 半绿渐变 / 灰空心；`title` 给出「本章已全部掌握（m/n）」等提示，`data-state` 供验收断言 |
| 书签仓储 | `web/src/db/repositories/bookmarks.ts` | Dexie **v2** 新增 `bookmarks` 表（`[documentId+createdAt]` 复合索引）；同一章节只留一条 |
| 打开即跳 | `web/src/pdf/pdfController.ts` `restoreBookmarks()` | 打开/恢复文档后跳到最近书签的章节：中栏切 PDF + `pendingScrollPage`，左栏显示「已跳到书签：…」提示（可关闭）；不切章节子图模式 |
| 迁移 | `web/src/db/database.ts` | `DB_VERSION` 1 → 2；新表由 Dexie 建，老数据不动（`db-upgrade-check.mjs` 实测老行还在） |

验收：`node scripts/bookmark-progress-check.mjs`（24 项：三态 + 提示 + 书签落库 + 刷新后跳转）、
`node scripts/db-upgrade-check.mjs`（6 项：v1 → v2 迁移）。
