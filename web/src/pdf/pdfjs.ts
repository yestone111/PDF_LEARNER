/**
 * PDF.js 运行时装配（唯一入口）。
 *
 * 关键事实（读库源码确认，不是猜的）：
 * - react-pdf-highlighter@8 的 PdfHighlighter 内部 `import("../../node_modules/pdfjs-dist/web/pdf_viewer.js")`
 *   使用它自带的 webpack 打包 viewer（自带 pdf.js 内部实现），而 PdfLoader 用的是顶层 `pdfjs-dist`。
 *   => 官方推荐姿势就是「顶层 pdfjs-dist 负责解析，自带 viewer 负责渲染」，我们照此办理。
 * - pdf.js v4 用 `new Worker(workerSrc, { type: "module" })` 起 worker，所以 workerSrc 必须是指向
 *   `.mjs` 模块文件的 URL。默认值是 unpkg CDN —— 本项目**必须**改成本地资源（离线可用、不依赖外网）。
 * - `getDocument({ data })` 会把 ArrayBuffer **转移（transfer）给 worker**，调用后原 buffer 会被 detach，
 *   所以这里一律传副本，避免把 IndexedDB 里要长期保存的字节弄丢。
 */

import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import type { PDFDocumentProxy } from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjsLib }

/** 从二进制加载 PDF。内部复制一份，保证调用方持有的 ArrayBuffer 仍然有效。 */
export async function loadPdfFromArrayBuffer(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const copy = new Uint8Array(data.slice(0))
  const task = pdfjsLib.getDocument({
    data: copy,
    // 不执行 PDF 内嵌的 JS（安全默认值）
    isEvalSupported: false,
  })
  return task.promise
}

export type { PDFDocumentProxy }
