# AI Knowledge Navigator

把硬核 PDF（论文、技术规范）变成可交互的知识图谱，并伴随 AI 阅读与沉淀笔记。
**本地优先**：数据默认全部保存在浏览器 IndexedDB，不依赖云端账户。

> 当前进度：**P0（Step 0–5）+ v1.1「图谱优先学习流」已完成**。
> 已实现：三栏布局 / PDF 目录与高亮持久化 / LLM map-reduce 抽取与两级图谱 / 双向联动与带引注伴读 / TipTap 笔记与 Markdown 导出
> / **点知识点弹学习对话框：知识点描述（是什么 / 先修 / 精细加工 / 自测）+ 图摘抄 → 一键跳回 PDF 原文核对与标注**；
> 选中节点时，不相关的知识点与连线一起变暗，只留它的直接上下游。
> **文档目录**：每章左侧三态掌握圈（实心绿 = 全部掌握 / 半绿 = 部分掌握 / 灰空心 = 未开始，悬停看 m/n）；
> 行尾的绸带书签图标加章节书签（实心=已加），下次打开这份文档直接跳到最近钉住的那一章。
> **图表/表格知识点**（Figure/Table）即使模型只给了 caption、没给逐字引文，也能跳到原文：用 caption 定位并画下划线，
> 定位不到就落到图表页并整页闪一下（明确提示，不假装命中）。
> ⚠️ 未验证：**真实 DeepSeek 调用**（本机没有 key）。开发与验收使用本地 mock 上游，界面会显示「Mock 上游」标识。

## 技术栈（已锁定）

| 层 | 方案 |
| --- | --- |
| 前端 | React 18 + TypeScript（strict）+ Vite + TailwindCSS |
| 状态 | Zustand |
| PDF | PDF.js + react-pdf-highlighter |
| 图谱 | React Flow |
| 笔记 | TipTap |
| 存储 | Dexie.js（IndexedDB） |
| 校验 | zod（所有 LLM JSON 先过 zod） |
| 后端 | Hono（Node），仅做 LLM 转发 / 密钥保管 / 流式透传 |

## 形态：DSH 插件（默认交付形态）

本产品以 **DeepSeek Harness 插件**形态交付：模型复用 DSH 当前配置，**无需配置任何 API Key**。

```bash
pnpm build:plugin     # 以 /akn/ 为基路径重新构建前端并拷进 plugin/static（已构建可跳过）
pnpm plugin:install   # = dsh plugin --profile web add ./plugin
```

重启（或等 profile HMR 重载）`dsh web` 后：

- DSH 界面右下角出现两颗同款椭圆按钮，**上面那颗是「📚 PDF 学习」**（下面那颗是你原有的 🧭 RTL_Cockpit）；
- 点击就地进入 `/akn/`（Ctrl/Cmd/Shift/中键在新标签打开，与 🧭 的语义一致）。

按钮对齐关系：RTL_Cockpit `bottom:18px`、高 38px → 本按钮 `bottom:66px`，间距 10px；
圆角 20px、内边距、字重、阴影、hover 位移与 RTLCockpit 完全一致，只换了图标/文案/渐变主色。

插件在 DSH 插件页里的**标题 / 简介 / 图标**不是随便写的，走 DSH 的清单规则：

| 展示项 | 来源 | 本仓库文件 |
| --- | --- | --- |
| 标题 | `locale/<lang>.json` 的 `meta.title` → 回退 `package.json.name` | `plugin/locale/{en,zh}.json` |
| 简介 | 同上的 `meta.description` → 回退 `package.json.description` | 同上 |
| 图标 | `package.json.icon`：包内相对路径，svg/png/jpeg/webp，≤256 KiB | `plugin/icon.svg` |
| 兼容性 | `engines.dsh`（SemVer）与 `dsh --version` 比对 | `>=0.2.0-rc.2` |

完整规则（含语言包解析顺序、patch 行 `name` 必须等于包名、`exports` 必须暴露 `./locale/*` 等坑）见
**[docs/DSH-PLUGIN.md](docs/DSH-PLUGIN.md)**，并可用 `pnpm verify:plugin-manifest`（33 项）自检。

### 知识图谱：两组 + 三重视觉语义

| 组 | 内容 | 入口 |
| --- | --- | --- |
| ① 全文档总览 | 核心知识点，**从左到右按依赖方向**排列（脑图式） | 图谱顶部「① 全文档总览」 |
| ② 章节拆解 | 更细的子图，节点直接锚定原文核心点 | 「② 章节拆解」+ 章节下拉 / 左栏目录 |

