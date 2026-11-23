import { useEffect, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/types'
import { api, toast, useStore } from '../store'
import { listVoices, speak } from '../voice/tts'

const MODELS = [
  ['claude-haiku-5-5', 'Claude Haiku 5.5 — $0.10 / $0.50 per M tokens (cheapest)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 — $2 / $10'],
  ['claude-opus-5-5', 'Claude Opus 5.5 — $4 / $20'],
  ['claude-fable-5-2', 'Claude Fable 5.2 — $8 / $40 (most capable)']
]
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const STT = [
  ['onnx-community/whisper-tiny.en', 'Whisper tiny (fastest, ~40 MB)'],
  ['onnx-community/whisper-base.en', 'Whisper base (recommended, ~80 MB)'],
  ['onnx-community/whisper-small.en', 'Whisper small (most accurate, ~250 MB)']
]

function Section({ title, children, desc }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="card settings-section">
      <h3>{title}</h3>
      {desc && <p className="muted small">{desc}</p>}
      {children}
    </section>
  )
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="muted small">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function SettingsPage() {
  const s = useStore((st) => st.settings)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [elevenKey, setElevenKey] = useState('')
  const [, force] = useState(0)

  useEffect(() => {
    api.invoke<boolean>('secret:has', 'anthropic').then(setHasKey)
    const t = setTimeout(() => force((n) => n + 1), 500) // voices load late
    return () => clearTimeout(t)
  }, [])
  if (!s) return null

  const set = (patch: Partial<Settings>) => api.invoke('settings:set', patch)
  const bool = (k: keyof Settings) => (
    <input type="checkbox" className="toggle" checked={!!s[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<Settings>)} />
  )
  const text = (k: keyof Settings, placeholder = '') => (
    <input defaultValue={String(s[k] ?? '')} placeholder={placeholder} onBlur={(e) => set({ [k]: e.target.value } as Partial<Settings>)} />
  )
  const num = (k: keyof Settings, step = 1, min = 0) => (
    <input type="number" step={step} min={min} defaultValue={Number(s[k])} onBlur={(e) => set({ [k]: Number(e.target.value) } as Partial<Settings>)} />
  )
  const select = (k: keyof Settings, options: (string | string[])[]) => (
    <select value={String(s[k])} onChange={(e) => set({ [k]: e.target.value } as Partial<Settings>)}>
      {options.map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o]
        return (
          <option key={v} value={v}>
            {l}
          </option>
        )
      })}
    </select>
  )

  return (
    <div className="page settings">
      <header className="page-head">
        <h2>Settings</h2>
      </header>

      <Section title="Connection" desc="JARVIS uses Claude through your own Anthropic API key. Get one at console.anthropic.com. The key is encrypted with your system keychain.">
        <Field label="Anthropic API key" hint={hasKey ? 'A key is saved ✓' : 'Required'}>
          <div className="row">
            <input type="password" className="grow" placeholder={hasKey ? '•••••••• (saved)' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} />
            <button
              className="btn primary"
              onClick={async () => {
                await api.invoke('secret:set', 'anthropic', key)
                setKey('')
                setHasKey(!!key)
                toast(key ? 'API key saved' : 'API key removed')
              }}
            >
              Save
            </button>
          </div>
        </Field>
      </Section>

      <Section title="Personal">
        <Field label="Your name">{text('userName', 'What should I call you?')}</Field>
        <Field label="Assistant name">{text('assistantName')}</Field>
        <Field label="Theme">{select('theme', ['dark', 'light'])}</Field>
        <Field label="Launch at login">{bool('launchAtLogin')}</Field>
        <Field label="Show on-screen HUD" hint="Small status orb and captions over your desktop">
          {bool('showHud')}
        </Field>
      </Section>

      <Section
        title="Cost control"
        desc="Most requests go to the cheap fast model. The smart model is used only for hard requests (coding, analysis, self-modification) or when the fast model asks for help."
      >
        <Field label="Routing">
          {select('routing', [
            ['auto', 'Auto (recommended): fast model, escalate when needed'],
            ['fast', 'Always use the fast model'],
            ['smart', 'Always use the smart model']
          ])}
        </Field>
        <Field label="Fast model">{select('fastModel', MODELS)}</Field>
        <Field label="Fast model effort" hint="Lower = cheaper and quicker">
          {select('fastEffort', EFFORTS)}
        </Field>
        <Field label="Smart model">{select('smartModel', MODELS)}</Field>
        <Field label="Smart model effort">{select('smartEffort', EFFORTS)}</Field>
        <Field label="Daily spending limit (USD)" hint="0 = no limit">
          {num('dailyBudgetUsd', 0.25)}
        </Field>
        <Field label="Max steps per request" hint="Caps runaway computer-control loops">
          {num('maxToolStepsPerTurn', 1, 1)}
        </Field>
        <Field label="Conversation context limit (tokens)" hint="Start a fresh context beyond this; memory keeps continuity">
          {num('sessionTokenLimit', 5000, 5000)}
        </Field>
      </Section>

      <Section title="Voice" desc="Speech recognition runs locally on your computer (free, private). The model downloads once on first use.">
        <Field label="Input mode">
          {select('voiceMode', [
            ['push-to-talk', 'Push to talk (press hotkey, speak, press again)'],
            ['open-mic', 'Open mic (always listening)'],
            ['off', 'Off']
          ])}
        </Field>
        <Field label="Push-to-talk hotkey" hint="Electron accelerator, e.g. CommandOrControl+Shift+Space">
          {text('pushToTalkHotkey')}
        </Field>
        <Field label="Require wake word in open-mic mode">{bool('requireWakeWord')}</Field>
        <Field label="Wake word">{text('wakeWord')}</Field>
        <Field label="Speech recognition model">{select('sttModel', STT)}</Field>
        <Field label="Speak replies to voice requests">{bool('ttsEnabled')}</Field>
        <Field label="Voice">
          <div className="row">
            <select value={s.ttsVoice} onChange={(e) => set({ ttsVoice: e.target.value })} className="grow">
              <option value="">Automatic (British voice if available)</option>
              {listVoices().map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
            <button className="btn ghost" onClick={() => speak(`Good day${s.userName ? ', ' + s.userName : ''}. All systems are online.`)}>
              Test
            </button>
          </div>
        </Field>
        <Field label="Speaking rate">{num('ttsRate', 0.05, 0.5)}</Field>
        <details>
          <summary className="muted small">Premium voice (optional, ElevenLabs — costs extra)</summary>
          <Field label="ElevenLabs API key">
            <div className="row">
              <input type="password" className="grow" value={elevenKey} onChange={(e) => setElevenKey(e.target.value)} />
              <button className="btn ghost" onClick={() => api.invoke('secret:set', 'elevenlabs', elevenKey).then(() => (setElevenKey(''), toast('Saved')))}>
                Save
              </button>
            </div>
          </Field>
          <Field label="ElevenLabs voice ID" hint="Leave empty to use the free system voice">
            {text('elevenLabsVoiceId')}
          </Field>
        </details>
      </Section>

      <Section title="Computer control & safety">
        <Field label="Approval mode">
          {select('autonomy', [
            ['ask-risky', 'Ask before risky actions (recommended)'],
            ['ask-always', 'Ask before every action'],
            ['autonomous', 'Fully autonomous (no prompts)']
          ])}
        </Field>
        <Field label="Allow mouse & keyboard control">{bool('allowComputerControl')}</Field>
        <Field label="Allow shell commands">{bool('allowShell')}</Field>
        <Field label="Allow web search" hint="Smart model only; $10 per 1,000 searches plus tokens">
          {bool('allowWebSearch')}
        </Field>
        <Field label="Emergency stop hotkey">{text('stopHotkey')}</Field>
      </Section>

      <Section title="Learning" desc="Everything learned is stored only on this computer. Review it in Memory.">
        <Field label="Learn from conversations" hint="Cheap background summaries with the fast model">
          {bool('learnFromConversations')}
        </Field>
        <Field label="Learn from app usage" hint="Samples the focused app once a minute">
          {bool('trackActivity')}
        </Field>
      </Section>

      <Section title="Self-modification" desc="JARVIS can propose changes to its own code. You always review and approve the diff first.">
        <Field label="Allow self-modification proposals">{bool('allowSelfModification')}</Field>
        <Field label="Source folder" hint="Leave empty to auto-detect when running from source">
          {text('sourceDir', '/path/to/JARVIS')}
        </Field>
      </Section>
    </div>
  )
}
