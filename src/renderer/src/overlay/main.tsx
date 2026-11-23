// Transparent, click-through, always-on-top layer over the whole screen.
// Shows the status HUD and the "show me how" guidance (highlights, arrows, step cards).
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { GuidePayload, HudPayload } from '@shared/types'
import { Orb } from '../components/Orb'
import './overlay.css'

const api = window.jarvis

/** Make the overlay clickable only while the pointer is over an interactive element. */
const interactive = {
  onMouseEnter: () => api.send('overlay:interactive', true),
  onMouseLeave: () => api.send('overlay:interactive', false)
}

function Guide({ guide }: { guide: GuidePayload }) {
  const [current, setCurrent] = useState(0)
  useEffect(() => {
    setCurrent(0)
  }, [guide])
  const step = guide.steps[current]
  if (!step) return null
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Put the instruction card beside the target, flipping when near an edge.
  const cardLeft = step.x + step.width + 24 + 320 > vw ? Math.max(12, step.x - 340) : step.x + step.width + 24
  const cardTop = Math.min(vh - 180, Math.max(12, step.y + step.height / 2 - 60))
  const cx = step.x + step.width / 2
  const cy = step.y + step.height / 2
  const ax = cardLeft > cx ? cardLeft : cardLeft + 320
  const ay = cardTop + 50
  const last = current === guide.steps.length - 1

  return (
    <>
      <svg className="guide-svg" width={vw} height={vh}>
        <defs>
          <mask id="spot">
            <rect width={vw} height={vh} fill="white" />
            <rect x={step.x - 8} y={step.y - 8} width={step.width + 16} height={step.height + 16} rx={10} fill="black" />
          </mask>
          <marker id="head" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="#38e1ff" />
          </marker>
        </defs>
        <rect width={vw} height={vh} fill="rgba(2,6,14,0.45)" mask="url(#spot)" />
        <rect className={`target k-${step.kind}`} x={step.x - 8} y={step.y - 8} width={step.width + 16} height={step.height + 16} rx={10} />
        {step.kind === 'click' && <circle className="ripple" cx={cx} cy={cy} r={18} />}
        <path d={`M${ax},${ay} Q${(ax + cx) / 2},${Math.min(ay, cy) - 40} ${cx + (ax > cx ? step.width / 2 + 10 : -step.width / 2 - 10)},${cy}`} className="arrow" markerEnd="url(#head)" />
        {guide.steps.map((s, i) =>
          i === current ? null : (
            <g key={i} opacity={0.6}>
              <circle cx={s.x + s.width / 2} cy={s.y + s.height / 2} r={13} className="num-bg" />
              <text x={s.x + s.width / 2} y={s.y + s.height / 2 + 5} textAnchor="middle" className="num">
                {i + 1}
              </text>
            </g>
          )
        )}
      </svg>
      <div className="guide-card" style={{ left: cardLeft, top: cardTop }} {...interactive}>
        <div className="guide-kicker">
          {guide.title} · Step {current + 1} of {guide.steps.length}
        </div>
        <div className="guide-label">{step.label}</div>
        <div className="guide-actions">
          <button onClick={() => api.send('guide:close')}>Close</button>
          {current > 0 && <button onClick={() => setCurrent(current - 1)}>Back</button>}
          {!last && (
            <button className="primary" onClick={() => setCurrent(current + 1)}>
              Next
            </button>
          )}
          {last && (
            <button className="primary" onClick={() => api.send('guide:next')} title="JARVIS looks at your screen again for the next steps">
              Done — what’s next?
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function Overlay() {
  const [hud, setHud] = useState<HudPayload>({ state: 'idle', visible: true })
  const [guide, setGuide] = useState<GuidePayload | null>(null)
  useEffect(() => {
    const off = api.on('overlay:update', ({ hud, guide }: { hud: HudPayload; guide: GuidePayload | null }) => {
      setHud(hud)
      setGuide(guide)
    })
    return () => off()
  }, [])
  const showCaption = hud.caption && hud.state !== 'idle'
  const showHud = hud.visible && (hud.state !== 'idle' || !!guide)
  return (
    <>
      {guide && <Guide guide={guide} />}
      {showHud && (
        <div className={`hud hud-${hud.state}`} {...interactive} onClick={() => api.send('show-main')}>
          <Orb state={hud.state} size={56} />
          {showCaption && <div className="hud-caption">{hud.caption}</div>}
        </div>
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
