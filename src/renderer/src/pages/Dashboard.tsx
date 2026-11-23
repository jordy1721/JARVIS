import { useEffect, useState } from 'react'
import type { DashboardData } from '@shared/types'
import { api, setState, useStore } from '../store'
import { Orb } from '../components/Orb'
import { voice } from '../voice/instance'
import { CommandBar } from './Assistant'

export const usd = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

function greeting(name: string) {
  const h = new Date().getHours()
  const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return `${part}${name ? `, ${name}` : ''}.`
}

/** Rounded-top bar path anchored to the baseline. */
function barPath(x: number, base: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h)
  return `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + w - r} Q${x + w},${base - h} ${x + w},${base - h + r} V${base} Z`
}

function SpendChart({ days }: { days: { day: string; usd: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(0.001, ...days.map((d) => d.usd))
  if (days.every((d) => d.usd === 0)) return <p className="muted">No spend yet — usage shows up here once you start talking to me.</p>
  const W = 560
  const H = 140
  const pad = 44
  const bw = (W - pad) / days.length
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H + 20}`} width="100%" role="img" aria-label="Daily API spend, last 14 days">
        <line x1={pad} x2={W} y1={H} y2={H} className="axis" />
        <line x1={pad} x2={W} y1={20} y2={20} className="grid" />
        <text x={pad - 6} y={24} textAnchor="end" className="axis-label">
          {usd(max)}
        </text>
        <text x={pad - 6} y={H} textAnchor="end" className="axis-label">
          $0
        </text>
        {days.map((d, i) => {
          const h = d.usd > 0 ? Math.max(3, (d.usd / max) * (H - 20)) : 0
          const w = bw * 0.6
          const x = pad + i * bw + (bw - w) / 2
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad + i * bw} y={0} width={bw} height={H} fill="transparent" />
              {h > 0 && <path className={`bar ${hover === i ? 'hover' : ''}`} d={barPath(x, H, w, h)} />}
              {(i % 3 === 0 || i === days.length - 1) && (
                <text x={pad + i * bw + bw / 2} y={H + 15} textAnchor="middle" className="axis-label">
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${((pad + hover * bw + bw / 2) / W) * 100}%` }}>
          <b>{usd(days[hover].usd)}</b>
          <span>
            {new Date(days[hover].day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </div>
      )}
    </div>
  )
}

