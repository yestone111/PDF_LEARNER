import { defineConfig } from 'vitest/config'

/**
 * 纯逻辑测试只跑 node 环境：颜色状态机、实体合并、锚点定位、Markdown 序列化
 * 都不依赖 DOM，因此不引入 jsdom，保持测试快且稳定。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
  },
})
