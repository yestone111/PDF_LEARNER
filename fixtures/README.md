# fixtures/ —— 测试素材

## attention-is-all-you-need.pdf

- 来源：<https://arxiv.org/pdf/1706.03762v7>（公开论文，可自由分发用于测试）
- 大小：2,215,244 字节 / **15 页** / Letter 612×792
- SHA-256：`bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`
- 特点（正好覆盖 Step 2–3 的验收点）：
  - 有**真实文本层**（可做高亮、quote 定位、引注校验）
  - 有**三级书签 outline**（Introduction / Model Architecture → 3.x → 3.x.y），可验证目录树层级与点击跳页
  - outline 的 `dest` 是**命名目标**（如 `section.3`、`subsection.3.2.1`），
    解析页码必须走 `doc.getDestination(name)` → `doc.getPageIndex(ref)`，不能直接当页码用
  - 包含 Figure/Table 的 Caption（Step 3 的 `figure.kind='caption_only'` 占位节点有真实素材）

## akn-user-manual.pdf

- 本产品的《使用手册》，由 `node scripts/build-manual.mjs` 生成（15 页、13 条书签、真实文本层）
- 用途：① 发给使用者阅读；② 在应用里打开它「自读」，顺便验证书签目录 / 摘录 / 标注链路
- 自检脚本：`node scripts/manual-check.mjs`

## outline-gbk-probe.pdf

- 专用于验证**书签编码**：内容 2 页，书签标题以 GBK 字节直接写进 PDF 字符串
  （「目录」= `C4BF C2BC`、「第一章」= `B5DA D2BB D5C2`），模拟国产办公软件导出的中文 PDF。
- pdf.js 按规范解出来是 `Ä¿Â¼` / `µÚÒ»ÕÂ`，应用应自动还原成「目录」「第一章」。
- 验收脚本：`node scripts/outline-encoding-check.mjs`

## outline-utf8-probe.pdf

- 复现「旧版手册第 4/5 章乱码」：书签标题用 **UTF-8 字节**直接写进 PDF 字符串，
  且标题包含「习」（UTF-8 `E4 B9 A0`）。
- 关键坑：PDFDocEncoding 把 `0xA0` 映射成欧元符号 `€`（不是 Latin-1 的不换行空格），
  所以这类标题会被解成 `ä¹€`；反查表必须覆盖 0xA0 才能还原。
- pdf.js 原始解出：`4 ç¬¬ä¸•æ¬¡å­¦ä¹€ï¼ıäºﬂæ­¥èµ°`，应用应还原为 `4 第一次学习：五步走`。
- 验收脚本：`node scripts/outline-encoding-check.mjs`

## outline-many-probe.pdf

- 3 页、**60 条书签**（`Chapter 01 of Many` … `Chapter 60 of Many`），专用于验证左侧目录的滚动。
- 验收脚本：`node scripts/outline-scroll-check.mjs`（滚动容器、滚到底、最后一条可见、页面不被撑破）。

## 如何换成你自己的 PDF

把 PDF 丢进本目录任意命名即可。自动化流程的约定是：

1. 若 `fixtures/` 下存在**非** `attention-is-all-you-need.pdf` 的 `.pdf` 且能通过 `pdfinfo` 解析 → 优先使用它；
2. 否则回落到 `attention-is-all-you-need.pdf`；
3. 两者都没有 → 流程直接报错并停下（**不会**生成假 PDF 冒充真实文档）。

> 不要用下载不完整的 PDF：`pdfinfo` 会报 `Couldn't find trailer dictionary`。
> 下载后务必确认文件尾部有 `%%EOF`。