节点视觉（唯一实现在 `domain/nodeStyle.ts`）：

- **椭圆节点**：高度 = 关联程度（46–112px），**宽度 = 高度 × 2.2**（96–320px）——两个轴都由关联度决定，与标题字数无关；
  标题在框内两行截断（hover 看全称），掌握切换按钮浮在右下角、不再被椭圆裁切；
- **大小 = 关联程度**：连边越多越大；参考度数取「当前图最大度数」，稀疏图里也能看出差异；
- **颜色深浅 = 掌握难度**：`difficulty` 1–5，越深越难；
- **红 / 绿 = 未掌握 / 已掌握**：点节点内圆点切换，**尺寸与深浅不变，只换色相**。

布局是纯函数 `graph/layout.ts`（Kahn 拓扑分层 + 同层按关联度排序 + **层内折列**），确定性、可测试；有环不会卡死。

**性能**：抽取耗时主要花在「生成结构化 JSON」而不是「读」。实测同一段原文：直接总结 4.1s / 270 字；
我们的抽取优化前 81.9s / 15,587 字，收紧输出后 **21.9s / 3,846 字**，再加上块级并发 3 路。
详见 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)。

**跳到原文会划重点**：点「跳到 PDF 原文」后会切到 PDF、把目标页滚进视口，并在**命中的原文行下方画闪烁下划线**
（多行就每行一条；NFKC 折叠 + 前缀匹配 + 跨页回退）；只有匹配不到时才退化为整页闪烁，并明确提示「已标出该页」。

**目录章节标志**：左栏每条目录带层级编号（1 / 1.1 / 3.1.1），一级条目标「章」并加粗；
编号按**目录树的父子关系**做 DFS（存储层按 level 排序，用扁平分号会把「第一章的小节」算成 8.1——已修）；
书签标题本身已带编号（`1 Introduction`、`第一章`、`Chapter 3`）时不重复显示。

**大文档**：节点超过 80 时会自动**两阶段汇总**（分批 80 → 最终汇总），避免单次输出被 `maxTokens` 截断；
最终汇总失败时保留分批结果（部分图谱 + 明确警告），不会整篇归零。单次调用超时从 90s 提高到 300s。

**目录不是知识点**：它只用于跳页、切块对齐与圈定章节范围；图谱里不会有「章节节点」，
也不会把目录条目当成关联端点（否则它会和所有知识点都连上，稀释真正的语义关系）。

框架是「理解出来的」，**目录不参与结构划分**：`global_reduce` 阶段只拿到每个知识点的**摘要**
与分块阶段抽到的**候选关系**，先识别 3–8 个覆盖全书的**总纲概念**，其余节点按语义 `belongs_to` 挂到最贴切的总纲下，
总纲之间用 `depends_on` / `contrasts_with` 连成主脊。prompt 里明确写死「按语义归属，禁止按章节机械分组」——
因为同一个大概念的多个侧面可能分散在不同章节（这是章节硬连边会错的地方）。

边有两个来源：reduce 阶段直接给出的全局边，以及**章节边提升**（章节节点带 `parentId` 指向同名全局节点，
把章节边映射到全局端点，避免「总览图一条边都没有」——2026-11-20 真实手册实测踩过）。无边的图会显示明确提示。
边为 3px 加粗 + 20px 箭头 + 轻微投影，左→右方向明显；`fitView` 限制最小缩放，避免大图缩成一片。

### 认知拆解（CLT / SCoP / PICA / 图式）

拆解不再是「按长度切块 + 罗列标题」，而是有认知约束的流水线：

- **SCoP 五技能**：每个单元标注认知层级 1–5（定位/连接/推断/组织/选择）与单元类型；
- **PICA 闸门**：前缀连贯（前置必须排在前面，违反即报）＋ 条件新颖（摘要高度相似 → 合并而非丢弃）；
- **图式 + 精细加工**：单元带「先修」与类比/对比/为什么重要/常见误解，全局节点从章节节点继承；
- **学习路径**：按层级贪心 + 拓扑排序；点条目只在图谱里高亮该知识点并**平滑移到画布中心**（看详情请点图谱里的节点）；
- **自测题**：每个总分节点带一道检验题，先自己想再展开答案；
- **空节点按需分析**：还没生成内容的知识点，点开显示「点击进一步分析」，按需调一次模型补摘要/锚点/四问/自测；
- **切块**：同一章节内的「定义—例子」「图—图注」会被配对合并（CLT 分割注意抑制）。

详见 [docs/DECOMPOSITION-METHOD.md](docs/DECOMPOSITION-METHOD.md)。

