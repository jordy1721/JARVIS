import { useEffect, useState } from 'react'
import type { Task, TaskStatus } from '@shared/types'
import { api, toast } from '../store'

const toLocalInput = (ms?: number) => {
  if (!ms) return ''
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}
const fromLocalInput = (s: string) => (s ? new Date(s).getTime() : undefined)

function scheduleLabel(t: Task) {
  const s = t.automation?.schedule
  if (!s) return ''
  if (s.kind === 'daily') return `daily at ${s.time}`
  if (s.kind === 'interval') return `every ${s.minutes} min`
  return `once at ${new Date(s.at).toLocaleString()}`
}

export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [filter, setFilter] = useState<'open' | 'done' | 'automations'>('open')
  const [form, setForm] = useState({ title: '', due: '', remind: '', priority: 'medium', auto: false, prompt: '', kind: 'daily', time: '08:00', minutes: 60 })

  const load = () => api.invoke<Task[]>('tasks:list').then(setTasks)
  useEffect(() => {
    load()
    const off = api.on('tasks:changed', load)
    return () => off()
  }, [])

  const add = async () => {
    if (!form.title.trim()) return
    const automation = form.auto
      ? {
          prompt: form.prompt,
          enabled: true,
          schedule:
            form.kind === 'daily'
              ? ({ kind: 'daily', time: form.time } as const)
              : form.kind === 'interval'
                ? ({ kind: 'interval', minutes: Math.max(15, form.minutes) } as const)
                : ({ kind: 'once', at: fromLocalInput(form.due) ?? Date.now() + 60000 } as const)
        }
      : undefined
    await api.invoke('tasks:add', {
      title: form.title.trim(),
      priority: form.priority,
      due: fromLocalInput(form.due),
      remindAt: fromLocalInput(form.remind),
      automation
    })
    setForm({ ...form, title: '', due: '', remind: '', prompt: '', auto: false })
    load()
  }
  const update = async (id: string, patch: Partial<Task>) => {
    await api.invoke('tasks:update', id, patch)
    load()
  }

  const shown = tasks
    .filter((t) => (filter === 'automations' ? !!t.automation : filter === 'done' ? t.status === 'done' : t.status !== 'done' && !t.automation))
    .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity))

  return (
    <div className="page">
      <header className="page-head">
        <h2>Tasks</h2>
        <div className="tabs">
          {(['open', 'done', 'automations'] as const).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </header>

      <div className="card form">
        <div className="row wrap">
          <input className="grow" placeholder="New task…" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <button className="btn primary" onClick={add}>
            Add
          </button>
        </div>
        <div className="row wrap">
          <label>
            Due <input type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
          </label>
          <label>
            Remind me <input type="datetime-local" value={form.remind} onChange={(e) => setForm({ ...form, remind: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked })} /> Automation
          </label>
        </div>
        {form.auto && (
          <div className="row wrap">
            <input className="grow" placeholder="What should JARVIS do? e.g. Check the weather and tell me if I need an umbrella" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="daily">Daily</option>
              <option value="interval">Every N minutes</option>
              <option value="once">Once (at due time)</option>
            </select>
            {form.kind === 'daily' && <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />}
            {form.kind === 'interval' && <input type="number" min={15} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })} />}
          </div>
        )}
        {form.auto && <p className="muted small">Automations call the AI each time they run, so they use credits. Keep schedules sensible.</p>}
      </div>

      <ul className="task-list">
        {shown.length === 0 && <li className="muted">Nothing here.</li>}
        {shown.map((t) => (
          <li key={t.id} className={`task ${t.status}`}>
            {!t.automation && (
              <input type="checkbox" checked={t.status === 'done'} onChange={() => update(t.id, { status: t.status === 'done' ? 'todo' : 'done' as TaskStatus })} />
            )}
            <span className={`dot p-${t.priority}`} />
            <div className="grow">
              <div className="task-title">{t.title}</div>
              <div className="muted small">
                {[t.due && `Due ${new Date(t.due).toLocaleString()}`, t.remindAt && `Reminder ${new Date(t.remindAt).toLocaleString()}`].filter(Boolean).join(' · ')}
                {t.automation && (
                  <>
                    {scheduleLabel(t)} · {t.automation.enabled ? 'enabled' : 'paused'}
                    {t.automation.lastRun && <> · last run {new Date(t.automation.lastRun).toLocaleString()}</>}
                    <div className="small">“{t.automation.prompt}”</div>
                  </>
                )}
                {t.notes}
              </div>
            </div>
            {t.automation && (
              <>
                <button className="btn ghost small" onClick={() => api.invoke('tasks:run', t.id).then(() => toast('Running automation…'))}>
                  Run now
                </button>
                <button className="btn ghost small" onClick={() => update(t.id, { automation: { ...t.automation!, enabled: !t.automation!.enabled } })}>
                  {t.automation.enabled ? 'Pause' : 'Resume'}
                </button>
              </>
            )}
            {!t.automation && (
              <input type="datetime-local" className="small" title="Due" value={toLocalInput(t.due)} onChange={(e) => update(t.id, { due: fromLocalInput(e.target.value) })} />
            )}
            <button className="icon-btn" title="Delete" onClick={() => api.invoke('tasks:remove', t.id).then(load)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
