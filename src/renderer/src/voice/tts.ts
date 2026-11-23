// Text-to-speech. Default: a free, high-quality neural voice (Kokoro) running locally.
// Fallbacks: the operating system's voices (free), or an optional ElevenLabs voice.
import type { Settings } from '@shared/types'

type Listener = (speaking: boolean) => void
let listeners: Listener[] = []
let speaking = false
let settingsRef: Settings | null = null

export function onSpeakingChange(cb: Listener) {
  listeners.push(cb)
  return () => {
    listeners = listeners.filter((l) => l !== cb)
  }
}
function setSpeaking(v: boolean) {
  if (speaking === v) return
  speaking = v
  listeners.forEach((l) => l(v))
}

// ---------------- status (shown in Settings) ----------------
export interface TtsStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  detail: string
}
let status: TtsStatus = { state: 'idle', detail: '' }
let statusListeners: ((s: TtsStatus) => void)[] = []
export function onTtsStatus(cb: (s: TtsStatus) => void) {
  statusListeners.push(cb)
  cb(status)
  return () => {
    statusListeners = statusListeners.filter((l) => l !== cb)
  }
}
function setStatus(s: TtsStatus) {
  status = s
  statusListeners.forEach((l) => l(s))
}

// ---------------- neural voice worker ----------------
let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (a: Float32Array) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const m = e.data
    if (m.type === 'progress') setStatus({ state: 'loading', detail: `Downloading voice… ${Math.round(m.progress)}% (one-time, ~90 MB)` })
    else if (m.type === 'ready') setStatus({ state: 'ready', detail: `Neural voice ready (${m.device === 'webgpu' ? 'graphics card' : 'processor'})` })
    else if (m.type === 'audio') {
      if (status.state !== 'ready') setStatus({ state: 'ready', detail: 'Neural voice ready' })
      pending.get(m.id)?.resolve(m.audio)
      pending.delete(m.id)
    } else if (m.type === 'error') {
      console.error('[tts]', m.error)
      if (m.id === undefined) setStatus({ state: 'error', detail: `Neural voice unavailable: ${m.error}` })
      pending.get(m.id)?.reject(new Error(m.error))
      pending.delete(m.id)
    }
  }
  return worker
}

function neuralEnabled(): boolean {
  return (settingsRef?.ttsEngine ?? 'neural') === 'neural'
}

function synth(text: string): Promise<Float32Array> {
  const id = nextId++
  const s = settingsRef
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ type: 'speak', id, text, voice: s?.neuralVoice || 'bm_george', speed: s?.ttsRate ?? 1 })
  })
}

export function configureTts(s: Settings) {
  const prev = settingsRef
  settingsRef = s
  // Warm the voice up in the background so the first reply isn't delayed by the download.
  if (s.ttsEnabled && neuralEnabled() && (prev?.neuralVoice !== s.neuralVoice || prev?.ttsEngine !== s.ttsEngine || !prev)) {
    if (status.state !== 'ready') setStatus({ state: 'loading', detail: 'Preparing neural voice…' })
    getWorker().postMessage({ type: 'load', voice: s.neuralVoice || 'bm_george' })
  }
}

export function listVoices(): SpeechSynthesisVoice[] {
  return window.speechSynthesis?.getVoices() ?? []
}

function pickSystemVoice(name: string): SpeechSynthesisVoice | undefined {
  const voices = listVoices()
  if (name) return voices.find((v) => v.name === name)
  // Prefer the higher-quality "Natural"/"Online" voices when the OS has them, British first.
  const prefs = [/natural.*(en-GB|United Kingdom)/i, /(Ryan|Thomas).*natural/i, /natural/i, /daniel/i, /george/i, /en-GB/i, /en-US/i]
  for (const p of prefs) {
    const v = voices.find((x) => p.test(`${x.name} ${x.lang}`))
    if (v) return v
  }
  return voices[0]
}

