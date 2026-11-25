# Step 5 交付：笔记、Markdown 导出、同步占位

## 1. 落地内容

| 能力 | 实现 |
| --- | --- |
| 富文本笔记 | TipTap 3 + StarterKit，自定义原子节点：`nodeCard` / `highlightQuote` / `chatCard` / `graphImage` |
| 混排插入 | 选中图谱节点→节点卡片；最新 PDF 高亮→原文引用块；待插入 AI 回答→回答卡片；`html-to-image` 截 `react-flow` → PNG |
| 持久化 | `NoteDoc` 落 Dexie（600ms 防抖），刷新恢复；zod 校验后才写库 |
| Markdown 导出（P0） | `notes/markdown.ts` 纯函数：自定义节点有确定降级表示；图片默认 inline base64，超阈值降级占位 + 文首提示 |
| 导出预览 | 导出弹窗直接展示**真实序列化结果**（不是另一条渲染路径），可下载 `.md` |
| 同步（P1） | `sync/providers.ts`：Obsidian / Notion / 飞书 三个 `SyncProvider` 空实现 + 配置校验，调用即返回「P1 未实现」，**不发真实请求** |

## 2. Markdown 降级约定（第一轮 Q2 的落地）

| TipTap 节点 | Markdown |
| --- | --- |
| 段落 / 标题 / 列表 / 引用 / 代码块 | 标准 Markdown |
| `nodeCard` | `> **【节点】标题**` + `> 重要度 ★★★★★ · 状态：已掌握` |
| `highlightQuote` | `> 原文` + `> — p.4` |
| `chatCard` | `> **【AI】** 回答` + `> 出处：p.6「原文」` 或 `> 出处：无直接出处（模型声称：…）` |
| `graphImage` / `image` | `![alt](data:image/png;base64,…)`；单图 >1.5MB 或全篇 >8MB → `![alt](akn-assets/image-N.png)` + 文首提示 |

## 3. 验收记录（16/16）

`node scripts/step5-check.mjs`（真实上传→抽取→选节点→写笔记→插图→导出→刷新）：

```
✅ 图谱中选中了一个节点 — Experiments on two machine translation tasks sho
✅ 笔记面板是真实 TipTap 编辑器（不是占位）
✅ 插入图谱节点卡片
✅ 插入 AI 回答卡片
✅ 图谱截图以 PNG data URI 插入 — data:image/png;base64,iVBORw0K…
✅ 截图有实际像素（非空图） — naturalWidth=762
✅ 导出的 Markdown 含普通段落
✅ 节点卡片降级为引用块
✅ AI 卡片降级为引用块
✅ AI 出处行符合「无直接出处 / p.N」约定 — 出处：p.1「Provided proper attribution…」
✅ 图片按 inline base64 内联
✅ 导出不产生降级（默认阈值内）
✅ 刷新后笔记正文恢复
✅ 刷新后自定义节点恢复
✅ 同步目标以 P1 占位出现（obsidian/notion/feishu）
✅ 页面全程无未捕获异常
通过 16 项，失败 0 项
```

截图：`docs/step5-screenshot.png`。

## 4. 验收中抓到的真 bug

第一次跑时 AI 回答卡片在导出里消失了。排查方式：把导出时的 `editor.getJSON()` 的节点类型打印出来，看到 `["paragraph","nodeCard","graphImage","paragraph"]` —— **chatCard 根本不在文档里**。

原因：TipTap 的 `insertContent` 会**替换当前选区**，而插入原子节点后该节点处于选中态；下一次插入（图谱截图）就把上一次插入的节点覆盖掉了。

修法：所有「插入卡片/截图」统一 `chain().focus('end').insertContent(...)`，即一律追加到文末。这类 bug 只有真跑交互才暴露，单测抓不到。

## 5. 已知限制

- 图片以 data URI 存在笔记 JSON 里（自包含、导出简单），代价是 IndexedDB 体积偏大；>1.5MB 的图仅导出降级，未做压缩。
- 笔记暂无多篇/目录管理（单文档单篇），P0 够用。
- 同步三目标只有接口与配置校验，无 UI 配置表单（任务书允许 P1 只留接口）。
- PDF 导出（P1）未实现。
