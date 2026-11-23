import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectionStatus, Settings } from '@shared/types'
import { api, toast, useStore } from '../store'
import { listVoices, onTtsStatus, speak, stopSpeaking, type TtsStatus } from '../voice/tts'
import { voice } from '../voice/instance'

const MODELS = [
  ['claude-haiku-5-5', 'Claude Haiku 5.5 — $0.10 / $0.50 per M tokens (cheapest)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 — $2 / $10'],
  ['claude-opus-5-5', 'Claude Opus 5.5 — $4 / $20'],
  ['claude-fable-5-2', 'Claude Fable 5.2 — $8 / $40 (most capable)']
]
const SUB_MODELS = [
  ['haiku', 'Haiku — fastest, uses the least of your plan'],
  ['sonnet', 'Sonnet — balanced'],
  ['opus', 'Opus — smartest, uses your plan fastest']
]
const NEURAL_VOICES = [
  ['bm_george', 'George — British male (JARVIS default)'],
  ['bm_fable', 'Fable — British male'],
  ['bm_lewis', 'Lewis — British male, deeper'],
  ['bm_daniel', 'Daniel — British male, softer'],
  ['bf_emma', 'Emma — British female'],
  ['bf_isabella', 'Isabella — British female'],
  ['am_michael', 'Michael — American male'],
  ['am_fenrir', 'Fenrir — American male'],
  ['af_heart', 'Heart — American female (highest rated)'],
  ['af_bella', 'Bella — American female']
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

      <Connection settings={s} set={set} hasKey={hasKey} setHasKey={setHasKey} apiKey={key} setApiKey={setKey} />

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
        title={s.provider === 'subscription' ? 'Usage control' : 'Cost control'}
        desc={
          s.provider === 'subscription'
            ? 'Requests count toward your Claude plan’s usage limits (shared with claude.ai). Everyday requests use the lighter model so your limits last longer.'
            : 'Most requests go to the cheap fast model. The smart model is used only for hard requests (coding, analysis, self-modification) or when the fast model asks for help.'
        }
      >
        <Field label="Routing">
          {select('routing', [
            ['auto', 'Auto (recommended): fast model, escalate when needed'],
            ['fast', 'Always use the fast model'],
            ['smart', 'Always use the smart model']
          ])}
        </Field>
        {s.provider === 'subscription' ? (
          <>
            <Field label="Everyday model">{select('subFastModel', SUB_MODELS)}</Field>
            <Field label="Model for hard requests">{select('subSmartModel', SUB_MODELS)}</Field>
          </>
        ) : (
          <>
            <Field label="Fast model">{select('fastModel', MODELS)}</Field>
            <Field label="Smart model">{select('smartModel', MODELS)}</Field>
          </>
        )}
        <Field label="Everyday effort" hint="Lower = quicker and uses less">
          {select('fastEffort', EFFORTS)}
        </Field>
        <Field label="Hard-request effort">{select('smartEffort', EFFORTS)}</Field>
        {s.provider === 'api' && (
          <Field label="Daily spending limit (USD)" hint="0 = no limit">
            {num('dailyBudgetUsd', 0.25)}
          </Field>
        )}
        <Field label="Max steps per request" hint="Caps runaway computer-control loops">
          {num('maxToolStepsPerTurn', 1, 1)}
        </Field>
        <Field label="Conversation context limit (tokens)" hint="Start a fresh context beyond this; memory keeps continuity">
          {num('sessionTokenLimit', 5000, 5000)}
        </Field>
      </Section>

      <VoiceSection s={s} set={set} select={select} text={text} num={num} bool={bool} elevenKey={elevenKey} setElevenKey={setElevenKey} />

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
        <Field label="Allow web search" hint={s.provider === 'subscription' ? 'Uses Claude Code’s web search' : 'Smart model only; $10 per 1,000 searches plus tokens'}>
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

function Connection(p: {
  settings: Settings
  set: (patch: Partial<Settings>) => Promise<unknown>
  hasKey: boolean
  setHasKey: (v: boolean) => void
  apiKey: string
  setApiKey: (v: string) => void
}) {
  const s = p.settings
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const refresh = () => api.invoke<ConnectionStatus>('claude:status').then(setStatus)
  useEffect(() => {
    refresh()
  }, [s.provider, s.claudePath])

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    setTest(await api.invoke('claude:test'))
    setTesting(false)
  }

  return (
    <Section title="Connection" desc="Choose how JARVIS reaches Claude.">
      <div className="provider-cards">
        <button className={`provider ${s.provider === 'subscription' ? 'active' : ''}`} onClick={() => p.set({ provider: 'subscription' })}>
          <b>My Claude subscription</b>
          <span>Pro or Max plan · no API credits · uses your plan’s usage limits</span>
        </button>
        <button className={`provider ${s.provider === 'api' ? 'active' : ''}`} onClick={() => p.set({ provider: 'api' })}>
          <b>Anthropic API key</b>
          <span>Pay per use · separate from your subscription</span>
        </button>
      </div>

      {s.provider === 'subscription' && (
        <div className="steps">
          <p className="muted small">
            JARVIS runs through <b>Claude Code</b>, Anthropic’s official app that comes with your Pro plan. You sign in with Anthropic’s own login, and JARVIS never sees your
            password or login token.
          </p>
          <div className={`step ${status?.claudeInstalled ? 'done' : ''}`}>
            <span className="step-num">1</span>
            <div className="grow">
              <b>Install Claude Code</b>
              <div className="muted small">
                {status?.claudeInstalled ? `Found ${status.claudeVersion ?? ''} at ${status.claudePath}` : 'Opens a terminal running Anthropic’s official installer.'}
              </div>
            </div>
            {!status?.claudeInstalled && (
              <button className="btn primary" onClick={() => api.invoke('claude:install').then(() => toast('Follow the installer in the terminal, then click Re-check.'))}>
                Install Claude Code
              </button>
            )}
            <button className="btn ghost" onClick={refresh}>
              Re-check
            </button>
          </div>
          <div className="step">
            <span className="step-num">2</span>
            <div className="grow">
              <b>Sign in with your Claude account</b>
              <div className="muted small">
                Opens Claude Code in a terminal. Choose “Claude account with subscription” and log in. When you see the prompt, you can close the terminal.
              </div>
            </div>
            <button className="btn primary" disabled={!status?.claudeInstalled} onClick={() => api.invoke('claude:signin')}>
              Sign in to Claude
            </button>
          </div>
          <div className={`step ${test?.ok ? 'done' : ''}`}>
            <span className="step-num">3</span>
            <div className="grow">
              <b>Test the connection</b>
              <div className={`small ${test ? (test.ok ? 'ok-text' : 'err-text') : 'muted'}`}>{testing ? 'Testing…' : (test?.detail ?? 'Sends one tiny message.')}</div>
            </div>
            <button className="btn ghost" disabled={!status?.claudeInstalled || testing} onClick={runTest}>
              Test
            </button>
          </div>
          <Field label="Claude Code location" hint="Leave empty to find it automatically">
            <input defaultValue={s.claudePath} placeholder="auto-detect" onBlur={(e) => p.set({ claudePath: e.target.value.trim() })} />
          </Field>
        </div>
      )}

      {s.provider === 'api' && (
        <Field label="Anthropic API key" hint={p.hasKey ? 'A key is saved ✓' : 'Get one at console.anthropic.com'}>
          <div className="row">
            <input type="password" className="grow" placeholder={p.hasKey ? '•••••••• (saved)' : 'sk-ant-…'} value={p.apiKey} onChange={(e) => p.setApiKey(e.target.value)} />
            <button
              className="btn primary"
              onClick={async () => {
                await api.invoke('secret:set', 'anthropic', p.apiKey)
                p.setHasKey(!!p.apiKey)
                p.setApiKey('')
                toast(p.apiKey ? 'API key saved' : 'API key removed')
              }}
            >
              Save
            </button>
          </div>
        </Field>
      )}
    </Section>
  )
}

