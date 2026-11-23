import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { ConfirmModal, Toasts } from './components/ConfirmModal'
import { useStore } from './store'
import { Dashboard } from './pages/Dashboard'
import { Assistant } from './pages/Assistant'
import { Tasks } from './pages/Tasks'
import { Memory } from './pages/Memory'
import { CodeLab } from './pages/CodeLab'
import { ActivityLog } from './pages/ActivityLog'
import { SettingsPage } from './pages/Settings'

export function App() {
  const page = useStore((s) => s.page)
  const progress = useStore((s) => s.modelProgress)
  // Tell the main process the UI rendered (its watchdog offers recovery if this never arrives).
  useEffect(() => window.jarvis.send('renderer:ready'), [])
  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        {progress && <div className="banner">{progress}</div>}
        {page === 'dashboard' && <Dashboard />}
        {page === 'assistant' && <Assistant />}
        {page === 'tasks' && <Tasks />}
        {page === 'memory' && <Memory />}
        {page === 'code' && <CodeLab />}
        {page === 'log' && <ActivityLog />}
        {page === 'settings' && <SettingsPage />}
      </main>
      <ConfirmModal />
      <Toasts />
    </div>
  )
}
