import { useEffect, useState } from 'react'
import type { ActionLogEntry } from '@shared/types'
import { api } from '../store'

/** Audit trail of everything JARVIS did on the computer. */
export function ActivityLog() {
  const [items, setItems] = useState<ActionLogEntry[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    const load = () => api.invoke<ActionLogEntry[]>('actions:list').then(setItems)
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="page">
      <header className="page-head">
        <h2>Activity Log</h2>
      </header>
      <p className="muted">Every action JARVIS took on your computer, including ones you denied.</p>
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Status</th>
            <th>Tool</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Nothing yet.
              </td>
            </tr>
          )}
          {items.map((a) => (
            <tr key={a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
              <td className="nowrap muted">{new Date(a.ts).toLocaleString()}</td>
              <td>
                <span className={`badge b-${a.status}`}>{a.status}</span>
              </td>
              <td className="nowrap">{a.tool}</td>
              <td>
                <div className={open === a.id ? '' : 'ellipsis'}>{a.summary}</div>
                {open === a.id && a.detail && <pre className="code small">{a.detail}</pre>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
