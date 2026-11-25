# DSH 插件应遵守的描述规则（AI Knowledge Navigator 对照版）

> 依据 DSH 运行时（本机 `dsh --version` = `0.2.0-rc.2`）里真正会读这些字段的代码：
> - `@deepseek-ai/dsh-package-manifest` 的 `DshPackageManifest` / `DshManifest` / `PluginLocalizedMeta` 类型
> - `@deepseek-ai/dsh-app-boot` 的 `readPluginMeta()`（展示标题/简介/图标的解析器）
> - `@deepseek-ai/dsh-plugin-manager` 的插件页（把 `meta` 渲染成标题、简介、图标）
>
> 仓库自检：`pnpm verify:plugin-manifest`（33 项，见 `scripts/plugin-manifest-check.mjs`）。

## 1. 包结构：一个 npm 包 + `dsh` 清单

| 字段 | 要求 | 本仓库 |
| --- | --- | --- |
| `name` | 必填；插件页/市场用它做技术名回退 | `akn` |
| `version` | 必填，SemVer | `1.3.0` |
| `description` | 必填（展示回退简介，一句话） | 英文一句话，见 `plugin/package.json` |
| `type` | 必须是 `module` | `module` |
| `main` | 宿主半入口 | `lib/index.js` |
| `exports["."]` | 宿主半（Cordis 插件，导出 `name`/`apply`） | `./lib/index.js` |
| `exports["./client"]` | 浏览器半（`window.__ModuleLoader__.load`） | `./lib/client.js` |
| `exports["./package.json"]` | 运行时读清单要用 | 已声明 |
| `dsh.bundle.patch` | 组合包 patch 文件（可多份，按顺序），路径相对包根 | `./cordis.patch.yml` |
| `dsh.client.platform` | 客户端平台，Web 用 `"web"` | `web` |
| `dsh.client.inject` | 只是「包名依赖」的说明，不是 Cordis 注入 | `["@deepseek-ai/dsh-client-runtime"]` |
| `dsh.client.external` | 除基线外还要从模块表取的确切模块（可含子路径） | 未用 |
| `engines.dsh` | SemVer range，与 `dsh --version` 比对 | `>=0.2.0-rc.2` |
| `engines.node` | Node 版本 | `>=20` |

patch 文件的硬约束：**行的 `name` 必须等于 npm 包名**（也是宿主半导出的 name）。

```yaml
# plugin/cordis.patch.yml
- insert:
    - id: akn
      name: 'akn'
```

## 2. 展示元信息（标题 / 简介 / 图标）——「描述规则」的核心

插件页显示的标题、简介、图标来自 `readPluginMeta(包名, 解析基准)`，解析顺序：

### 2.1 标题与简介

1. 先找包导出的 `locale/en.json`（通过 Node ESM 解析 `${包名}/locale/en.json`，**所以 `exports` 必须暴露 locale**）；
2. 再读 **同一目录下所有 `*.json`** 作为语言包（文件名必须是语言 id，如 `zh.json`）；
3. 每个语言包形如：

```json
{ "meta": { "title": "AI 知识导航仪", "description": "把硬核 PDF 变成可点击的知识图谱…" } }
```

4. 回退链：
   - 标题：`locale/*.json` 的 `meta.title` → `package.json.name`
   - 简介：`locale/*.json` 的 `meta.description` → `package.json.description`
   - `en` 始终作为回退语言；最终兜底是包名（标题）/ 空串（简介）
5. 语言包里的字段必须是非空字符串；`locale` 目录里放非语言包的 JSON 会导致整个元信息报 `meta.error`。

### 2.2 图标

`package.json.icon` 指向包内文件，规则很具体（违反只降级为 `meta.error`，不影响插件加载）：

- 必须是**相对路径**，不能是绝对路径或 URL；
- 扩展名只能是 `.svg` / `.png` / `.jpg` / `.jpeg` / `.webp`；
- realpath 之后必须仍在清单所在目录内；
- 必须是普通文件，且 ≤ **256 KiB**；
- 运行时会被读成 `data:` URL 直接渲染（不是 `<img src=URL>`）。

### 2.3 其他展示相关

- `keywords` 建议包含 `dsh-plugin`、`deepseek-harness`（生态检索习惯）；
- `repository` / `homepage` / `bugs` 便于插件页与市场跳转；
- `private: true` 只用于「明确不发布到 npm」的本地包。

## 3. 打包 / 安装 / 版本

- `files` 白名单要覆盖：`lib`、`static`、`locale`、`icon.svg`、`cordis.patch.yml`、`README.md`（否则发布后丢文件）；
- 安装：`dsh plugin --profile web add ./plugin`；本仓库的 profile 用 `link:` 指向本地目录，改完源码 + `pnpm build:plugin` 再刷新即可；
- 插件版本与 DSH 版本独立；`engines.dsh` 不满足时安装/启动会被拒绝，需要 `dsh plugin --profile web allow-version <pkg@ver> --dsh-version <runtime> --accept-risk` 显式豁免；
- 构建产物 `plugin/static/` 不入库（`.gitignore`），clone 后 `pnpm build:plugin` 生成。

## 4. 自检清单

```bash
pnpm verify:plugin-manifest        # 33 项：清单/图标/语言包/patch/engines/运行时解析/打包白名单
node scripts/plugin-selftest.mjs   # 25 项：假 ctx + 真实 HTTP，验证宿主半与 LLM 桥
node scripts/plugin-ui-check.mjs   # 9 项：在运行中的 DSH 页面里验证浮动按钮/返回 DSH
```

## 5. 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件页标题显示包名 `akn`、没有中文标题 | `exports` 没暴露 `./locale/*`，或没有 `locale/en.json` | 补 `exports["./locale/*"]` 和 `locale/{en,zh}.json` |
| 插件页提示 meta.error | `locale` 目录里有非语言包 JSON / 字段不是非空字符串 / 图标超 256 KiB 或出目录 | 按第 2 节修 |
| 插件加载失败 | patch 行 `name` ≠ 包名，或 `exports["."]` 不对 | 对齐包名与入口 |
| 安装被拒 `incompatible-version` | `engines.dsh` 与运行时不符 | 改 range，或走 `allow-version` 豁免 |
| 浏览器半加载不到 | 没有 `exports["./client"]` 或没在 `dsh.client.platform` 声明 | 补 exports 与 platform |
