/** 统一 id 生成。所有表主键都用随机 UUID 字符串（第一轮 Q11），便于离线导入/合并。 */
export function newId(): string {
  return crypto.randomUUID()
}
