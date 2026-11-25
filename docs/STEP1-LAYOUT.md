# Step 1 交付：基础 Layout（三栏骨架 + 拖拽 + Zustand 骨架）

> 依据：任务书 §7 Step 1。验收标准：`typecheck + build` 通过；截图或操作说明证明**三栏渲染、Tab 切换、拖拽可用**。
> 本轮只做布局骨架与状态容器，**没有** PDF 渲染、没有图谱、没有 LLM 调用。

## 1. 组件结构

```
App
└── AppLayout                        ← 三栏 grid 的唯一所有者（栏宽、拖拽、ResizeObserver）
    ├── TopBar                       ← 产品标识 / Step 徽标 / 开发态栏宽读数 / 重置栏宽 / 后端探针
    ├── LeftSidebar   [panel-left]   ← 文档目录（outline）空态，Step 2 接 pdf.js
    ├── Splitter left [splitter-left]← 6px 竖向分隔条：拖拽 + 键盘
    ├── PdfPane       [panel-center] ← PDF 渲染区占位，Step 2 接 react-pdf-highlighter
    ├── Splitter right[splitter-right]
    └── RightDock     [panel-right]  ← Tab：AI 伴读 / 笔记（两个占位面板）
```

## 2. 关键设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| L1 | 三栏用 CSS Grid：`${left}px 6px minmax(360px,1fr) 6px ${right}px` | 中间最小宽度由浏览器兜底；两侧宽度由纯函数兜底，两层保险 |
| L2 | 宽度钳制全部走 `layoutMath.ts` 纯函数（15 个单测） | 「拖到边界」「窗口变窄」「persist 脏数据」是最容易出 bug 的三处，必须能脱离 DOM 测 |
| L3 | 中间阅读区优先：预算 = 容器宽 − 另一侧 − 360 − 12 | 宁可挤侧栏，也不能把 PDF 区压到不可读 |
| L4 | 拖拽用 `window` 上的 pointermove/pointerup，不用 pointer capture | 鼠标移出分隔条甚至移出窗口时仍能继续拖，松手即停；卸载时清理监听 |
| L5 | 分隔条 `role="separator"` + `tabIndex=0` + ←/→ 微调 16px | 可访问性；也让自动化验收能用真实键盘事件验证 |
| L6 | 栏宽与 Tab 持久化到 `localStorage.akn.ui`，并在 `merge` 里做脏数据归一 | 刷新后原样恢复；手改/旧版本数据不会把布局撑坏 |
| L7 | ResizeObserver 观察 **grid 自身**而非外层容器 | grid 有 1px 边框，用外层宽度会多算 2px → 实测出现 2px 横向溢出（已修，见 §4.3） |
| L8 | 开发态在顶栏显示 `左 260 · 右 380`（`import.meta.env.DEV`） | 手动验收不用开 DevTools 量像素；生产构建自动消失 |
| L9 | 五个 store 分开：ui / document / graph / chat / notes | 业务状态不进 Context；组件按需订阅单个 slice，避免整树重渲染 |
| L10 | 空态一律显式（空文案 + 后续步骤说明），不放假数据 | 假目录/假节点会让人误判「解析已通」，是最贵的误导 |

## 3. Zustand store 职责（本轮只定骨架，不塞数据）

| store | 状态 | 本轮已实现的行为 |
| --- | --- | --- |
| `uiStore` | `rightTab`、`panelWidths`、`exportPrefs` | 切 Tab、写宽度、按容器重钳制、重置、持久化 + 脏数据归一 |
| `documentStore` | `document`、`outline`、`status`、`error` | 读写接口；`status` 走 `idle/loading/ready/error` 三态 |
| `graphStore` | `nodesById`、`edgesById`、`selectedNodeId`、`extraction` | `upsert`、选中、`toggleMastery`（只动 mastery，不动 importance）、进度三态 |
| `chatStore` | `thread`、`messages`、`contextChips`、`streaming` | 消息 upsert、context chip 增删、流式标记 |
| `notesStore` | `noteDoc`、`images`、`dirty`、`saveStatus` | 文档与图片注册、脏标记、保存三态 |

