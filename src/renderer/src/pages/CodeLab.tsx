import { useEffect, useState } from 'react'
import type { CodeChange } from '@shared/types'
import { api, setState, toast } from '../store'
import { CommandBar } from './Assistant'

function Diff({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split('\n').map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') ? 'file' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''
        if (l.startsWith('====')) return null
        return (
          <div key={i} className={cls}>
            {l || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export function CodeLab() {
  const [changes, setChanges] = useState<CodeChange[]>([])
  const [root, setRoot] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () => api.invoke<CodeChange[]>('code:list').then(setChanges)
  useEffect(() => {
    load()
    api.invoke<string | null>('code:root').then(setRoot)
    const off = api.on('code:changed', load)
    return () => off()
  }, [])

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await fn()
      toast(msg)
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`)
    }
    setBusy(false)
    load()
  }

  return (
    <div className="page">
      <header className="page-head">
        <h2>Code Lab</h2>
      </header>
      <p className="muted">
        Ask {''}JARVIS to change itself — new features, a different look, new abilities. It reads its own source and proposes a change; nothing is applied until you approve the
        diff below. Every applied change is a git commit you can revert.
      </p>
      {!root && (
        <div className="alert subtle">
          Source code not found. Self-modification works when JARVIS runs from its source folder (<code>npm run dev</code>), or set the source folder in{' '}
          <a onClick={() => setState({ page: 'settings' })}>Settings</a>.
        </div>
      )}
      {root && <p className="muted small">Source: {root}</p>}
      <CommandBar />

      <div className="changes">
        {changes.length === 0 && <p className="muted">No proposed changes yet. Try: “Add a weather card to the dashboard.”</p>}
        {changes.map((c) => (
          <div key={c.id} className={`card change st-${c.status}`}>
            <div className="row">
              <div className="grow">
                <div className="change-title">{c.title}</div>
                <div className="muted small">
                  {new Date(c.created).toLocaleString()} · {c.edits.length} edit{c.edits.length > 1 ? 's' : ''} · <span className={`badge b-${c.status}`}>{c.status}</span>
                  {c.commit && <> · commit {c.commit.slice(0, 7)}</>}
                </div>
              </div>
              <button className="btn ghost small" onClick={() => setOpen(open === c.id ? null : c.id)}>
                {open === c.id ? 'Hide diff' : 'View diff'}
              </button>
              {c.status === 'pending' && (
                <>
                  <button className="btn ghost small" disabled={busy} onClick={() => act(() => api.invoke('code:reject', c.id), 'Change rejected')}>
                    Reject
                  </button>
                  <button className="btn primary small" disabled={busy} onClick={() => act(() => api.invoke('code:apply', c.id), 'Change applied')}>
                    Approve & apply
                  </button>
                </>
              )}
              {c.status === 'applied' && (
                <>
                  <button className="btn ghost small" disabled={busy || !c.commit} onClick={() => act(() => api.invoke('code:revert', c.id), 'Change reverted')}>
                    Revert
                  </button>
                  <button className="btn primary small" onClick={() => api.invoke('app:restart')}>
                    Restart to load
                  </button>
                </>
              )}
            </div>
            <p>{c.description}</p>
            {c.error && <pre className="code small error">{c.error}</pre>}
            {(open === c.id || c.status === 'pending') && <Diff diff={c.diff} />}
          </div>
        ))}
      </div>
    </div>
  )
}