function clean(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[*_#>|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------- playback queue ----------------
// Each sentence is synthesised as soon as it arrives, so the next one is ready while the
// current one plays.
type Item = { text: string; audio?: Promise<Float32Array | null>; kind: 'neural' | 'system' | 'eleven' }
let queue: Item[] = []
let playing = false
let epoch = 0
let audioCtx: AudioContext | null = null
let currentSource: AudioBufferSourceNode | null = null
let currentEl: HTMLAudioElement | null = null

export function speak(text: string) {
  const t = clean(text)
  if (!t) return
  const s = settingsRef
  const kind: Item['kind'] = s?.ttsEngine === 'elevenlabs' && s.elevenLabsVoiceId ? 'eleven' : neuralEnabled() ? 'neural' : 'system'
  const item: Item = { text: t, kind }
  if (kind === 'neural') item.audio = synth(t).catch(() => null)
  queue.push(item)
  if (!playing) void playNext(epoch)
}

async function playNext(myEpoch: number) {
  if (myEpoch !== epoch) return
  const item = queue.shift()
  if (!item) {
    playing = false
    setSpeaking(false)
    return
  }
  playing = true
  setSpeaking(true)
  const done = () => void playNext(myEpoch)
  try {
    if (item.kind === 'neural') {
      const audio = await item.audio
      if (myEpoch !== epoch) return
      if (audio && audio.length) return playPcm(audio, done)
      return playSystem(item.text, done) // fall back if the neural voice failed
    }
    if (item.kind === 'eleven') {
      const b64: string | null = await window.jarvis.invoke('tts:eleven', item.text)
      if (myEpoch !== epoch) return
      if (b64) {
        currentEl = new Audio(`data:audio/mpeg;base64,${b64}`)
        currentEl.playbackRate = settingsRef?.ttsRate ?? 1
        currentEl.onended = done
        currentEl.onerror = done
        await currentEl.play()
        return
      }
    }
    playSystem(item.text, done)
  } catch {
    done()
  }
}

function playPcm(pcm: Float32Array, done: () => void) {
  audioCtx ??= new AudioContext({ sampleRate: 24000 })
  if (audioCtx.state === 'suspended') void audioCtx.resume()
  const buf = audioCtx.createBuffer(1, pcm.length, 24000)
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0)
  const src = audioCtx.createBufferSource()
  src.buffer = buf
  src.connect(audioCtx.destination)
  src.onended = () => {
    if (currentSource === src) currentSource = null
    done()
  }
  currentSource = src
  src.start()
}

function playSystem(text: string, done: () => void) {
  if (!window.speechSynthesis) return done()
  const u = new SpeechSynthesisUtterance(text)
  const v = pickSystemVoice(settingsRef?.ttsVoice ?? '')
  if (v) u.voice = v
  u.rate = settingsRef?.ttsRate ?? 1
  u.onend = done
  u.onerror = done
  window.speechSynthesis.speak(u)
}

export function stopSpeaking() {
  epoch++
  queue = []
  playing = false
  window.speechSynthesis?.cancel()
  try {
    currentSource?.stop()
  } catch {
    /* already stopped */
  }
  currentSource = null
  if (currentEl) {
    currentEl.pause()
    currentEl = null
  }
  setSpeaking(false)
}

/** Splits a stream of text into sentences so speech starts before the reply is finished. */
export class SentenceChunker {
  private buf = ''
  push(delta: string): string[] {
    this.buf += delta
    const out: string[] = []
    const re = /[^.!?\n]+[.!?]+(?=\s|$)|[^\n]+\n/g
    let m: RegExpExecArray | null
    let last = 0
    while ((m = re.exec(this.buf))) {
      if (m.index + m[0].length === this.buf.length && !/\n$/.test(m[0]) && !/\s$/.test(this.buf)) break
      out.push(m[0])
      last = m.index + m[0].length
    }
    this.buf = this.buf.slice(last)
    return out.filter((s) => s.trim().length > 1)
  }
  flush(): string {
    const r = this.buf
    this.buf = ''
    return r
  }
}
