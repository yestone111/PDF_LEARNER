#!/usr/bin/env node
/**
 * DSH 插件清单自检（无第三方依赖）。
 *
 * 依据（DSH 运行时源码 `@deepseek-ai/dsh-app-boot` 的 readPluginMeta 与
 * `@deepseek-ai/dsh-package-manifest` 的 DshPackageManifest / DshManifest 类型）：
 *
 * 1) package.json 必填 name / version；description 用于插件市场与插件页展示；
 * 2) 展示元信息解析顺序：
 *      标题 ← locale/<lang>.json 的 meta.title → package.json.name
 *      简介 ← locale/<lang>.json 的 meta.description → package.json.description
 *     图标 ← package.json.icon（相对路径、只能是 svg/png/jpeg/webp、必须在包目录内、≤256 KiB）
 *   语言文件通过 Node ESM 解析 `${包名}/locale/<lang>.json`，因此 exports 必须暴露 locale；
 *   locale 目录里**所有** *.json 都会被当成语言包读取，文件名必须是语言 id；
 * 3) 组合包声明：dsh.bundle.patch 指向 patch 文件（相对包根），patch 行 name 必须等于包名；
 * 4) 客户端声明：dsh.client.platform（Web 端为 "web"）；
 * 5) 兼容性：engines.dsh 是 SemVer range，会与 `dsh --version` 比对（不兼容需显式豁免）。
 *
 * 这个脚本只校验本仓库插件的清单结构，不替换 DSH 运行时自己的校验。
 */

import { readFileSync, readdirSync, statSync, realpathSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, extname, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pluginDir = resolve(root, 'plugin')
const pkgPath = resolve(pluginDir, 'package.json')

let pass = 0
const failures = []
const notes = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const note = (name, detail) => { notes.push(name); console.log(`⏭️  ${name}${detail ? ` — ${detail}` : ''}`) }

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

/* ---------------- 1. 基本字段 ---------------- */
check('package.json 有 name', typeof pkg.name === 'string' && pkg.name.trim() !== '', pkg.name)
check('package.json 有 version（SemVer）', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? ''), pkg.version)
check('description 非空（插件页/市场展示用的回退简介）', typeof pkg.description === 'string' && pkg.description.trim() !== '', `${(pkg.description ?? '').length} 字符`)

/* ---------------- 2. 导出入口 ---------------- */
const exportsMap = pkg.exports ?? {}
check('exports 暴露宿主半 "."', typeof exportsMap['.'] === 'string' || typeof exportsMap['.'] === 'object', JSON.stringify(exportsMap['.']))
check('exports 暴露客户端半 "./client"', typeof exportsMap['./client'] === 'string' || typeof exportsMap['./client'] === 'object', JSON.stringify(exportsMap['./client']))
check('exports 暴露 "./package.json"（运行时读清单用）', exportsMap['./package.json'] !== undefined)

/* ---------------- 3. 图标 ---------------- */
if (pkg.icon === undefined) {
  note('icon', '未声明 icon（插件页用默认占位图）')
} else {
  const icon = pkg.icon
  const allowed = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
  const relativeOk = typeof icon === 'string' && icon.trim() !== '' && !isAbsolute(icon) && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)
  check('icon 是相对路径（不能绝对路径/URL）', relativeOk, icon)
  const iconPath = resolve(pluginDir, icon)
  check('icon 文件存在且是普通文件', existsSync(iconPath) && statSync(iconPath).isFile(), icon)
  check('icon 扩展名必须是 svg/png/jpeg/webp', allowed.has(extname(icon).toLowerCase()), extname(icon))
  const dir = realpathSync(pluginDir)
  const file = realpathSync(iconPath)
  const inside = !relative(dir, file).startsWith('..')
  check('icon 必须在插件目录内（realpath 之后）', inside, relative(dir, file))
  check('icon ≤ 256 KiB', statSync(iconPath).size <= 256 * 1024, `${Math.round(statSync(iconPath).size / 1024)} KiB`)
}

