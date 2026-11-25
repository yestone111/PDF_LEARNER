/**
 * PDF 文本编码修复。
 *
 * 背景：PDF 的书签标题（outline title）是「PDF 字符串」，规范里只有两种编码
 * （PDFDocEncoding 或带 BOM 的 UTF-16BE）。但大量中文 PDF（Word/WPS/某些生成器）
 * 直接把 GBK/UTF-8 字节塞进 PDF 字符串里，阅读器按 PDFDocEncoding 解出来就是乱码：
 *   「目录」→「ç®å½」（UTF-8 字节被按 PDFDocEncoding 解）
 *   「目录」→「Ä¿Â¼」（GBK 字节被按 PDFDocEncoding 解）
 * pdf.js 只做规范解码，所以这种事只能我们自己兜。
 *
 * 策略（**只在有明显乱码特征时**才动手，绝不乱改正常标题）：
 *  1. 标题里已有汉字 → 认为正常，原样返回；
 *  2. 标题全部落在 Latin-1 / PDFDocEncoding 范围内，且含 ≥2 个高位字符 → 认为是被误解码的字节流；
 *  3. 把字符按 PDFDocEncoding 反查回字节，依次用 UTF-8 → GB18030 → Big5 严格解码；
 *  4. 哪个解出汉字就用哪个；一个都解不出就保留原文（宁可不修，也不改错）。
 */

/** PDFDocEncoding 0x80–0x9F 的特殊映射（用于把字符反查回原始字节）。 */
const PDFDOC_SPECIAL_TO_BYTE: Readonly<Record<number, number>> = {
  0x2022: 0x80,
  0x2020: 0x81,
  0x2021: 0x82,
  0x2026: 0x83,
  0x2014: 0x84,
  0x2013: 0x85,
  0x0192: 0x86,
  0x2044: 0x87,
  0x2039: 0x88,
  0x203a: 0x89,
  0x2212: 0x8a,
  0x2030: 0x8b,
  0x201e: 0x8c,
  0x201c: 0x8d,
  0x201d: 0x8e,
  0x2018: 0x8f,
  0x2019: 0x90,
  0x201a: 0x91,
  0x2122: 0x92,
  0xfb01: 0x93,
  0xfb02: 0x94,
  0x0141: 0x95,
  0x0152: 0x96,
  0x0160: 0x97,
  0x0178: 0x98,
  0x017d: 0x99,
  0x0131: 0x9a,
  0x0142: 0x9b,
  0x0153: 0x9c,
  0x0161: 0x9d,
  0x017e: 0x9e,
  /** PDFDocEncoding 里 0xA0 是欧元符号（不是 Latin-1 的不换行空格）。
   *  实测踩坑：UTF-8 字节 E4 B9 A0（「习」）会被解成「ä¹€」，漏了这个映射就修不回来。 */
  0x20ac: 0xa0,
}

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

export function countCjk(text: string): number {
  let count = 0
  for (const char of text) if (CJK_PATTERN.test(char)) count += 1
  return count
}

/** 把「被按错误编码解出来的字符串」还原成字节；失败返回 null。 */
export function toPdfBytes(text: string): Uint8Array | null {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0xff) {
      bytes.push(code)
      continue
    }
    const mapped = PDFDOC_SPECIAL_TO_BYTE[code]
    if (mapped === undefined) return null
    bytes.push(mapped)
  }
  return Uint8Array.from(bytes)
}

const DECODE_CANDIDATES = ['utf-8', 'gb18030', 'big5'] as const

/**
 * 修复被错误解码的 PDF 文本（主要面向书签标题）。
 * 已经是正常文本时原样返回。
 */
export function repairPdfText(raw: string): string {
  const text = raw.replace(/^\uFEFF/, '')
  if (text === '') return text
  if (countCjk(text) > 0) return text

  const bytes = toPdfBytes(text)
  if (bytes === null) return text

  // 纯 ASCII 就别折腾，避免把正常英文标题改坏。
  // 只要有高位字节就尝试：UTF-8/GB18030/Big5 都用 fatal 严格解码，普通西文标题
  // （Café、Résumé）解不成汉字，会原样返回，不会误改。
  const highBytes = [...bytes].filter((byte) => byte >= 0x80).length
  if (highBytes === 0) return text

  // 按优先级取**第一个**严格解码成功且含汉字的候选，不比较「谁汉字更多」。
  // 理由：同一段字节 UTF-8 与 GB18030 可能都能解，但 UTF-8 是自校验编码，
  // 偶然有效即极可能是真 UTF-8；按汉字数量比较会选错（实测把「界面导览」解成「鐣岄潰瀵艰」）。
  for (const encoding of DECODE_CANDIDATES) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes)
      if (decoded.includes('\uFFFD')) continue
      if (countCjk(decoded) > 0) return decoded
    } catch {
      // 该编码解不了，换下一个
    }
  }

  return text
}
