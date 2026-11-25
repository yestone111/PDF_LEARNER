#!/usr/bin/env node
/**
 * 构建 DSH 插件包：把前端以 /akn/ 为基路径构建，产物拷进 plugin/static。
 *
 * 与独立运行的区别只有两个环境变量：
 *   VITE_BASE=/akn/          静态资源走 /akn/assets/*
 *   VITE_API_BASE=/api/akn   所有 API 请求走插件桥接（进程内 ctx.llm）
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'web/dist')
const target = join(root, 'plugin/static')

console.log('① 构建前端（base=/akn/，api=/api/akn）')
execFileSync('pnpm', ['--filter', '@akn/web', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_BASE: '/akn/', VITE_API_BASE: '/api/akn', VITE_DSH_PLUGIN: '1' },
})

console.log('② 拷贝构建产物 → plugin/static')
rmSync(target, { recursive: true, force: true })
cpSync(dist, target, { recursive: true })
if (!existsSync(join(target, 'index.html'))) throw new Error('缺少 index.html')

console.log('③ 自检')
const html = readFileSync(join(target, 'index.html'), 'utf8')
if (!html.includes('/akn/assets/')) throw new Error('index.html 里的资源路径没有带上 /akn/ 前缀')
const bundleName = /src="\/akn\/(assets\/[^"]+\.js)"/.exec(html)?.[1]
if (bundleName === undefined) throw new Error('找不到主 bundle')
const bundle = readFileSync(join(target, bundleName), 'utf8')
// 压缩后字符串是模板字面量（反引号），所以只校验片段，不校验引号形式
if (!bundle.includes('/api/akn')) throw new Error('主 bundle 里没有 /api/akn 基址')
if (bundle.includes('/api/llm/')) throw new Error('主 bundle 里仍存在旧的 /api/llm 硬编码')
if (!bundle.includes('return-to-dsh')) throw new Error('插件版 bundle 里缺少「返回 DSH」按钮')
const worker = [...html.matchAll(/\/akn\/assets\/[^"]+\.mjs/g)].map((match) => match[0])
for (const asset of worker) {
  if (!existsSync(join(target, asset.replace('/akn/', '')))) throw new Error(`缺失资源 ${asset}`)
}

const size = execFileSync('du', ['-sh', target], { encoding: 'utf8' }).split('\t')[0]

console.log(`   index.html ✓  /akn/ 前缀 ✓  /api/akn 基址 ✓  静态资源 ${worker.length} 个 ✓`)
console.log(`   plugin/static = ${size}`)
console.log('\n④ 安装到 DSH profile')
console.log(`   dsh plugin --profile web add ${join(root, 'plugin')}`)
