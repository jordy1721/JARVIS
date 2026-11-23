import './orb.css'
import type { AssistantState } from '@shared/types'

/** Arc-reactor style status orb. */
export function Orb({ state, level = 0, size = 160, onClick }: { state: AssistantState; level?: number; size?: number; onClick?: () => void }) {
  const pulse = state === 'listening' ? 1 + Math.min(0.25, level * 6) : 1
  return (
    <button className={`orb orb-${state}`} style={{ width: size, height: size }} onClick={onClick} aria-label={`Assistant ${state}`}>
      <svg viewBox="0 0 200 200" width={size} height={size}>
        <defs>
          <radialGradient id="core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--orb-core)" stopOpacity="1" />
            <stop offset="55%" stopColor="var(--accent)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="100" cy="100" r={44 * pulse} fill="url(#core)" className="orb-core" />
        <g className="orb-ring r1">
          <circle cx="100" cy="100" r="62" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="28 10" opacity="0.8" />
        </g>
        <g className="orb-ring r2">
          <circle cx="100" cy="100" r="76" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 8" opacity="0.6" />
        </g>
        <g className="orb-ring r3">
          <circle cx="100" cy="100" r="90" fill="none" stroke="var(--accent)" strokeWidth="1" strokeDasharray="60 20 10 20" opacity="0.4" />
        </g>
      </svg>
    </button>
  )
}
