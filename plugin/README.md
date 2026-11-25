# AI Knowledge Navigator —— DSH 插件

把 PDF 变成可点击的知识图谱。作为 **DeepSeek Harness 插件**运行：

- **不需要配置任何 API Key** —— 模型走宿主进程内的 `ctx.llm`，复用 DSH 当前选中的模型与凭证；
- 前端构建产物挂在 DSH Web 的同源路径 `/akn/`；
- LLM 桥接在 `/api/akn/llm/*`，请求不出本机、Key 不进浏览器。

## 插件页会显示什么（DSH 清单规则）

| 展示项 | 来源 | 文件 |
| --- | --- | --- |
| 标题 | `locale/*.json` → `meta.title`（中文界面取 `zh`，英文取 `en`） | `locale/en.json`、`locale/zh.json` |
| 简介 | `locale/*.json` → `meta.description`，缺省回退 `package.json.description` | 同上 |
| 图标 | `package.json.icon`（相对路径、svg/png/jpeg/webp、≤256 KiB） | `icon.svg` |
| 兼容性 | `engines.dsh`（`>=0.2.0-rc.2`） | `package.json` |

语言包必须通过 `exports` 暴露（`"./locale/*": "./locale/*"`），否则运行时解析不到、静默回退成包名。
完整规则与常见坑见仓库根 `docs/DSH-PLUGIN.md`，自检：`pnpm verify:plugin-manifest`。

## 安装

```bash
dsh plugin --profile web add /home/yeshi/work/PDF_learner/ai-knowledge-navigator/plugin
```

然后重启（或等 profile HMR 重载）`dsh web`。

界面右下角会出现**第二颗与 RTL_Cockpit 同款的椭圆按钮**：

| | RTL_Cockpit | 本插件 |
| --- | --- | --- |
| 位置 | `right:18px; bottom:18px` | `right:18px; bottom:66px`（叠在它上面，间距 10px） |
| 尺寸 | 高 38px / 圆角 20px / 内边距 `0 15px 0 12px` | 同上 |
| 图标文案 | 🧭 RTLCockpit | 📚 PDF 学习 |
| 渐变主色 | `#3b6fe0 → #5a43d6` | `#2f6bd8 → #1f9d7a` |
| 点击 | 就地进入 `/rtlcockpit/`；修饰键新标签 | 就地进入 `/akn/`；修饰键新标签 |

如果要让两颗按钮颜色完全一致，改 `lib/client.js` 里 `.fab` 的 `background` 一行即可。

卸载：

```bash
dsh plugin --profile web remove akn
```

## 中文书签乱码

中文 PDF 的书签标题经常不是规范编码（GBK/UTF-8 字节直接写进 PDF 字符串），阅读器会显示成 `Ä¿Â¼`。
本插件在构建目录时做确定性还原（PDFDocEncoding 反查字节 → UTF-8 / GB18030 / Big5 严格解码），
只在检测到乱码特征时生效；已导入过的旧文档会在下次打开时自动重建目录。

## 知识图谱的读法

两组：**① 全文档总览**（核心知识点，从左到右按依赖排列，脑图式）与 **② 章节拆解**（更细，节点锚定原文核心点）。

- 大小 = 关联程度（连边数，48–96px）
- 颜色深浅 = 掌握难度（difficulty 1–5，越深越难）
- 红/绿 = 未掌握/已掌握（点节点内圆点切换，尺寸与深浅不变）

布局为左→右分层（拓扑排序），确定性；有环时环上节点放最后一层。

框架关系由模型**理解后**建立（`global-reduce@6`）：汇总阶段输入包含每个知识点的摘要与跨章节覆盖，
先识别 3–8 个总纲概念，其余按语义 `belongs_to` 归属；**不按章节机械分组**。

## 主要语言

顶栏「语言」：简体中文（默认）/ English / 跟随文档。知识图谱（节点标题、摘要、别名、关系标签）
与 AI 对话正文按该语言输出；**原文引文始终逐字保留原语言**，以便锚点定位与引注核对。
改语言会让 prompt 版本升级（`chunk-extract@3` / `global-reduce@3`），旧缓存自动失效。

## 主题

