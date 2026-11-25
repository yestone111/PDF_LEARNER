/** 内容哈希：用于缓存 key 的块指纹（Web Crypto，浏览器与 Node 都可用）。 */

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  let hex = ''
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * 块指纹 = sha256(文本 + 起始页 + 章节标题) 前 16 位。
 * 把页码和章节标题也纳入哈希：同样的文本出现在不同章节时，不应共用缓存。
 */
export async function hashChunk(input: {
  readonly text: string
  readonly pageStart: number
  readonly outlineTitle: string | null
}): Promise<string> {
  const material = `${input.text}\u0000${input.pageStart}\u0000${input.outlineTitle ?? ''}`
  const full = await sha256Hex(material)
  return full.slice(0, 16)
}
