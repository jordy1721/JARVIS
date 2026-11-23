// Microphone capture at 16 kHz with a simple energy-based voice-activity detector.
export interface RecorderEvents {
  onSpeechStart?: () => void
  onSegment?: (audio: Float32Array) => void
  onLevel?: (level: number) => void
}

export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []
  private recording = false
  private vadActive = false
  private speaking = false
  private silenceMs = 0
  private speechMs = 0
  private noiseFloor = 0.008
  private preRoll: Float32Array[] = []

  constructor(private ev: RecorderEvents) {}

  get isOpen() {
    return !!this.ctx
  }

  async open(): Promise<void> {
    if (this.ctx) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    this.ctx = new AudioContext({ sampleRate: 16000 })
    const src = this.ctx.createMediaStreamSource(this.stream)
    // ScriptProcessor is deprecated but universally available and fine for 16 kHz mono.
    this.node = this.ctx.createScriptProcessor(2048, 1, 1)
    this.node.onaudioprocess = (e) => this.process(new Float32Array(e.inputBuffer.getChannelData(0)))
    src.connect(this.node)
    this.node.connect(this.ctx.destination)
  }

  close(): void {
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.ctx?.close()
    this.ctx = null
    this.stream = null
    this.node = null
    this.recording = false
    this.vadActive = false
  }

  /** Push-to-talk: record everything until stop(). */
  startManual(): void {
    this.chunks = []
    this.recording = true
    this.vadActive = false
  }
  stopManual(): Float32Array {
    this.recording = false
    return this.flush()
  }

  /** Open mic: emit a segment for every utterance detected. */
  startVad(): void {
    this.vadActive = true
    this.recording = false
    this.speaking = false
    this.chunks = []
  }
  stopVad(): void {
    this.vadActive = false
    this.speaking = false
    this.chunks = []
  }

  /** Pause VAD while JARVIS talks so it doesn't hear itself. */
  muted = false

  private flush(): Float32Array {
    const len = this.chunks.reduce((s, c) => s + c.length, 0)
    const out = new Float32Array(len)
    let o = 0
    for (const c of this.chunks) {
      out.set(c, o)
      o += c.length
    }
    this.chunks = []
    return out
  }

  private process(buf: Float32Array) {
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    const rms = Math.sqrt(sum / buf.length)
    this.ev.onLevel?.(rms)
    const ms = (buf.length / 16000) * 1000

    if (this.recording) {
      this.chunks.push(buf)
      return
    }
    if (!this.vadActive || this.muted) return

    const threshold = Math.max(0.015, this.noiseFloor * 3)
    if (!this.speaking) {
      // track background noise slowly
      this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02
      this.preRoll.push(buf)
      if (this.preRoll.length > 4) this.preRoll.shift()
      if (rms > threshold) {
        this.speechMs += ms
        if (this.speechMs > 120) {
          this.speaking = true
          this.silenceMs = 0
          this.chunks = [...this.preRoll]
          this.ev.onSpeechStart?.()
        }
      } else this.speechMs = 0
      return
    }
    this.chunks.push(buf)
    if (rms < threshold * 0.7) this.silenceMs += ms
    else this.silenceMs = 0
    const total = this.chunks.length * ms
    if (this.silenceMs > 900 || total > 28000) {
      this.speaking = false
      this.speechMs = 0
      const audio = this.flush()
      if (audio.length > 16000 * 0.5) this.ev.onSegment?.(audio)
    }
  }
}
