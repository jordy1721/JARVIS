import { useEffect, useState } from 'react'
import type { JournalEntry, MemoryFact } from '@shared/types'
import { api } from '../store'

const CATS: MemoryFact['category'][] = ['identity', 'preference', 'work', 'routine', 'relationship', 'goal', 'skill', 'other']

export function Memory() {
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState({ text: '', category: 'preference' as MemoryFact['category'], importance: 3 })
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [tab, setTab] = useState<'facts' | 'journal'>('facts')
  const load = () => {
    api.invoke<MemoryFact[]>('memory:list').then(setFacts)
    api.invoke<JournalEntry[]>('journal:list').then(setJournal)
  }
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
        <div className="row">
          <div className="tabs">
            <button className={tab === 'facts' ? 'active' : ''} onClick={() => setTab('facts')}>
              About you ({facts.length})
            </button>
            <button className={tab === 'journal' ? 'active' : ''} onClick={() => setTab('journal')}>
              Past conversations ({journal.length})
            </button>
          </div>
          <input className="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </header>
      <p className="muted">
        {tab === 'facts'
          ? 'What JARVIS has learned about you. Stored only on this computer; only the most relevant facts are sent with each conversation. Edit or delete anything.'
          : 'A diary of your conversations. Recent ones are remembered automatically; JARVIS searches older ones (and your full chat history) when you refer back to them. Your current conversation also carries over if you restart the app.'}
      </p>
      {tab === 'journal' && (
        <>
          {journal.length === 0 && <p className="muted">Nothing yet. A summary is saved when a conversation ends (after 20 quiet minutes or “New conversation”).</p>}
          <ul className="list journal">
            {journal
              .filter((j) => !q || (j.summary + j.topics.join(' ')).toLowerCase().includes(q.toLowerCase()))
              .map((j) => (
                <li key={j.id}>
                  <span className="muted small when">
                    {new Date(j.ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div className="grow">
                    <div>{j.summary}</div>
                    <div>
                      {j.topics.map((t) => (
                        <span key={t} className="topic">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button className="icon-btn" title="Delete" onClick={() => api.invoke('journal:remove', j.id).then(load)}>
                    ✕
                  </button>
                </li>
              ))}
          </ul>
          {journal.length > 0 && (
            <button
              className="btn danger ghost"
              onClick={() => {
                if (confirm('Delete all conversation summaries?')) api.invoke('journal:clear').then(load)
              }}
            >
              Clear journal
            </button>
          )}
        </>
      )}
      {tab === 'facts' && (
        <>
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
        </>
      )}
    </div>
  )
}
