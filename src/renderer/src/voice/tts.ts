// Text-to-speech. Uses the operating system's built-in voices (free). Optionally uses an
// ElevenLabs voice if the user adds a key in Settings.
import type { Settings } from '@shared/types'

let queue: string[] = []
let speaking = false
let audioEl: HTMLAudioElement | null = null
let listeners: ((speaking: boolean) => void)[] = []

export function onSpeakingChange(cb: (s: boolean) => void) {
  listeners.push(cb)
  return () => (listeners = listeners.filter((l) => l !== cb))
}
function setSpeaking(v: boolean) {
  if (speaking === v) return
  speaking = v
  listeners.forEach((l) => l(v))
}

export function listVoices(): SpeechSynthesisVoice[] {
  return window.speechSynthesis?.getVoices() ?? []
}

function pickVoice(name: string): SpeechSynthesisVoice | undefined {
  const voices = listVoices()
  if (name) return voices.find((v) => v.name === name)
  // A British male voice suits the JARVIS persona.
  const prefs = [/daniel/i, /george/i, /ryan/i, /arthur/i, /en-GB.*male/i, /UK English Male/i, /en-GB/i, /en-US/i]
  for (const p of prefs) {
    const v = voices.find((x) => p.test(x.name) || p.test(`${x.lang} ${x.name}`))
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

let settingsRef: Settings | null = null
export function configureTts(s: Settings) {
  settingsRef = s
}

export function speak(text: string) {
  const t = clean(text)
  if (!t) return
  queue.push(t)
  if (!speaking) void next()
}

async function next() {
  const text = queue.shift()
  if (!text) {
    setSpeaking(false)
    return
  }
  setSpeaking(true)
  const s = settingsRef
  if (s?.elevenLabsVoiceId) {
    try {
      const b64: string | null = await window.jarvis.invoke('tts:eleven', text)
      if (b64) {
        audioEl = new Audio(`data:audio/mpeg;base64,${b64}`)
        audioEl.playbackRate = s.ttsRate
        audioEl.onended = () => void next()
        audioEl.onerror = () => void next()
        await audioEl.play()
        return
      }
    } catch {
      /* fall back to system voice */
    }
  }
  const u = new SpeechSynthesisUtterance(text)
  const v = pickVoice(s?.ttsVoice ?? '')
  if (v) u.voice = v
  u.rate = s?.ttsRate ?? 1
  u.pitch = 0.95
  u.onend = () => void next()
  u.onerror = () => void next()
  window.speechSynthesis.speak(u)
}

export function stopSpeaking() {
  queue = []
  window.speechSynthesis?.cancel()
  if (audioEl) {
    audioEl.pause()
    audioEl = null
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