/* ---------------- 4. 语言包（展示标题/简介） ---------------- */
const localeDir = resolve(pluginDir, 'locale')
if (!existsSync(localeDir)) {
  note('locale', '没有 locale 目录（标题回退 package.json.name，简介回退 description）')
} else {
  check('locale 通过 exports 暴露（否则运行时解析不到）', exportsMap['./locale/*'] !== undefined || exportsMap['./locale/en.json'] !== undefined,
    JSON.stringify(exportsMap['./locale/*'] ?? exportsMap['./locale/en.json']))
  const files = readdirSync(localeDir).filter((name) => name.endsWith('.json'))
  check('locale 目录里有 en.json（英文回退）', files.includes('en.json'), files.join(','))
  check('locale 目录里只有语言包（*.json，文件名是语言 id）',
    files.every((name) => /^[a-z]{2,3}(?:-[a-z0-9]+)*\.json$/i.test(name)), files.join(','))
  for (const name of files) {
    const data = JSON.parse(readFileSync(resolve(localeDir, name), 'utf8'))
    const meta = data.meta ?? {}
    const okTitle = typeof meta.title === 'string' && meta.title.trim() !== ''
    const okDesc = typeof meta.description === 'string' && meta.description.trim() !== ''
    check(`locale/${name} 的 meta.title / meta.description 都是非空字符串`, okTitle && okDesc,
      `${(meta.title ?? '').slice(0, 24)} · ${(meta.description ?? '').length} 字符`)
  }
}

/* ---------------- 5. 组合包 patch ---------------- */
const patch = pkg.dsh?.bundle?.patch
const patchList = Array.isArray(patch) ? patch : patch === undefined ? [] : [patch]
if (patchList.length === 0) {
  check('声明 dsh.bundle.patch（组合包入口）', false, '缺失')
} else {
  for (const item of patchList) {
    const file = resolve(pluginDir, item)
    check(`patch 文件存在：${item}`, existsSync(file))
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    check(`${item} 里有 insert 行`, /^\s*-\s*insert:/m.test(text))
    const names = [...text.matchAll(/name:\s*['"]?([^'"\n]+)['"]?/g)].map((m) => m[1].trim())
    check(`${item} 的 name 与包名一致（${pkg.name}）`, names.includes(pkg.name), names.join(','))
  }
}

/* ---------------- 6. 客户端声明 ---------------- */
check('dsh.client.platform 已声明（Web 端为 "web"）', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client?.platform)

/* ---------------- 7. engines 与运行时兼容 ---------------- */
check('engines.node 声明了 Node 版本', typeof pkg.engines?.node === 'string', pkg.engines?.node)
const dshRange = pkg.engines?.dsh
check('engines.dsh 声明了 DSH 兼容范围（SemVer range）', typeof dshRange === 'string' && dshRange.trim() !== '', dshRange)

/** 极简 SemVer 比较（只覆盖插件常用的 >= / > / <= / < / = / ^ / ~ 与 空格/逗号 AND）。 */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim())
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? null }
}
function compareIdentifiers(a, b) {
  const an = /^\d+$/.test(a) ? Number(a) : null
  const bn = /^\d+$/.test(b) ? Number(b) : null
  if (an !== null && bn !== null) return an === bn ? 0 : an < bn ? -1 : 1
  if (an !== null) return -1
  if (bn !== null) return 1
  return a === b ? 0 : a < b ? -1 : 1
}
function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const as = a.pre.split('.')
  const bs = b.pre.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    if (as[i] === undefined) return -1
    if (bs[i] === undefined) return 1
    const order = compareIdentifiers(as[i], bs[i])
    if (order !== 0) return order
  }
  return 0
}
function satisfies(range, versionText) {
  const version = parseVersion(versionText)
  if (version === null) return false
  const clauses = range.split(/\s*,\s*|\s+/).filter((item) => item !== '')
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=|\^|~)?\s*(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(clause)
    if (match === null) return false
    const op = match[1] ?? '='
    const base = parseVersion(match[2])
    if (base === null) return false
    const order = compareVersions(version, base)
    if (op === '>=') return order >= 0
    if (op === '>') return order > 0
    if (op === '<=') return order <= 0
    if (op === '<') return order < 0
    if (op === '=') return order === 0
    if (op === '^') {
      if (order < 0) return false
      if (base.major > 0) return version.major === base.major
      if (base.minor > 0) return version.major === 0 && version.minor === base.minor
      return version.major === 0 && version.minor === 0 && version.patch === base.patch
    }
    // ~
    return order >= 0 && version.major === base.major && version.minor === base.minor
  })
}

