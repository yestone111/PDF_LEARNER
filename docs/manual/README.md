# 使用手册（PDF）的源与构建

- 源文件：`manual.html`（手写 HTML + 打印用 CSS）
- 构建脚本：`scripts/build-manual.mjs`
- 产物：
  - `docs/AKN-用户手册.pdf`（发给用户的那份）
  - `fixtures/akn-user-manual.pdf`（同一份，放在 fixtures 里方便在应用内打开自读）

## 为什么不是一个「导出 PDF」按钮就完事

手册要在本产品里阅读，必须同时满足：

1. **有真实文本层** —— 才能划选、摘录、给 AI 提供引文；
2. **有书签目录** —— 左栏「文档目录」才能跳章。

Chrome 的 `--print-to-pdf` 只能保证 ①；书签用 Ghostscript 的 `pdfmark` 在打印后注入，
章节页码通过扫描打印结果的文本自动定位（书签数值不靠手写，改内容不会错位）。

## 重新生成

```bash
node scripts/build-manual.mjs
```

依赖：`google-chrome`、`gs`（Ghostscript）。脚本会自检：页数、书签条数、文本层是否可读，
任何一项不符直接失败退出，不会产出半成品。

## 两个已知的坑（都已在脚本里处理）

1. **Chrome 打印的中文会被映射成康熙部首码位**：`目录` 会变成 `⽬录`（U+2F6C）。
   这会让「用中文标题找页码」失效，也会让产品的引文匹配失效。
   处置：产品侧 `textIndex.ts` / `anchor.ts` / `citation.ts` 全部做逐字符 NFKC 折回；
   手册构建侧改用 **ASCII 章节标记**（`CHAPTER 01`）定位页码，彻底不依赖中文字形。
2. **书签页码必须来自扫描结果**：手写页码在改内容后必然错位，脚本对每章做标记匹配后写入。