type Ctl = (k: keyof Settings, ...rest: any[]) => ReactNode

function VoiceSection(p: {
  s: Settings
  set: (patch: Partial<Settings>) => Promise<unknown>
  select: Ctl
  text: Ctl
  num: Ctl
  bool: Ctl
  elevenKey: string
  setElevenKey: (v: string) => void
}) {
  const { s, set, select, text, num, bool } = p
  const stt = useStore((st) => st.sttStatus)
  const [tts, setTts] = useState<TtsStatus>({ state: 'idle', detail: '' })
  const [heard, setHeard] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  useEffect(() => onTtsStatus(setTts), [])
  const sample = `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}${s.userName ? ', ' + s.userName : ''}. All systems are online and at your service.`

  return (
    <Section title="Voice" desc="Speech recognition and the neural voice both run on your own computer: free, private, and offline after a one-time download.">
      <div className="voice-check">
        <div className="vc-row">
          <span className={`vc-dot ${s.voiceMode === 'off' ? 'idle' : stt.state}`} />
          <div className="grow">
            <b>Hearing you</b>
            <div className="muted small">{s.voiceMode === 'off' ? 'Voice input is off' : stt.detail}</div>
            {heard !== null && <div className="small heard">I heard: “{heard}”</div>}
          </div>
          <button
            className="btn ghost"
            disabled={recording || s.voiceMode === 'off'}
            onClick={async () => {
              setRecording(true)
              setHeard(null)
              try {
                setHeard(await voice.testMicrophone(4))
              } catch (e) {
                setHeard(`(microphone error: ${(e as Error).message})`)
              }
              setRecording(false)
            }}
          >
            {recording ? 'Listening for 4 s… speak now' : 'Test microphone'}
          </button>
        </div>
        <div className="vc-row">
          <span className={`vc-dot ${s.ttsEngine === 'neural' ? tts.state : 'ready'}`} />
          <div className="grow">
            <b>Speaking to you</b>
            <div className="muted small">
              {s.ttsEngine === 'neural' ? tts.detail || 'Neural voice' : s.ttsEngine === 'system' ? 'Windows/macOS built-in voice' : 'ElevenLabs voice'}
            </div>
          </div>
          <button className="btn ghost" onClick={() => (stopSpeaking(), speak(sample))}>
            Test voice
          </button>
        </div>
      </div>

      <Field label="Input mode">
        {select('voiceMode', [
          ['push-to-talk', 'Push to talk (press hotkey, speak, press again)'],
          ['open-mic', 'Open mic — always listening for the wake word'],
          ['off', 'Off']
        ])}
      </Field>
      <Field label="Push-to-talk hotkey" hint="e.g. CommandOrControl+Shift+Space">
        {text('pushToTalkHotkey')}
      </Field>
      <Field label="Require wake word in open-mic mode">{bool('requireWakeWord')}</Field>
      <Field label="Wake word" hint="Close mishearings like “Java's” also count">
        {text('wakeWord')}
      </Field>
      <Field label="Speech recognition model">{select('sttModel', STT)}</Field>

      <Field label="Speak replies to voice requests">{bool('ttsEnabled')}</Field>
      <Field label="Also speak replies to typed messages">{bool('speakAllReplies')}</Field>
      <Field label="Voice engine">
        {select('ttsEngine', [
          ['neural', 'Neural voice — high quality, free, runs locally (recommended)'],
          ['system', 'System voice — built into Windows/macOS'],
          ['elevenlabs', 'ElevenLabs — premium, paid']
        ])}
      </Field>
      {s.ttsEngine === 'neural' && <Field label="Neural voice">{select('neuralVoice', NEURAL_VOICES)}</Field>}
      {s.ttsEngine === 'system' && (
        <Field label="System voice" hint="“Natural” voices sound best if Windows has them">
          <select value={s.ttsVoice} onChange={(e) => set({ ttsVoice: e.target.value })}>
            <option value="">Automatic (best available)</option>
            {listVoices().map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </Field>
      )}
      {s.ttsEngine === 'elevenlabs' && (
        <>
          <Field label="ElevenLabs API key">
            <div className="row">
              <input type="password" className="grow" value={p.elevenKey} onChange={(e) => p.setElevenKey(e.target.value)} />
              <button className="btn ghost" onClick={() => api.invoke('secret:set', 'elevenlabs', p.elevenKey).then(() => (p.setElevenKey(''), toast('Saved')))}>
                Save
              </button>
            </div>
          </Field>
          <Field label="ElevenLabs voice ID">{text('elevenLabsVoiceId')}</Field>
        </>
      )}
      <Field label="Speaking speed">{num('ttsRate', 0.05, 0.5)}</Field>
    </Section>
  )
}