const runtime = spawnSync(process.env.DSH_BIN ?? 'dsh', ['--version'], { encoding: 'utf8' })
const runtimeVersion = (runtime.stdout ?? '').trim().replace(/^v/, '')
if (runtime.status !== 0 || parseVersion(runtimeVersion) === null) {
  note('engines.dsh 与当前运行时比对', `取不到 dsh 版本（${runtimeVersion || runtime.error?.message || '未安装'}）`)
} else if (typeof dshRange === 'string') {
  check(`engines.dsh（${dshRange}）接受当前运行时 ${runtimeVersion}`, satisfies(dshRange, runtimeVersion), runtimeVersion)
}

/* ---------------- 8. files 白名单 ---------------- */
const files = pkg.files ?? []
for (const needed of ['lib', 'static', 'locale', 'icon.svg', 'cordis.patch.yml', 'README.md']) {
  check(`files 白名单包含 ${needed}（发布/打包时不丢文件）`, files.includes(needed), files.join(','))
}

/* ---------------- 9. 用 DSH 运行时真正解析一次展示元信息（可选） ---------------- */
const dshRoot = await findDshRoot()
const profilePackage = resolve(process.env.HOME ?? '/root', '.dsh/profiles/web/package.json')
if (dshRoot === null) {
  note('DSH 运行时解析展示元信息', '找不到本机 DSH 安装（可设 DSH_ROOT）')
} else if (!existsSync(profilePackage)) {
  note('DSH 运行时解析展示元信息', `没有 profile 清单：${profilePackage}`)
} else {
  try {
    const { pathToFileURL } = await import('node:url')
    const mod = await import(`${dshRoot}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`)
    const meta = mod.readPluginMeta(pkg.name, pathToFileURL(profilePackage).href)
    const title = typeof meta?.title === 'object' ? meta.title : {}
    const description = typeof meta?.description === 'object' ? meta.description : {}
    check('readPluginMeta 没有报错', typeof meta?.error !== 'string', String(meta?.error ?? ''))
    check('运行时能解析出中英文标题', typeof title.en === 'string' && typeof title.zh === 'string', `${title.en ?? '?'} / ${title.zh ?? '?'}`)
    check('运行时能解析出中英文简介', typeof description.en === 'string' && typeof description.zh === 'string', `${(description.en ?? '').slice(0, 40)}…`)
    check('运行时把 icon 读成 data URL', typeof meta?.icon === 'string' && meta.icon.startsWith('data:image/svg+xml'), String(meta?.icon ?? '').slice(0, 32))
  } catch (error) {
    note('DSH 运行时解析展示元信息', `跳过（${String(error).slice(0, 80)}）`)
  }
}

/** 找本机 DSH 包根：优先 DSH_ROOT，否则从 `which dsh` 的真实路径往上找 package.json。 */
async function findDshRoot() {
  const { execFileSync } = await import('node:child_process')
  if (process.env.DSH_ROOT !== undefined && existsSync(`${process.env.DSH_ROOT}/package.json`)) return process.env.DSH_ROOT
  try {
    const candidate = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
    let dir = dirname(candidate)
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = resolve(dir, 'package.json')
      if (existsSync(manifest)) {
        const data = JSON.parse(readFileSync(manifest, 'utf8'))
        if (data.name === '@deepseek-ai/dsh') return dir
      }
      dir = dirname(dir)
    }
  } catch {
    // 没有 dsh 就当跳过
  }
  return null
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项，跳过 ${notes.length} 项`)
if (failures.length > 0) { console.log(failures.join('\n')); process.exitCode = 1 }
