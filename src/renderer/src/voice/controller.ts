import type { AssistantState, Settings } from '@shared/types'
import { Recorder } from './recorder'
import { onSpeakingChange, stopSpeaking } from './tts'
import { stripWakeWord } from './wake'

const NOISE = /^(\[.*\]|\(.*\)|thank you\.?|thanks for watching!?|you|bye\.?|\.+)$/i

export interface VoiceCallbacks {
  onState(state: AssistantState, caption?: string): void
  onTranscript(text: string): void
  onModelProgress(text: string | null): void
  onSttStatus(state: 'loading' | 'ready' | 'error', detail: string): void
  onLevel(level: number): void
}

export class VoiceController {
  private recorder: Recorder
  private worker: Worker
  private pending = new Map<number, (text: string) => void>()
  private nextId = 1
  private settings: Settings | null = null
  private pttActive = false
  private pttTimer: number | undefined
  private followUpUntil = 0
  private modelReady = false

  constructor(private cb: VoiceCallbacks) {
    this.worker = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e) => {
      const m = e.data
      if (m.type === 'progress') {
        if (m.status === 'progress' && m.progress !== undefined) {
          const t = `Downloading speech recognition… ${Math.round(m.progress)}% (one-time)`
          cb.onModelProgress(m.progress >= 100 ? null : t)
          cb.onSttStatus('loading', t)
        }
      } else if (m.type === 'ready') {
        this.modelReady = true
        cb.onModelProgress(null)
        cb.onSttStatus('ready', `Ready (running on your ${m.device === 'webgpu' ? 'graphics card' : 'processor'})`)
      } else if (m.type === 'result' || m.type === 'error') {
        if (m.type === 'error') {
          console.error('[stt]', m.error)
          cb.onSttStatus('error', `Speech recognition failed: ${m.error}`)
        } else if (!this.modelReady) cb.onSttStatus('ready', 'Ready')
        this.modelReady = m.type === 'result'
        cb.onModelProgress(null)
        this.pending.get(m.id)?.(m.type === 'result' ? m.text : '')
        this.pending.delete(m.id)
      }
    }
    this.recorder = new Recorder({
      onLevel: (l) => cb.onLevel(l),
      onSpeechStart: () => {
        if (!this.settings?.requireWakeWord || Date.now() < this.followUpUntil) stopSpeaking()
      },
      onSegment: (audio) => void this.handleSegment(audio)
    })
    onSpeakingChange((speaking) => {
      // Don't let JARVIS hear itself in open-mic mode.
      this.recorder.muted = speaking
      if (!speaking) this.followUpUntil = Date.now() + 8000
      window.jarvis.send('voice:state', speaking ? 'speaking' : 'idle')
    })
  }

  async apply(s: Settings) {
    const prev = this.settings
    this.settings = s
    if (s.voiceMode !== 'off' && (prev?.sttModel !== s.sttModel || !prev)) {
      this.modelReady = false
      this.cb.onSttStatus('loading', 'Preparing speech recognition…')
      this.worker.postMessage({ type: 'load', model: s.sttModel })
    }
    if (s.voiceMode === 'open-mic') {
      await this.recorder.open()
      this.recorder.startVad()
    } else {
      this.recorder.stopVad()
      if (s.voiceMode === 'off') this.recorder.close()
    }
  }

  get listening() {
    return this.pttActive
  }

  async togglePtt() {
    if (!this.settings || this.settings.voiceMode === 'off') return
    if (this.pttActive) return this.finishPtt()
    stopSpeaking()
    await this.recorder.open()
    this.recorder.startManual()
    this.pttActive = true
    this.cb.onState('listening', 'Listening…')
    window.jarvis.send('voice:state', 'listening', 'Listening…')
    this.pttTimer = window.setTimeout(() => void this.finishPtt(), 30000)
  }

  async finishPtt() {
    if (!this.pttActive) return
    this.pttActive = false
    clearTimeout(this.pttTimer)
    const audio = this.recorder.stopManual()
    if (this.settings?.voiceMode === 'open-mic') this.recorder.startVad()
    else if (this.settings?.voiceMode === 'push-to-talk') {
      // release the mic so the OS indicator goes away
      setTimeout(() => !this.pttActive && this.recorder.close(), 500)
    }
    if (audio.length < 16000 * 0.3) {
      this.cb.onState('idle')
      window.jarvis.send('voice:state', 'idle')
      return
    }
    const text = await this.transcribe(audio)
    if (text) this.cb.onTranscript(text)
    else {
      this.cb.onState('idle')
      window.jarvis.send('voice:state', 'idle', "I didn't catch that")
    }
  }

  /** Settings → Voice check: record a few seconds and return what was heard. */
  async testMicrophone(seconds = 4): Promise<string> {
    await this.recorder.open()
    const wasVad = this.settings?.voiceMode === 'open-mic'
    this.recorder.startManual()
    await new Promise((r) => setTimeout(r, seconds * 1000))
    const audio = this.recorder.stopManual()
    if (wasVad) this.recorder.startVad()
    else if (this.settings?.voiceMode !== 'open-mic') this.recorder.close()
    let peak = 0
    for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]))
    if (audio.length === 0) return '(no audio received — check that a microphone is connected and allowed)'
    if (peak < 0.01) return '(only silence — the microphone may be muted or the wrong one is selected in Windows sound settings)'
    const text = await this.transcribe(audio, true)
    return text || '(heard sound but no words — try speaking louder or closer)'
  }

  cancel() {
    if (this.pttActive) {
      this.pttActive = false
      clearTimeout(this.pttTimer)
      this.recorder.stopManual()
    }
  }

  private async handleSegment(audio: Float32Array) {
    const s = this.settings
    if (!s) return
    const text = await this.transcribe(audio, true)
    if (!text) return
    if (s.requireWakeWord && Date.now() > this.followUpUntil) {
      const rest = stripWakeWord(text, s.wakeWord)
      if (rest === null) {
        window.jarvis.send('voice:state', 'idle')
        return
      }
      stopSpeaking()
      if (!rest) {
        this.followUpUntil = Date.now() + 8000
        window.jarvis.send('voice:state', 'listening', 'Yes?')
        return
      }
      this.cb.onTranscript(rest)
      return
    }
    this.cb.onTranscript(text)
  }

  transcribe(audio: Float32Array, quiet = false): Promise<string> {
    if (!quiet) {
      this.cb.onState('transcribing', 'Transcribing…')
      window.jarvis.send('voice:state', 'transcribing', 'Transcribing…')
    }
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, (t) => resolve(NOISE.test(t.trim()) ? '' : t.trim()))
      this.worker.postMessage({ type: 'transcribe', id, audio, model: this.settings?.sttModel }, [audio.buffer])
    })
  }
}
