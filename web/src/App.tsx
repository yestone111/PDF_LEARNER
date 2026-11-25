import type { ReactElement } from 'react'

import { AppLayout } from './app/AppLayout'

/**
 * 应用入口组件。
 * Step 0 的占位页（健康检查卡片）已被真实三栏布局取代；
 * 后端连通性探针移到了 TopBar（每步都能一眼看到链路是否通）。
 */
export default function App(): ReactElement {
  return <AppLayout />
}
