#!/usr/bin/env node
/**
 * 生成《AI Knowledge Navigator 使用手册》PDF。
 *
 * 为什么不是「HTML 打印一下」就完事：
 * 手册要在本软件里阅读，就必须满足两点 —— ① 有真实文本层（能划选/摘录/引注核对）；
 * ② 有书签目录（左栏「文档目录」才能跳章）。Chrome 的 print-to-pdf 只能做到 ①，
 * 书签用 Ghostscript 的 pdfmark 补上，页码通过扫描打印出来的 PDF 自动定位。
 *
 * 用法：node scripts/build-manual.mjs
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const BUILD = join(root, 'docs/manual/.build')
const HTML = join(root, 'docs/manual/manual.html')
const RAW = join(BUILD, 'manual.raw.pdf')
const FINAL = join(BUILD, 'manual.final.pdf')
const OUT_DOCS = join(root, 'docs/AKN-用户手册.pdf')
const OUT_FIXTURE = join(root, 'fixtures/akn-user-manual.pdf')

/**
 * 书签：`marker` 是章节标题里的 ASCII 标记（HTML 里的 chapter-kicker），用来定位页码。
 * 不用中文标题定位的原因：Chrome 打印会把部分汉字映射成康熙部首/繁体码位
 * （例如「见」→「⻅」→ NFKC 后变「見」），中文匹配不可靠；ASCII 标记不受影响。
 */
const BOOKMARKS = [
  { title: '目录', marker: 'CONTENTS' },
  { title: '1 这是什么', marker: 'CHAPTER 01' },
  { title: '2 安装与运行', marker: 'CHAPTER 02' },
  { title: '3 界面导览', marker: 'CHAPTER 03' },
  { title: '4 第一次学习：五步走', marker: 'CHAPTER 04' },
  { title: '5 学习对话框详解', marker: 'CHAPTER 05' },
  { title: '6 PDF 阅读器', marker: 'CHAPTER 06' },
  { title: '7 AI 伴读', marker: 'CHAPTER 07' },
  { title: '8 笔记与 Markdown 导出', marker: 'CHAPTER 08' },
  { title: '9 数据、密钥与隐私', marker: 'CHAPTER 09' },
  { title: '10 常见问题', marker: 'CHAPTER 10' },
  { title: '附录 A：验收与自检命令', marker: 'APPENDIX A' },
  { title: '附录 B：术语表', marker: 'APPENDIX B' },
]

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(output)
      else rejectPromise(new Error(`${command} 退出码 ${code}\n${output.slice(-800)}`))
    })
  })
}

async function loadPdfjs() {
  const require = createRequire(join(root, 'web/package.json'))
  const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
  return import(pathToFileURL(entry).href)
}

async function readPdfPages(pdfjs, path) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(path)),
    useSystemFonts: true,
  }).promise
  const pages = []
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''))
  }
  return { doc, pages }
}

function normalize(text) {
  // Chrome 打印的中文常被映射成康熙部首码位，NFKC 折回汉字后再比对
  return [...text].map((char) => char.normalize('NFKC')).join('').replace(/\s+/g, '').toLowerCase()
}

async function main() {
  if (!existsSync(HTML)) throw new Error(`缺少手册源文件：${HTML}`)
  await rm(BUILD, { recursive: true, force: true })
  await mkdir(BUILD, { recursive: true })

  console.log('① Chrome 打印 HTML → PDF')
  await run('google-chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${join(BUILD, 'profile')}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${RAW}`,
    pathToFileURL(HTML).href,
  ])
  console.log(`   ${RAW} — ${(await readFile(RAW)).length} 字节`)

  console.log('② 扫描章节页码（用于书签）')
  const pdfjs = await loadPdfjs()
  const { doc, pages } = await readPdfPages(pdfjs, RAW)
  const normalized = pages.map(normalize)

  const marks = []
  for (const bookmark of BOOKMARKS) {
    const needle = normalize(bookmark.marker)
    const pageIndex = normalized.findIndex((text) => text.includes(needle))
    if (pageIndex === -1) throw new Error(`在打印结果里找不到章节标记：${bookmark.marker}`)
    marks.push({ title: bookmark.title, page: pageIndex + 1 })
    console.log(`   p.${String(pageIndex + 1).padStart(2, ' ')}  ${bookmark.title}`)
  }

  console.log('③ Ghostscript 注入书签（pdfmark）')
  // PDF 字符串规范只认 PDFDocEncoding 或 UTF-16BE（带 BOM）。
  // 直接写 PostScript 字面串会把 UTF-8 字节原样塞进去 → 阅读器显示乱码（「目录」→「ç®å½」）。
  // 用十六进制串写 UTF-16BE + BOM，pdf.js / Acrobat / 预览都能正确解出中文。
  const toUtf16BeHex = (text) =>
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
      .toString('hex')
      .toUpperCase()

  const ps = marks
    .map((mark) => `[ /Title <${toUtf16BeHex(mark.title)}> /Page ${mark.page} /OUT pdfmark`)
    .join('\n')
  const marksPath = join(BUILD, 'bookmarks.ps')
  await writeFile(marksPath, `${ps}\n`, 'utf8')

  await run('gs', [
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    '-sDEVICE=pdfwrite',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    `-sOutputFile=${FINAL}`,
    RAW,
    marksPath,
  ])

  console.log('④ 校验：页数 / 书签 / 文本层')
  const verified = await readPdfPages(pdfjs, FINAL)
  const outline = await verified.doc.getOutline()
  if (outline === null) throw new Error('校验失败：合并后没有书签')
  if (outline.length !== BOOKMARKS.length) {
    throw new Error(`校验失败：书签数 ${outline.length} ≠ ${BOOKMARKS.length}`)
  }
  if (verified.doc.numPages !== doc.numPages) {
    throw new Error(`校验失败：页数变化 ${doc.numPages} → ${verified.doc.numPages}`)
  }

  const outlineTitles = outline.map((item) => item.title)
  const expectedTitles = BOOKMARKS.map((bookmark) => bookmark.title)
  if (JSON.stringify(outlineTitles) !== JSON.stringify(expectedTitles)) {
    throw new Error(`校验失败：书签标题编码不正确\n  实际：${JSON.stringify(outlineTitles.slice(0, 3))}\n  期望：${JSON.stringify(expectedTitles.slice(0, 3))}`)
  }

  const firstPageText = verified.pages[2] ?? ''
  if (!firstPageText.includes('这是什么')) throw new Error('校验失败：文本层异常（找不到章节标题）')

  console.log(`   页数 ${verified.doc.numPages} · 书签 ${outline.length} 条 · 文本层正常`)

  console.log('⑤ 输出')
  await copyFile(FINAL, OUT_DOCS)
  await copyFile(FINAL, OUT_FIXTURE)
  const size = (await readFile(FINAL)).length
  console.log(`   ${OUT_DOCS}`)
  console.log(`   ${OUT_FIXTURE}`)
  console.log(`   ${(size / 1024).toFixed(0)} KB`)
  await rm(BUILD, { recursive: true, force: true })
}

main().catch((error) => {
  console.error('❌ 生成手册失败：', error.message)
  process.exitCode = 1
})
