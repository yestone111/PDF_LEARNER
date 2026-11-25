/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 插件模式下为 /api/akn；独立运行不设置，回落 /api。 */
  readonly VITE_API_BASE?: string
  /** 插件形态为 '1'：底部状态栏出现「返回 DSH」按钮，独立运行不渲染。 */
  readonly VITE_DSH_PLUGIN?: string
}