export function Dashboard() {
  const [d, setD] = useState<DashboardData | null>(null)
  const settings = useStore((s) => s.settings)
  const st = useStore((s) => s.state)
  const level = useStore((s) => s.level)
  const chatLen = useStore((s) => s.chat.length)

  useEffect(() => {
    const load = () => api.invoke<DashboardData>('dashboard:get').then(setD)
    load()
    const t = setInterval(load, 15000)
    const off = api.on('tasks:changed', load)
    return () => {
      clearInterval(t)
      off()
    }
  }, [chatLen])

  if (!d || !settings) return <div className="page" />
  const sub = d.connection.provider === 'subscription'
  const win = d.usage.subscriptionLimits?.unifiedWindows ?? {}
  const five = win.five_hour
  const week = win.seven_day
  const pct = (u?: number) => (u === undefined ? '—' : `${Math.round(u * 100)}%`)
  const budgetPct = settings.dailyBudgetUsd > 0 ? Math.min(100, (d.usage.todayUsd / settings.dailyBudgetUsd) * 100) : 0

  return (
    <div className="page dashboard">
      <section className="hero">
        <Orb state={st} level={level} size={150} onClick={() => voice.togglePtt()} />
        <div className="hero-text">
          <h1>{greeting(settings.userName)}</h1>
          <p className="muted">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} ·{' '}
            {d.tasks.dueToday ? `${d.tasks.dueToday} task${d.tasks.dueToday > 1 ? 's' : ''} due today` : 'Nothing due today'}
          </p>
          <CommandBar />
        </div>
      </section>

      {!d.connection.ready && (
        <div className="alert" onClick={() => setState({ page: 'settings' })}>
          {d.connection.provider === 'subscription'
            ? `Connect your Claude subscription in Settings to bring ${settings.assistantName} online →`
            : `Add your Anthropic API key in Settings to bring ${settings.assistantName} online →`}
        </div>
      )}
      {!d.computerControlAvailable && (
        <div className="alert subtle">Mouse/keyboard control is unavailable on this machine — everything else still works.</div>
      )}
      {d.pendingChanges > 0 && (
        <div className="alert" onClick={() => setState({ page: 'code' })}>
          {d.pendingChanges} code change{d.pendingChanges > 1 ? 's' : ''} waiting for your review in Code Lab →
        </div>
      )}

      <section className="tiles">
        {sub ? (
          <>
            <div className="tile">
              <div className="tile-label">Claude plan · 5-hour window</div>
              <div className="tile-value">{pct(five?.utilization)}</div>
              <div className="meter" aria-label="5-hour plan usage">
                <div style={{ width: `${Math.min(100, (five?.utilization ?? 0) * 100)}%` }} className={(five?.utilization ?? 0) > 0.85 ? 'warn' : ''} />
              </div>
              <div className="tile-sub">
                {five?.resetsAt ? `Resets ${new Date(five.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Shows after your first request'} ·{' '}
                {d.usage.subscriptionRequestsToday} requests today
              </div>
            </div>
            <div className="tile">
              <div className="tile-label">Claude plan · this week</div>
              <div className="tile-value">{pct(week?.utilization)}</div>
              <div className="meter" aria-label="Weekly plan usage">
                <div style={{ width: `${Math.min(100, (week?.utilization ?? 0) * 100)}%` }} className={(week?.utilization ?? 0) > 0.85 ? 'warn' : ''} />
              </div>
              <div className="tile-sub">No API credits used — included in your subscription</div>
            </div>
          </>
        ) : (
          <>
            <div className="tile">
              <div className="tile-label">Spent today</div>
              <div className="tile-value">{usd(d.usage.todayUsd)}</div>
              <div className="meter" aria-label="Daily budget used">
                <div style={{ width: `${budgetPct}%` }} className={budgetPct > 85 ? 'warn' : ''} />
              </div>
              <div className="tile-sub">
                of {usd(settings.dailyBudgetUsd)} daily limit · {d.usage.todayRequests} requests
              </div>
            </div>
            <div className="tile">
              <div className="tile-label">This month</div>
              <div className="tile-value">{usd(d.usage.monthUsd)}</div>
              <div className="tile-sub">Prompt cache hit rate {(d.usage.cacheHitRate * 100).toFixed(0)}%</div>
            </div>
          </>
        )}
        <div className="tile clickable" onClick={() => setState({ page: 'tasks' })}>
          <div className="tile-label">Open tasks</div>
          <div className="tile-value">{d.tasks.open}</div>
          <div className="tile-sub">{d.tasks.done} completed</div>
        </div>
        <div className="tile clickable" onClick={() => setState({ page: 'memory' })}>
          <div className="tile-label">Things I know about you</div>
          <div className="tile-value">{d.memoryCount}</div>
          <div className="tile-sub">
            {d.journalCount} past conversation{d.journalCount === 1 ? '' : 's'} remembered
            {settings.learnFromConversations ? '' : ' · learning paused'}
          </div>
        </div>
      </section>

      <section className="grid2">
        <div className="card">
          <h3>{sub ? 'Usage by model' : 'Daily spend · last 14 days'}</h3>
          {sub ? (
            <p className="muted">Running on your Claude subscription, so there’s no API spend. Requests count toward your plan’s limits, shown above.</p>
          ) : (
            <SpendChart days={d.usage.last14Days} />
          )}
          <div className="model-split">
            {d.usage.byModel.map((m) => (
              <div key={m.model}>
                <span>{m.model}</span>
                <span className="muted">
                  {m.requests} req{m.model.endsWith('(plan)') ? '' : ` · ${usd(m.usd)}`}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>Up next</h3>
          {d.tasks.upcoming.length === 0 && <p className="muted">No open tasks. Ask me to add one.</p>}
          <ul className="list">
            {d.tasks.upcoming.map((t) => (
              <li key={t.id}>
                <span className={`dot p-${t.priority}`} />
                <span className="grow">{t.title}</span>
                {t.due && (
                  <span className="muted small">
                    {new Date(t.due).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h3>Recent actions</h3>
          {d.recentActions.length === 0 && <p className="muted">Nothing yet.</p>}
          <ul className="list">
            {d.recentActions.map((a) => (
              <li key={a.id}>
                <span className={`badge b-${a.status}`}>{a.status}</span>
                <span className="grow ellipsis">{a.summary.split('\n')[0]}</span>
                <span className="muted small">{new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h3>Today’s focus</h3>
          {!settings.trackActivity && (
            <p className="muted">Turn on activity learning in Settings to see where your time goes (it stays on this computer).</p>
          )}
          {settings.trackActivity && !d.activity && <p className="muted">Collecting… check back in a few minutes.</p>}
          {d.activity && (
            <ul className="list">
              {d.activity.apps.map((a) => (
                <li key={a.name}>
                  <span className="grow ellipsis">{a.name}</span>
                  <span className="muted small">{a.minutes >= 60 ? `${(a.minutes / 60).toFixed(1)} h` : `${a.minutes} min`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
