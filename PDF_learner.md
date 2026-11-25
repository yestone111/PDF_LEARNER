# 任务书：从零开发 "AI Knowledge Navigator"（AI 知识导航仪）

## 0. 运行环境与边界（开工前必读，优先级高于下文一切默认假设）

- 本项目与当前仓库的任何现有代码**完全无关**。请在一个全新的空目录 `ai-knowledge-navigator/` 中初始化项目，**不得在当前仓库中散落项目文件，不得修改当前仓库的任何已有文件**。先向我确认目录的绝对路径，再初始化。
- 运行时与工具链锁定：Node.js ≥ 20 LTS、包管理器 **pnpm**、构建工具 **Vite**、语言 **TypeScript（strict 模式）**。
- 所有依赖安装、dev server、构建命令都在新项目目录内执行。每个步骤结束时必须给出我可以亲自运行的验收命令及其预期结果。
- 不要一次性写完所有代码。严格按第 7 节的 Step 0–5 分步推进，每步等我确认后再进入下一步。

## 1. 角色与产品目标

你现在是一位资深 AI 全栈工程师和产品架构师。我们要从零开发一个名为 **"AI Knowledge Navigator"（AI 知识导航仪）** 的本地优先（local-first）Web 应用，帮助用户把硬核 PDF 文档（学术论文、技术规范）转化为互动式知识图谱，并伴随 AI 阅读与沉淀笔记。

数据默认全部保存在浏览器本地（IndexedDB），不依赖云端账户。

## 2. 技术栈（已锁定，不要再给备选方案）

| 选择点 | 锁定方案 | 说明 |
|---|---|---|
| 前端框架 | React 18 + TypeScript + Vite | strict TS，禁止 `any` 兜底（LLM 边界用 zod 校验后再收窄类型） |
| 样式 | TailwindCSS | 组件内部不写大段自定义 CSS |
| 状态管理 | Zustand | 禁止用层层 Context 传递业务状态；Context 只用于真正的 Provider 场景 |
| PDF 渲染与高亮 | PDF.js + react-pdf-highlighter | 高亮数据结构以库的 schema 为准并持久化 |
| 图谱可视化 | React Flow | 自定义节点尺寸/颜色、有向边、边标签、点击交互 |
| 富文本笔记 | TipTap | 自定义节点承载"图谱节点卡片"等混排内容 |
| 本地存储 | Dexie.js（IndexedDB） | 不引入 SQLite/WASM；所有 LLM 产物按章节缓存，避免重复生成与重复计费 |
| Schema 校验 | zod | 所有 LLM JSON 响应先过 zod，失败则走第 5 节的修复/重试流程 |
| LLM | DeepSeek 对话模型，经**本地后端代理**调用 | 见第 4 节，禁止前端直连 |
| 后端代理 | Hono（Node 适配），独立 `server/` 目录 | 仅做 LLM 转发、密钥保管、流式透传；不做业务持久化 |
| 图谱截图 | html-to-image（对 React Flow 视图区截 PNG） | 截图以 blob 存入 IndexedDB 并可插入笔记 |

## 3. 功能需求（P0 = 首版必须完成；P1 = 本期只做接口预留或最小实现）

### 模块一：全局知识图谱（总览模式）—— P0

1. 跨越 PDF 章节限制，用 LLM 提取全文最核心的技术点（抽取策略见第 5 节）。
2. **视觉规范**：节点大小代表重要度（大圈 = 核心概念，小圈 = 次级概念）。边必须是有向的，边标签必须带关联描述（如"触发""依赖""属于"）。
3. **依赖关系**：点击任意节点，展示其前置依赖（上游）和后置影响（下游），用全局视角高亮相关子图、弱化其余节点。
4. **颜色状态机**（两个正交维度，掌握状态切换时保留重要度深浅）：
   - 未掌握：按重要度着红色系，最重要 = 深红，次要 = 浅红。
   - 已掌握：用户勾选后切绿色系，深绿 = 已掌握的核心，浅绿 = 已掌握的次要项。
   - 用一个纯函数 `nodeStyle(importance, mastery)` 集中实现，禁止在组件里散落颜色判断。
5. **指引跳转**：点击总览图节点，跳转至 PDF 对应页/位置并高亮原文锚点。

### 模块二：章节探索与图谱细化（Lazy Loading）—— P0

1. 左侧展示 PDF 目录（outline）。尚未解析的章节按其重要度预测值显示红/浅色标识（无预测值时给中性占位色，不得伪造重要度）。
2. 进入章节后显示 `[🚀 AI 开启拆解]` 按钮。
3. 点击后调用 LLM 生成该章节的**细化子图谱**；结果写入 IndexedDB，再次进入直接读缓存，不重复调用。
4. 章节内知识点同样支持掌握/未掌握标定（红变绿，规则同模块一）。
5. 子图谱节点与全局图谱节点是**同一套实体、带层级关系**（`parentId` 指向全局节点或章节根），不是两套互不相干的数据。

