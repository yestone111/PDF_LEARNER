import { createRoot } from 'react-dom/client'
import 'react-pdf-highlighter/dist/style.css'
import 'reactflow/dist/style.css'
import App from './App'
import './index.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('找不到挂载点 #root，请检查 index.html')
}

/**
 * 注意：这里**故意不套 StrictMode**。
 *
 * react-pdf-highlighter@8 的 PdfHighlighter 是命令式类组件：componentDidMount 里
 * 创建 PDFViewer 并往容器追加页面 DOM，但卸载时不完整回收。
 * React 18 的 StrictMode 在开发环境会「挂载 → 卸载 → 再挂载」一次，
 * 实测结果是一份 15 页 PDF 在 DOM 里出现 **30 个页面容器**（两个 viewer 叠在一起），
 * 目录页码点击也会打到已被废弃的那份 DOM 上。
 *
 * 这是库与 StrictMode 的真实冲突，不是我们代码的问题；为了开发/验收环境可用，
 * 这里关闭 StrictMode，并在 docs/STEP2-PDF.md 记录原因与后续处理方式。
 */
createRoot(container).render(<App />)