### 主要语言（知识图谱 / 摘要 / AI 对话）

顶栏「语言」可选 **简体中文（默认）/ English / 跟随文档**。无论原文是什么语言，
节点标题、摘要、别名、关系标签与 AI 对话正文都按该语言输出。

关键约束：**原文引文（quote）始终保留原语言、逐字不变** —— 引文参与锚点定位与引注核对，
一经翻译就会在原文里找不到，整条「有出处」链路随之失效。这条规则同时写进了
prompt（`llm/prompts/language.ts`）与验收用例。

实测：英文提问 + 语言=简体中文 → 模型用中文回答；引注仍引用英文原文。

验收：`node scripts/language-check.mjs`（含一次真实模型调用）。

### 中文书签（目录乱码已修）

中文 PDF 常见两种书签编码问题，都已处理：

- **我们生成的手册**：书签改用 UTF-16BE（带 BOM），`目录` 不再显示成 `ç®å½`；
- **第三方中文 PDF**：书签常把 GBK/UTF-8 字节直接塞进 PDF 字符串，阅读器按 PDFDocEncoding 解就是乱码。
  应用端会按「PDFDocEncoding 反查字节 → UTF-8 / GB18030 / Big5 严格解码」自动还原，
  只在有明显乱码特征时生效（正常西文标题不会被动）。旧版本导入的文档也会在下次打开时**自愈重建目录**。

验收：`node scripts/outline-encoding-check.mjs`（手册 13 条中文标题 + GBK 探针 `fixtures/outline-gbk-probe.pdf`）。

### 主题（默认羊皮卷）

顶栏右侧可切换 **📜 羊皮卷 / 🌙 夜读**，默认羊皮卷（暖纸底 `#f4ead6` + 深棕字 `#3b3025`），
长时间阅读比深色背景舒服。选择会持久化，刷新不闪浅色（首屏脚本先应用 `data-theme`）。
两套主题的关键文字对比度均 ≥ WCAG AA 4.5（正文 10.75、次要 5.16、强调 6.46…）。
截图：[theme-parchment.png](docs/theme-parchment.png) / [theme-night.png](docs/theme-night.png)。

插件形态下，应用底部有一条状态栏，**最下面一行最右边**是「返回 DSH」椭圆按钮
（与 RTL_Cockpit 启动按钮同款圆角/渐变/阴影/hover，点击回到打开本页的那个 DSH 页面）。

> **实测（2026-11-20）**：装在 `dsh web` 里，用宿主模型 `deepseek-flash` 跑真实抽取，
> 15 页论文 → 40 个知识点，用时 246 秒，引文可在原文定位。详见
> [docs/DSH-PLUGIN-LIVE.md](docs/DSH-PLUGIN-LIVE.md)。

卸载：`pnpm plugin:uninstall`。

### 独立运行（仅开发调试用）

```bash
LLM_MOCK=1 pnpm dev     # Vite 5173 + Hono 8787；需自己在 server/.env.local 配 Key
```

两种形态共用同一份前端代码，差异只在构建期两个变量（`VITE_BASE`、`VITE_API_BASE`）。

## 使用手册

📘 **[AKN-用户手册.pdf](docs/AKN-用户手册.pdf)** —— 15 页，13 章书签。**建议直接用本软件打开它**：
左栏目录可跳章，正文可划选标注，正好把产品功能走一遍。
重新生成：`node scripts/build-manual.mjs`（需要 google-chrome 与 ghostscript）。

## 快速开始

```bash
pnpm install            # 安装依赖（含 workspace）
cp .env.example server/.env.local   # 填入 DEEPSEEK_API_KEY（Step 3 起才真正需要）
pnpm dev                # 同时拉起 Vite(5173) 与 Hono(8787)
```