### 模块三：PDF 阅读器与双向联动 —— P0

1. 支持文本高亮与备注，高亮痕迹持久化到 IndexedDB，刷新后原样恢复。
2. **图表能力的现实降级（重要）**：DeepSeek 文本模型无法"看见" PDF 内的位图。v1 只实现：基于版面/Caption 文本启发式（如匹配 `Figure N:`、`表 N`、`Fig. N` 模式 + 邻近文本）生成**图表占位节点**，节点记录 Caption、页码和区域坐标，点击跳转 PDF 对应位置。真正的图像语义识别（渲染页面截图走视觉模型）标记为 P1，本期不实现，但数据模型里预留 `figure.kind = 'caption_only' | 'vision'` 字段。
3. **双向联动**：
   - 点图谱节点 → PDF 自动滚动到锚点（page + rects）并临时高亮对应原文；
   - 在 PDF 中选中文本/点击已有高亮 → 关联图谱节点闪烁定位（无关联节点时给出明确空态提示，不要静默）。

### 模块四：右侧 AI 常驻伴读 —— P0

1. 右侧固定聊天侧边栏，与笔记面板用 Tab 切换（布局见 Step 1）。
2. 用户在 PDF 中选中文本或点击图谱节点时，自动把选中内容作为 context 注入下一条提问（在输入框中以可删除的 context chip 展示，让用户知道发了什么）。
3. AI 回答必须带原文引注（页码 + 原文 quote）；无可靠出处时明确说"无直接出处"，禁止编造页码。
4. 每条回答提供"发送到总结笔记"按钮，以结构化卡片（含引注）插入 TipTap 笔记。

### 模块五：总结笔记与数据互通 —— 笔记本体 P0，外部同步 P1

1. 独立富文本笔记面板（右侧 Tab 或抽屉，二选一并在第一轮说明你的选择与理由）。
2. 支持混排插入：
   - 图谱节点卡片（节点名 + 重要度 + 关联描述，一键插入）；
   - React Flow 视图截图（html-to-image 生成 PNG，存 IndexedDB 后插入）；
   - PDF 高亮段落、AI 对话记录（含引注）。
3. **导出（P0）**：一键导出纯净 Markdown（`.md`）。笔记中的自定义节点必须有确定的 Markdown 降级表示（卡片 → 引用块，图片 → 本地图片文件或 base64 占位规则需在第一轮明确）。PDF 导出列为 P1。
4. **同步（P1，本期只交付接口）**：定义 `SyncProvider` interface 与配置项 schema（目标、凭证字段、启用开关），Obsidian（URI）、Notion API、飞书 Webhook 各留一个空实现 + 配置占位，不写真实请求逻辑。

## 4. LLM 接入与密钥安全（硬性约束）

- **禁止**在前端代码、浏览器存储或构建产物中出现 DeepSeek API key。
- `server/` 下用 Hono 实现最小代理：`POST /api/llm/chat`（支持 SSE 流式透传）、`POST /api/llm/extract`（结构化抽取专用）。key 只从服务端 `.env.local` 的 `DEEPSEEK_API_KEY` 读取，`.env.local` 必须进 `.gitignore`。
- 代理负责：注入 key、超时与重试（最多 2 次，指数退避）、错误状态码归一化、对超长请求返回 413 而不是让上游报错。
- 前端只持有一个 `llmClient`，所有调用走该客户端，业务代码不得出现 fetch 到 LLM 域名的代码。
- 提供 `.env.example` 说明所需变量；dev 启动脚本同时拉起 Vite 和 Hono（concurrently 或 pnpm workspace script）。

## 5. LLM 抽取策略与数据契约

### 5.1 大文档的 map-reduce 策略

"提取全文技术点"不允许把整篇 PDF 塞进一次请求。固定流程：

1. **切块（map）**：按 PDF 章节/固定 token 上限切块，逐块调用抽取 prompt，每块结果独立缓存（key = 文档 id + 块 hash + prompt 版本号）。
2. **合并（reduce）**：对各块产出的节点做实体合并（同名/别名归一，合并规则要在 prompt 和代码里同时体现），再做一轮 LLM 汇总调用产出全局图谱。
3. 章节子图谱（模块二）直接复用对应块的缓存，不重复抽取。
4. 任一阶段失败：zod 校验失败先尝试一次"JSON 修复 prompt"，仍失败则该块标记 `failed` 并允许单块重试，**不得**用假数据填充图谱。
5. 所有 prompt 模板集中存放在 `src/llm/prompts/`，带 `version` 字段；改 prompt 即升版本号，旧缓存自然失效。

### 5.2 必须在写任何组件之前先交付的数据模型（第一轮产出物之一）

至少包含以下实体的 TypeScript 类型 + Dexie table schema + 对应 zod schema，字段可增补但不得跳过：