顶栏可切换 **📜 羊皮卷（默认）/ 🌙 夜读**。所有颜色收敛为 `--akn-*` 语义令牌，
由 `<html data-theme>` 整体切换；组件里不再有硬编码的 `bg-black/xx`、`bg-white/xx`。
羊皮卷下关键文字对比度全部 ≥ WCAG AA 4.5。

## 应用内的「返回 DSH」

插件形态下，应用底部有一条 32px 状态栏，最右侧是「返回 DSH」椭圆按钮：

- 位置：`footer` 最右（`right` 留 12px、距底 2px）—— 不用 fixed 浮层，是因为浮层会盖住右栏的聊天输入框；
- 样式：与 RTL_Cockpit 启动按钮同款（渐变 `#3b6fe0 → #5a43d6`、胶囊圆角、同款阴影与 hover 位移）；
- 行为：普通点击回到**打开本页的那个 DSH 页面**（用 `document.referrer` 还原，取不到则回 `/`）；
  Ctrl/Cmd/Shift/中键走浏览器默认（新标签）；
- 独立运行时整条状态栏不渲染（构建期 `VITE_DSH_PLUGIN=1` 才开启）。

## 它怎么拿到模型

```js
const llm = ctx.get('llm')                                   // DSH 的 LLM 服务
const selection = ctx.get('agentDefaultModel').currentSelection()  // { provider, model }
const prepared = await llm.prepareCall({ provider, model }, signal)
for await (const chunk of prepared.stream({ ...prepared.config, messages, system })) {
  // chunk.type === 'text-delta' → chunk.text
}
```

没有选中模型时返回明确的 `503 NO_MODEL`，不会偷偷换一个模型或伪造结果。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/akn/` | 应用页面（SPA） |
| GET | `/akn/assets/*` | 静态资源（长缓存；缺失真 404） |
| GET | `/api/akn/health` | 健康检查（含当前 provider/model） |
| GET | `/api/akn/llm/status` | `{configured, mock:false, model, provider, mode:'in-process'}` |
| POST | `/api/akn/llm/extract` | 结构化抽取，返回模型原始文本（zod 校验在前端做） |
| POST | `/api/akn/llm/chat` | SSE 流式，帧格式与独立运行一致（前端零改动） |

## 与独立运行的区别

| | 独立运行 | DSH 插件 |
| --- | --- | --- |
| 启动 | `pnpm dev`（Vite 5173 + Hono 8787） | DSH web（单端口，同源） |
| API 基址 | `/api` → Hono 代理 | `/api/akn` → 进程内 `ctx.llm` |
| API Key | `server/.env.local` 自行配置 | **复用 DSH 已配置的模型，无需配置** |
| IndexedDB | 按 5173 源隔离 | 按 DSH 源隔离（与独立运行的数据不互通） |

## 安全说明

- 插件默认不校验浏览器会话（`requireBrowserAuth` 默认 false），因为 DSH web 通常只监听本机。
  如果你把 DSH 暴露到局域网/公网，请在 patch 里打开：

  ```yaml
  - id: akn
    name: 'akn'
    config:
      requireBrowserAuth: true
  ```

- 浏览器侧只拿到 SSE 文本，拿不到 Key；Key 始终在宿主进程。
- 请求体上限 2MB，超限返回 413（与独立运行一致）。

## 实境验证（真实模型）

2026-11-20 在本机 `dsh web` 上实测：`/api/akn/llm/status` 返回
`{"configured":true,"mock":false,"model":"deepseek-flash","provider":"deepseek-official","mode":"in-process"}`；
15 页论文真实抽取产出 40 个知识点（246s），引文可在原文定位。
过程记录（含两个真实调用才暴露的契约问题与修法）见 [../docs/DSH-PLUGIN-LIVE.md](../docs/DSH-PLUGIN-LIVE.md)。

实境验收脚本：`node scripts/plugin-live-check.mjs`；UI 快检：`node scripts/plugin-ui-check.mjs`。

## 构建

```bash
node scripts/build-plugin.mjs   # 以 base=/akn/、api=/api/akn 重新构建前端并拷进 plugin/static
node scripts/plugin-selftest.mjs  # 用假 ctx + 真实 HTTP 自测（21 项）
```
