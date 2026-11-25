import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Vite 配置（Step 0 最小可用版本）。
 * - 5173：前端 dev server，strictPort 保证端口固定，便于 curl 验收
 * - /api 反向代理到 Hono（8787），前端因此永远同源，不需要 CORS，也不会直连 LLM 域名
 */
// 嵌进 DSH 插件时用 VITE_BASE=/akn/ 构建，静态资源才会走 /akn/assets/*
const base = process.env.VITE_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
