// Local speech-to-text with Whisper running inside the app (transformers.js).
// Free: no audio leaves the computer and no API credits are used.
import { pipeline, env } from '@huggingface/transformers'

env.allowLocalModels = false

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>
let asr: Asr | null = null
let loadedModel = ''

async function load(model: string) {
  if (asr && loadedModel === model) return
  const progress = (p: { status: string; progress?: number; file?: string }) =>
    self.postMessage({ type: 'progress', status: p.status, progress: p.progress, file: p.file })
  const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  try {
    if (!hasWebGpu) throw new Error('no webgpu')
    asr = (await pipeline('automatic-speech-recognition', model, {
      device: 'webgpu',
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      progress_callback: progress
    } as never)) as unknown as Asr
  } catch {
    asr = (await pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: progress
    } as never)) as unknown as Asr
  }
  loadedModel = model
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      await load(msg.model)
      self.postMessage({ type: 'ready' })
    } else if (msg.type === 'transcribe') {
      await load(msg.model)
      const out = await asr!(msg.audio as Float32Array, { chunk_length_s: 30 })
      const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
      self.postMessage({ type: 'result', id: msg.id, text: text.trim() })
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, error: String(err) })
  }
}
