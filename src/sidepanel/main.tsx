import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
import { createLogger, installGlobalErrorHook } from '../shared/logger'

// 面板侧诊断日志:错误钩子要在 React 挂载前就位,挂载阶段的异常也不漏
installGlobalErrorHook(createLogger({ ctx: 'panel' }))

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('root element missing')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
)
