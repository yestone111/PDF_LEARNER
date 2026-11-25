import type { ReactElement } from 'react'

/**
 * 底部状态栏：只在「嵌入 DSH 插件」形态下出现。
 *
 * 最下面一行最右边是「返回 DSH」椭圆按钮，样式对齐 RTL_Cockpit 的启动按钮
 * （圆角 20、渐变、阴影、hover 位移一致），只是尺寸紧凑一点，避免挤压右栏输入框。
 * 独立运行（`pnpm dev`）时整条栏不渲染 —— 没有 DSH 可返回。
 */

const IS_DSH_PLUGIN = import.meta.env.VITE_DSH_PLUGIN === '1'

/**
 * 返回到「打开本页的那个 DSH 页面」，而不是死写首页：
 * 通过 location.assign 进来时 document.referrer 就是 DSH 的 URL；
 * 直接开新标签（referrer 为空）时回落到 `/`。
 */
function resolveReturnUrl(): string {
  try {
    const referrer = document.referrer
    if (referrer !== '') {
      const url = new URL(referrer)
      if (url.origin === window.location.origin && !url.pathname.startsWith('/akn')) {
        return url.href
      }
    }
  } catch {
    // referrer 不可解析：回落首页
  }
  return '/'
}

export function AppFooter(): ReactElement | null {
  if (!IS_DSH_PLUGIN) return null

  const returnUrl = resolveReturnUrl()

  return (
    <footer
      data-testid="app-footer"
      className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-akn-border bg-akn-panel/50 px-3"
    >
      <p className="truncate text-[10px] text-akn-muted/70">
        本地优先 · 数据保存在本机 IndexedDB · 模型由 DeepSeek Harness 提供
      </p>

      <a
        data-testid="return-to-dsh"
        href={returnUrl}
        title="返回 DeepSeek Harness"
        aria-label="返回 DSH"
        className="inline-flex shrink-0 items-center rounded-full border border-white/20 bg-[linear-gradient(135deg,#3b6fe0,#5a43d6)] px-4 py-1 text-[11px] font-semibold text-white shadow-[0_4px_16px_rgba(40,60,120,.35)] transition hover:-translate-y-px hover:shadow-[0_7px_22px_rgba(40,60,120,.45)]"
        onClick={(event) => {
          // 与 RTL_Cockpit 的启动按钮一致：修饰键/中键走浏览器默认（新标签）
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
          event.preventDefault()
          window.location.assign(returnUrl)
        }}
      >
        <span>返回 DSH</span>
      </a>
    </footer>
  )
}
