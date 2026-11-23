import { createRoot } from 'react-dom/client'
import type { ChatEntry, ConfirmRequest, ConnectionStatus, Settings, Task } from '@shared/types'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { api, getState, setState, toast, type Page } from './store'
import { voice } from './voice/instance'
import { configureTts, SentenceChunker, speak, stopSpeaking } from './voice/tts'
import './styles.css'

function applySettings(s: Settings) {
  setState({ settings: s })
  configureTts(s)
  document.documentElement.dataset.theme = s.theme
  voice.apply(s).catch((e) => toast(`Microphone error: ${e.message ?? e}`))
}

// ---------------- Main-process events ----------------
const chunkers = new Map<string, SentenceChunker>()

api.on('chat', (e: ChatEntry) => setState((s) => ({ chat: [...s.chat, e] })))
api.on('stream', ({ id, delta, done, speak: shouldSpeak }: { id: string; delta: string; done: boolean; speak: boolean }) => {
  if (shouldSpeak) {
    let c = chunkers.get(id)
    if (!c) chunkers.set(id, (c = new SentenceChunker()))
    for (const sentence of c.push(delta)) speak(sentence)
    if (done) {
      const rest = c.flush()
      if (rest.trim()) speak(rest)
      chunkers.delete(id)
    }
  }
  // All streamed text of the current turn is shown as one live bubble until the final reply arrives.
  setState((s) => ({ live: { id, text: (s.live?.text ?? '') + delta + (done && s.live?.text ? '\n\n' : '') } }))
})
api.on('reply', ({ entry, speak: shouldSpeak, streamed }: { entry: ChatEntry; speak: boolean; streamed: boolean }) => {
  setState((s) => ({ chat: [...s.chat, entry], live: null }))
  if (shouldSpeak && !streamed) speak(entry.text)
})
api.on('state', (st) => setState({ state: st, caption: st === 'idle' ? '' : getState().caption }))
api.on('settings', (s: Settings) => applySettings(s))
api.on('confirm', (req: ConfirmRequest) => setState((s) => ({ confirms: [...s.confirms, req] })))
api.on('confirm:closed', (id: string) => setState((s) => ({ confirms: s.confirms.filter((c) => c.id !== id) })))
api.on('navigate', (page: Page) => setState({ page }))
api.on('ptt:toggle', () => voice.togglePtt())
api.on('stop-all', () => {
  stopSpeaking()
  voice.cancel()
})
api.on('reminder', (t: Task) => {
  toast(`⏰ Reminder: ${t.title}`)
  if (getState().settings?.ttsEnabled) speak(`Reminder: ${t.title}`)
})
api.on('code:changed', () => toast('A code change is waiting for your review in Code Lab'))

// ---------------- Boot ----------------
Promise.all([api.invoke<Settings>('settings:get'), api.invoke<ChatEntry[]>('chat:history'), api.invoke<ConnectionStatus>('claude:status')]).then(
  ([s, chat, conn]) => {
    setState({ chat, page: conn.ready ? 'dashboard' : 'settings' })
    applySettings(s)
  }
)
// Voices load asynchronously in Chromium
window.speechSynthesis?.addEventListener?.('voiceschanged', () => setState({}))

window.addEventListener('error', (e) => api.send('renderer:error', String(e.message)))
window.addEventListener('unhandledrejection', (e) => api.send('renderer:error', String(e.reason)))

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