- `Document`：id、文件名、页数、上传时间、PDF 原始文件的存储句柄（blob 存 IndexedDB）。
- `OutlineNode`：章节树、页码、层级。
- `KnowledgeNode`：id、所属文档、`parentId`（全局/章节层级）、标题、重要度（枚举或 1–5 分级）、掌握状态、锚点（page + quote + rects）、来源块 id、`figure.kind` 预留字段。
- `KnowledgeEdge`：有向、起点/终点、关系标签（受控词表 + 允许自定义）、来源。
- `Highlight` / `Note`：遵循 react-pdf-highlighter 的持久化结构，关联节点 id 可空。
- `ChatMessage`：角色、正文、引注数组、关联 context 快照。
- `NoteDoc` / 笔记块：TipTap 文档 JSON、插入图片的 blob 引用。
- `ExtractionCache`：缓存 key、prompt 版本、原始响应、状态（success/failed）、时间戳。
- 同步配置：`SyncProvider` interface 与各目标的配置 schema（P1 占位）。

## 6. MVP 边界

- **P0（首版必须可用）**：模块一、二、三、模块四全部、模块五的笔记本体与 Markdown 导出、本地存储与缓存、Hono 代理。
- **P1（只留接口/占位，不实现）**：视觉模型识图、PDF 导出、三个外部同步目标的真实请求。
- 若单轮上下文紧张，优先保 P0 的数据链路完整性（存储 → 抽取 → 图谱 → 联动），UI 精修可以后置；禁止为赶进度跳过 zod 校验或缓存。

## 7. 分步执行计划与验收标准

每一步完成后，停下等我确认，并附上该步全部验收命令的实际输出。

- **Step 0：脚手架与空跑**
  建目录、初始化 Vite + React + TS + Tailwind、pnpm workspace（`web/` + `server/`）、Zustand/Dexie/zod 等依赖、`.gitignore`、`.env.example`、Hono 健康检查路由。
  验收：`pnpm -r typecheck`（`tsc --noEmit`）零错误；`pnpm dev` 同时拉起前后端；`curl localhost:<port>/api/health` 返回 200；浏览器打开默认页无控制台报错。
- **第一轮（与 Step 0 同级，先于业务组件）：设计交付，不写业务代码**
  交付 ① 完整目录结构规划；② 第 5.2 节全部类型/Dexie schema/zod schema；③ 你识别到的开放问题及你的默认选择（含笔记面板形态、Markdown 图片策略、关系标签受控词表）。等我确认。
- **Step 1：基础 Layout**
  三栏骨架：左侧 PDF 目录（占位）、中间 PDF 区（占位）、右侧 AI 聊天 / 笔记 Tab（占位）；栏宽可拖拽调整、最小宽度保护；Zustand  store 骨架。
  验收：typecheck + build 通过；截图或操作说明证明三栏渲染、Tab 切换、拖拽可用。
- **Step 2：PDF 渲染、高亮与持久化**
  PDF.js 接入、文件上传入 IndexedDB、outline 渲染、react-pdf-highlighter 高亮/备注的增删与刷新恢复。
  验收：上传 → 高亮加备注 → 刷新页面后痕迹原样恢复；目录点击跳页正确。
- **Step 3：LLM 抽取 + 两级图谱**
  Hono 代理、prompt 模板与版本、map-reduce 抽取与缓存、zod 校验/重试、React Flow 渲染（节点尺寸、有向边与标签、`nodeStyle` 颜色状态机）、全局图与章节子图的层级联动、节点 → PDF 跳转。
  验收：用一份真实多页 PDF 跑通完整抽取；断网/重复进入章节验证读缓存不重复调用；篡改上游返回验证 zod 拦截与 failed 状态；掌握勾选的红绿深浅切换正确。
- **Step 4：双向联动 + AI 伴读**
  节点 ↔ PDF 双向定位与闪烁、选中文本/节点注入 context chip、带页码引注的流式聊天、"发送到笔记"。
  验收：双向联动逐项手测并描述结果；构造无出处问题验证"无直接出处"行为而非编造引注。
- **Step 5：笔记、导出与同步占位**
  TipTap 混排（节点卡片、图谱截图、高亮、AI 记录）、Markdown 导出、`SyncProvider` 接口与三个 P1 空实现。
  验收：导出的 `.md` 在 Obsidian/Typora 中打开排版正常、引注与图片降级表示符合第一轮约定；`pnpm -r build` 整体通过。

## 8. 工程纪律（每一步都适用）

1. 任何 LLM 返回的数据未经 zod 校验不得进入 IndexedDB 或渲染逻辑。
2. 所有异步过程要有明确的 loading / error / empty 三态，禁止空白静默失败。
3. 关键纯逻辑（颜色状态机、实体合并、锚点定位、Markdown 序列化）配单元测试（Vitest）。
4. 每步结束必须自跑 `typecheck`、`build` 和该步相关测试，贴出真实输出；失败就修，不要带着已知错误进入下一步。
5. 遇到本任务书与实际库能力冲突（例如 react-pdf-highlighter 的 API 限制），先停下来说明冲突和备选方案，不要悄悄改需求。
