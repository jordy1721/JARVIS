import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatEntry } from '@shared/types'
import { api, setState, useStore } from '../store'
import { voice } from '../voice/instance'
import { stopSpeaking } from '../voice/tts'

/** Very small, safe markdown subset: code fences, inline code, bold, line breaks. */
function renderText(text: string): ReactNode[] {
  const parts = text.split(/```(?:\w+)?\n?([\s\S]*?)```/g)
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <pre key={i} className="code">
        {p}
      </pre>
    ) : (
      <span key={i}>
        {p.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((seg, j) =>
          seg.startsWith('`') ? (
            <code key={j}>{seg.slice(1, -1)}</code>
          ) : seg.startsWith('**') ? (
            <b key={j}>{seg.slice(2, -2)}</b>
          ) : (
            seg
          )
        )}
      </span>
    )
  )
}

function Message({ e }: { e: ChatEntry }) {
  const [open, setOpen] = useState(false)
  if (e.role === 'tool') {
    return (
      <div className="msg tool" onClick={() => setOpen(!open)}>
        <span className="tool-icon">⚙</span> {e.text}
        {open && e.tool?.output && <pre className="code small">{e.tool.output}</pre>}
      </div>
    )
  }
  return (
    <div className={`msg ${e.role}`}>
      <div className="msg-body">{renderText(e.text)}</div>
      <div className="msg-meta">
        {new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {e.model && ` · ${e.model.replace('claude-', '')}`}
        {e.costUsd !== undefined && e.costUsd > 0 && ` · $${e.costUsd.toFixed(4)}`}
      </div>
    </div>
  )
}

export function CommandBar() {
  const [text, setText] = useState('')
  const st = useStore((s) => s.state)
  const settings = useStore((s) => s.settings)
  const busy = st === 'thinking' || st === 'acting'
  const send = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    stopSpeaking()
    setState({ state: 'thinking' })
    api.invoke('chat:send', t, false)
  }
  return (
    <div className="command-bar">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder={`Ask ${settings?.assistantName ?? 'JARVIS'} to do something, or "show me how to…"`}
      />
      {settings?.voiceMode !== 'off' && (
        <button
          className={`icon-btn ${st === 'listening' ? 'live' : ''}`}
          title="Talk (push-to-talk)"
          onClick={() => voice.togglePtt()}
        >
          🎙
        </button>
      )}
      {busy ? (
        <button className="btn danger" onClick={() => api.invoke('chat:stop')}>
          Stop
        </button>
      ) : (
        <button className="btn primary" onClick={send}>
          Send
        </button>
      )}
    </div>
  )
}

export function Assistant() {
  const chat = useStore((s) => s.chat)
  const live = useStore((s) => s.live)
  const st = useStore((s) => s.state)
  const caption = useStore((s) => s.caption)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.length, live?.text])

  return (
    <div className="page assistant">
      <header className="page-head">
        <h2>Assistant</h2>
        <div className="row">
          <button className="btn ghost" onClick={() => api.invoke('chat:new')} title="Start a fresh context (saves tokens)">
            New conversation
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              if (confirm('Clear the chat history? Memories are kept.')) {
                api.invoke('chat:clear')
                setState({ chat: [] })
              }
            }}
          >
            Clear
          </button>
        </div>
      </header>
      <div className="transcript">
        {chat.length === 0 && (
          <div className="empty">
            <p>Try:</p>
            <ul>
              <li>“Open Spotify and play something relaxing”</li>
              <li>“Show me how to change my desktop wallpaper”</li>
              <li>“Remind me to call Mum tomorrow at 6pm”</li>
              <li>“Every weekday at 8:00, summarise what’s in my Downloads folder”</li>
              <li>“Add a button to your dashboard that…” (I’ll propose a code change)</li>
            </ul>
          </div>
        )}
        {chat.map((e) => (
          <Message key={e.id} e={e} />
        ))}
        {live?.text && (
          <div className="msg assistant live">
            <div className="msg-body">{renderText(live.text)}</div>
          </div>
        )}
        {(st === 'thinking' || st === 'acting' || st === 'transcribing') && (
          <div className="typing">
            <span />
            <span />
            <span /> {caption && st !== 'thinking' ? caption : st}
          </div>
        )}
        <div ref={end} />
      </div>
      <CommandBar />
    </div>
  )
}
