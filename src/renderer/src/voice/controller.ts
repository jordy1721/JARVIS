import type { AssistantState, Settings } from '@shared/types'
import { Recorder } from './recorder'
import { onSpeakingChange, stopSpeaking } from './tts'

const NOISE = /^(\[.*\]|\(.*\)|thank you\.?|thanks for watching!?|you|bye\.?|\.+)$/i

export interface VoiceCallbacks {
  onState(state: AssistantState, caption?: string): void
  onTranscript(text: string): void
  onModelProgress(text: string | null): void
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
        if (m.status === 'progress' && m.progress !== undefined)
          cb.onModelProgress(`Downloading speech model… ${Math.round(m.progress)}% (one-time)`)
      } else if (m.type === 'ready') {
        this.modelReady = true
        cb.onModelProgress(null)
      } else if (m.type === 'result' || m.type === 'error') {
        if (m.type === 'error') console.error('[stt]', m.error)
        this.modelReady = true
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
    if (!this.modelReady && s.voiceMode !== 'off' && prev?.sttModel !== s.sttModel) {
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
      const wake = s.wakeWord.toLowerCase().trim()
      const lower = text.toLowerCase()
      const idx = lower.search(new RegExp(`\\b(hey |ok |okay )?${wake.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[,.!?]?`))
      if (idx === -1) {
        window.jarvis.send('voice:state', 'idle')
        return
      }
      const after = text.slice(idx).replace(new RegExp(`^(hey |ok |okay )?${wake}[,.!?]?\\s*`, 'i'), '')
      if (!after.trim()) {
        stopSpeaking()
        this.followUpUntil = Date.now() + 8000
        window.jarvis.send('voice:state', 'listening', 'Yes?')
        return
      }
      stopSpeaking()
      this.cb.onTranscript(after.trim())
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
