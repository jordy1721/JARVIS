import { api, setState, useStore } from '../store'

export function ConfirmModal() {
  const req = useStore((s) => s.confirms[0])
  if (!req) return null
  const respond = (ok: boolean) => {
    api.invoke('confirm:respond', req.id, ok)
    setState((s) => ({ confirms: s.confirms.slice(1) }))
  }
  return (
    <div className="modal-backdrop">
      <div className={`modal risk-${req.risk}`} role="dialog" aria-modal="true">
        <div className="modal-kicker">Approval needed · {req.risk} risk</div>
        <h2>{req.title}</h2>
        <pre className="modal-detail">{req.detail}</pre>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => respond(false)}>
            Deny
          </button>
          <button className="btn primary" autoFocus onClick={() => respond(true)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  )
}
