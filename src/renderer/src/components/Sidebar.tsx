import { api, setState, useStore, type Page } from '../store'
import { Orb } from './Orb'
import { voice } from '../voice/instance'

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '◈' },
  { id: 'assistant', label: 'Assistant', icon: '◉' },
  { id: 'tasks', label: 'Tasks', icon: '☑' },
  { id: 'memory', label: 'Memory', icon: '✦' },
  { id: 'code', label: 'Code Lab', icon: '⟨⟩' },
  { id: 'log', label: 'Activity Log', icon: '≡' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
]

const STATE_LABEL: Record<string, string> = {
  idle: 'Standing by',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  acting: 'Working',
  speaking: 'Speaking'
}

export function Sidebar() {
  const page = useStore((s) => s.page)
  const st = useStore((s) => s.state)
  const level = useStore((s) => s.level)
  const settings = useStore((s) => s.settings)
  return (
    <aside className="sidebar">
      <div className="brand">
        <Orb state={st} level={level} size={84} onClick={() => voice.togglePtt()} />
        <div className="brand-name">{settings?.assistantName ?? 'JARVIS'}</div>
        <div className={`brand-state s-${st}`}>{STATE_LABEL[st]}</div>
      </div>
      <nav>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setState({ page: n.id })}>
            <span className="nav-icon">{n.icon}</span>
            {n.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        {settings && (
          <select
            className="voice-mode"
            value={settings.voiceMode}
            title="Voice input"
            onChange={(e) => api.invoke('settings:set', { voiceMode: e.target.value })}
          >
            <option value="push-to-talk">🎙 Push to talk</option>
            <option value="open-mic">🎙 Always listening</option>
            <option value="off">🎙 Voice off</option>
          </select>
        )}
        {settings && settings.voiceMode !== 'off' && (
          <div className="hint">
            {settings.voiceMode === 'push-to-talk' ? (
              <>Push to talk: <kbd>{prettyKey(settings.pushToTalkHotkey)}</kbd></>
            ) : (
              <>Open mic{settings.requireWakeWord ? <> — say “{settings.wakeWord}”</> : null}</>
            )}
          </div>
        )}
        {settings && (
          <div className="hint">
            Stop: <kbd>{prettyKey(settings.stopHotkey)}</kbd>
          </div>
        )}
      </div>
    </aside>
  )
}

export function prettyKey(k: string) {
  const mac = window.jarvis.platform === 'darwin'
  return k.replace('CommandOrControl', mac ? '⌘' : 'Ctrl').replace(/\+/g, ' + ')
}
