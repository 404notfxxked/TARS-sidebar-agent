import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App'
import { createLogger, installGlobalErrorHook } from '../shared/logger'
import { loadConfig } from '../shared/configStore'
import { applyThemePreference, applyAccent, watchSystemTheme } from './theme'

// 面板侧诊断日志:错误钩子要在 React 挂载前就位,挂载阶段的异常也不漏
installGlobalErrorHook(createLogger({ ctx: 'panel' }))

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('root element missing')

// 主题在挂载前应用,避免深色系统下首帧闪白
loadConfig().then((cfg) => {
  applyThemePreference(cfg.theme);
  applyAccent(cfg.accent);
  watchSystemTheme();
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
