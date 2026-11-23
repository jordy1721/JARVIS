import { useEffect, useState } from 'react'
import type { MemoryFact } from '@shared/types'
import { api } from '../store'

const CATS: MemoryFact['category'][] = ['identity', 'preference', 'work', 'routine', 'relationship', 'goal', 'skill', 'other']

export function Memory() {
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState({ text: '', category: 'preference' as MemoryFact['category'], importance: 3 })
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const load = () => api.invoke<MemoryFact[]>('memory:list').then(setFacts)
  useEffect(() => {
    load()
  }, [])

  const add = async () => {
    if (!draft.text.trim()) return
    await api.invoke('memory:add', { ...draft, text: draft.text.trim() })
    setDraft({ ...draft, text: '' })
    load()
  }

  const shown = facts.filter((f) => !q || f.text.toLowerCase().includes(q.toLowerCase()))
  const grouped = CATS.map((c) => ({ c, items: shown.filter((f) => f.category === c).sort((a, b) => b.importance - a.importance) })).filter((g) => g.items.length)

  return (
    <div className="page">
      <header className="page-head">
        <h2>Memory</h2>
        <input className="search" placeholder="Search memories…" value={q} onChange={(e) => setQ(e.target.value)} />
      </header>
      <p className="muted">
        What JARVIS has learned about you. It's stored only on this computer, and only the most relevant facts are sent with each conversation. Edit or delete anything.
      </p>
      <div className="card form row wrap">
        <input className="grow" placeholder="Teach me something, e.g. “I prefer short answers”" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as MemoryFact['category'] })}>
          {CATS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select value={draft.importance} onChange={(e) => setDraft({ ...draft, importance: Number(e.target.value) })} title="Importance">
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {'★'.repeat(n)}
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={add}>
          Remember
        </button>
      </div>
      {grouped.length === 0 && <p className="muted">No memories yet. Chat with JARVIS and it will learn as you go.</p>}
      {grouped.map((g) => (
        <section key={g.c} className="mem-group">
          <h3>{g.c}</h3>
          <ul className="list">
            {g.items.map((f) => (
              <li key={f.id}>
                <span className="stars" title={`Importance ${f.importance}`}>
                  {'★'.repeat(f.importance)}
                </span>
                {editing === f.id ? (
                  <input
                    className="grow"
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter') {
                        await api.invoke('memory:update', f.id, { text: editText })
                        setEditing(null)
                        load()
                      } else if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <span className="grow" onDoubleClick={() => (setEditing(f.id), setEditText(f.text))}>
                    {f.text}
                  </span>
                )}
                <span className="muted small">{f.source}</span>
                <button className="icon-btn" title="Edit" onClick={() => (setEditing(f.id), setEditText(f.text))}>
                  ✎
                </button>
                <button className="icon-btn" title="Forget" onClick={() => api.invoke('memory:remove', f.id).then(load)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {facts.length > 0 && (
        <button
          className="btn danger ghost"
          onClick={() => {
            if (confirm('Forget everything JARVIS has learned about you?')) api.invoke('memory:clear').then(load)
          }}
        >
          Forget everything
        </button>
      )}
    </div>
  )
}