> 设计纪律：`toggleMastery` 只改 `mastery` 字段，**颜色深浅由 `nodeStyle(importance, mastery)` 在 Step 3 统一算**，store 里不出现任何颜色。

## 4. 验收记录（真实执行）

### 4.1 typecheck / build / test

```
$ pnpm -r typecheck
server typecheck$ tsc --noEmit -p tsconfig.json
web typecheck$ tsc --noEmit -p tsconfig.json
server typecheck: Done
web typecheck: Done

$ pnpm -r build
server build: Done
web build: vite v8.3.8 building client environment for production...
web build: ✓ 110 modules transformed.
web build: dist/index.html                   0.41 kB │ gzip:  0.27 kB
web build: dist/assets/index-BPtrN1-d.css   18.27 kB │ gzip:  4.26 kB
web build: dist/assets/index-BmDT1a7J.js   238.84 kB │ gzip: 74.86 kB
web build: ✓ built in 134ms

$ pnpm --filter @akn/web test
 ✓ src/app/layout/layoutMath.test.ts (15 tests) 9ms
 ✓ src/domain/schemas.test.ts (12 tests) 22ms
 Test Files  2 passed (2)
      Tests  27 passed (27)
```

### 4.2 交互验收（CDP 真实鼠标/键盘，非人眼截图）

`node scripts/ui-check.mjs`（无头 Chrome + DevTools Protocol，真实派发 pointer/key 事件）：

```
✅ 三栏渲染：左 260 / 中 ≥360 / 右 380 — left=260 center=762 right=380
✅ 初始无横向溢出 — scrollWidth=1414 clientWidth=1414
✅ 默认 Tab = AI 伴读 — chat=true notes=false
✅ 点击「笔记」→ 切到笔记面板 — chat=false notes=true
✅ 点回「AI 伴读」→ 恢复聊天面板
✅ 向左拖 120px → 左栏 260+120=380 — left=380
✅ 继续拖到极限 → 左栏被最小宽度 200 兜住 — left=200
✅ 右分隔条向左拖 150px → 右栏 380+150=530 — right=530
✅ 右栏被最小宽度 320 兜住 — right=320
✅ 分隔条聚焦后按两次 → = +32px（200 → 232） — left=232
✅ 窗口收窄到 900px 后自动重钳制，无横向溢出 — scrollWidth=874 clientWidth=874 center=360
✅ 宽度已写入 localStorage(akn.ui) — {"rightTab":"notes","panelWidths":{"left":200,"right":320},...}
✅ 刷新后栏宽与 Tab 选择原样恢复 — left 200→200 / right 320→320
✅ 刷新后仍停在「笔记」Tab
✅ 点击「重置栏宽」→ 回到默认 260 / 380 — left=260 right=380
✅ 页面全程无未捕获异常 / 无 error 级控制台日志

通过 16 项，失败 0 项
```

截图：`docs/step1-screenshot.png`（1440×900，默认视图）。

### 4.3 验收中抓到并修掉的真实 bug

第一次跑交互验收时唯一失败项：

```
❌ 窗口收窄到 900px 后自动重钳制，无横向溢出 — scrollWidth=876 clientWidth=874 center=360
```

原因：`ResizeObserver` 观察的是外层 `layout-root`（content 876），而三栏真正可用的是 grid 自身（876 − 2px 边框 = 874）。钳制多算 2px → `left+right+center+splitter` 恰好超出 2px。

修法：把 ref/observer 移到 grid 元素上，用它的 `clientWidth`（=874）参与钳制；拖拽时的容器宽也来自同一处。修完 874=874，零溢出。这条 bug 正是「必须用真实交互验收而不是看图」的例证。

## 5. 留给后续步骤的接口

- `LeftSidebar` 已按 `outline: OutlineNode[]` 渲染（含 `level` 缩进与 `status` 三态），Step 2 只需往 `documentStore` 灌数据。
- `PdfPane` 的页指示器读 `document.pageCount`，Step 2 接 pdf.js 时改成真实页码。
- `RightDock` 的 Tab 状态在 `uiStore.rightTab`，Step 4 的聊天流式与 Step 5 的 TipTap 直接替换两个占位面板。
- `graphStore.toggleMastery` 已就绪，Step 3 接 `nodeStyle` 后红绿切换即生效。