打开 http://localhost:5173 ，页面应显示「后端代理正常」。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 并行启动 `web`(5173) 与 `server`(8787) |
| `pnpm typecheck` | 全 workspace `tsc --noEmit` |
| `pnpm build` | 全 workspace 构建（web → dist，server → dist） |
| `pnpm test` | Vitest（web 跑领域 + 布局 + 流水线纯逻辑测试，当前 255 个用例） |
| `pnpm --filter @akn/web test` | 只跑前端测试 |
| `pnpm verify:ui` | 无头 Chrome 交互验收 Step 1（需先 `pnpm dev`） |
| `node scripts/step2-check.mjs` | Step 2：上传/目录/高亮/刷新恢复（21 项） |
| `LLM_MOCK=1 node scripts/step3-check.mjs` | Step 3：抽取/缓存/zod/图谱（20 项，需 `LLM_MOCK=1 pnpm dev`） |
| `node scripts/step4-check.mjs` | Step 4：双向联动/伴读/引注（16 项，需 mock dev） |
| `node scripts/step5-check.mjs` | Step 5：笔记/截图/Markdown 导出（16 项，需 mock dev） |
| `node scripts/step6-learning-dialog.mjs` | v1.2：学习对话框/知识点描述/图摘抄/跳原文（19 项 + 1 项按数据跳过，需 mock dev） |
| `node scripts/manual-check.mjs` | 手册自检：把使用手册当 PDF 用一遍（目录/跳页/抽取/知识点描述/图摘抄，8–10 项） |
| `pnpm build:plugin` | 以 `/akn/` 为基路径重新构建插件静态资源 |
| `pnpm test:plugin` | DSH 插件自测（假 ctx + 真实 HTTP，25 项） |
| `pnpm verify:plugin-manifest` | DSH 插件清单自检：标题/简介/图标/语言包/patch/engines/运行时解析/打包白名单（33 项） |
| `node scripts/plugin-live-check.mjs` | 实境验收：在运行中的 DSH 里用真实模型抽取 |
| `node scripts/plugin-ui-check.mjs` | 插件 UI 快检：底部状态栏 + 「返回 DSH」按钮（9 项） |
| `node scripts/theme-check.mjs` | 主题验收：默认羊皮卷 / 切换 / 刷新保持 / 无闪烁（9 项） |
| `node scripts/outline-scroll-check.mjs` | 左侧目录滚动验收（60 章探针，5 项） |
| `node scripts/outline-numbering-check.mjs` | 目录章节标志验收：编号 1 / 1.1 / 3.1.1 与「章」徽标（7 项） |
| `node scripts/flash-check.mjs` | 「跳到 PDF 原文」验收：下划线闪烁 + 高亮 + 清理（8 项） |
| `node scripts/flash-short-quote-check.mjs` | 短引文（中文术语）跳转：4 字必须画出下划线，2 字明确降级并提示（8 项） |
| `node scripts/bookmark-progress-check.mjs` | 目录三态掌握圈 + 章节书签 + 刷新后自动跳书签（23 项） |
| `node scripts/db-upgrade-check.mjs` | IndexedDB v1 → v2 迁移验收（不删库、新表建出来、老数据还在，6 项） |
| `node scripts/table-jump-check.mjs` | 图表/表格知识点跳原文：新抽取（caption 锚点）+ 旧数据（无锚点兜底）（14 项） |

## 目录

```
web/src/
  app/      布局骨架（三栏/拖拽/中栏 Tab）
  domain/   领域模型：实体类型、zod schema、nodeStyle 颜色状态机
  db/       Dexie 表结构与仓储层
  pdf/      pdf.js 装配、outline、高亮持久化、临时高亮、全文索引/锚点定位、图表区域渲染
  graph/    React Flow 图谱、节点组件、高亮↔节点匹配、学习对话框
  llm/      唯一出网口 + prompt（带版本）+ map-reduce 流水线 + 缓存
  chat/     伴读面板、流式、引注校验
  notes/    TipTap 编辑器、自定义节点、Markdown 序列化
  sync/     P1：三个同步目标的空实现
server/src/llm/     Hono 代理（SSE / extract / 413 / 重试 / 错误归一 / mock）
docs/     每步验收记录（STEP2–STEP5）与设计交付（ROUND1-DESIGN）
scripts/  ui-check.mjs + step2–step5 验收脚本（无头 Chrome + CDP，零第三方依赖）
fixtures/ 测试 PDF（15 页论文，含三级书签）
```

## 没有 API key 时如何验证

```bash
LLM_MOCK=1 pnpm dev     # 用本地 mock 上游跑通整条流水线（界面会显示「Mock 上游」）
```

mock 的响应带 `x-akn-mock: 1` 头，前端必须显示标识，**不会冒充真实模型结果**。
配好 `server/.env.local` 的 `DEEPSEEK_API_KEY` 后，普通 `pnpm dev` 即走真实 DeepSeek。

## 安全边界（硬性）

- DeepSeek API key **只**存在于 `server/.env.local`，前端代码 / 浏览器存储 / 构建产物中不得出现。
- 前端只有一个 `llmClient` 出口，业务代码禁止直接 `fetch` 到 LLM 域名；所有请求打到同源 `/api/*`，由 Vite 代理到 Hono。
- `.env.local` 已被 `.gitignore` 覆盖。
