// High-quality, free, offline text-to-speech with the Kokoro-82M neural voice model
// (Apache-2.0), running locally through transformers.js. Downloads once (~90 MB), then
// works offline. Adapted from kokoro-js (Apache-2.0).
import { AutoTokenizer, StyleTextToSpeech2Model, Tensor, env } from '@huggingface/transformers'
import { phonemize } from 'phonemizer'

env.allowLocalModels = false

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const SAMPLE_RATE = 24000

let model: any = null
let tokenizer: any = null
let loading: Promise<void> | null = null
let device = 'wasm'
const voiceCache = new Map<string, Float32Array>()

async function load() {
  if (model) return
  if (!loading) {
    loading = (async () => {
      const progress = (p: { status: string; progress?: number }) => {
        if (p.status === 'progress' && p.progress !== undefined) self.postMessage({ type: 'progress', progress: p.progress })
      }
      const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(await (navigator as any).gpu?.requestAdapter?.())
      const attempts: { device: string; dtype: string }[] = hasWebGpu
        ? [
            { device: 'webgpu', dtype: 'fp32' },
            { device: 'wasm', dtype: 'q8' }
          ]
        : [{ device: 'wasm', dtype: 'q8' }]
      let lastErr: unknown
      for (const a of attempts) {
        try {
          model = await StyleTextToSpeech2Model.from_pretrained(MODEL_ID, { dtype: a.dtype, device: a.device, progress_callback: progress } as never)
          device = a.device
          break
        } catch (e) {
          lastErr = e
        }
      }
      if (!model) throw lastErr
      tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
    })()
  }
  await loading
}

async function voiceData(voice: string): Promise<Float32Array> {
  const cached = voiceCache.get(voice)
  if (cached) return cached
  const url = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${voice}.bin`
  let buf: ArrayBuffer | null = null
  let cache: Cache | null = null
  try {
    cache = await caches.open('kokoro-voices')
    const hit = await cache.match(url)
    if (hit) buf = await hit.arrayBuffer()
  } catch {
    /* Cache API unavailable */
  }
  if (!buf) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Voice ${voice} download failed (${res.status})`)
    buf = await res.arrayBuffer()
    try {
      await cache?.put(url, new Response(buf.slice(0)))
    } catch {
      /* ignore */
    }
  }
  const data = new Float32Array(buf)
  voiceCache.set(voice, data)
  return data
}

// ---------------- text normalisation (from kokoro-js / misaki) ----------------
function splitNum(m: string): string {
  if (m.includes('.')) return m
  if (m.includes(':')) {
    const [h, min] = m.split(':').map(Number)
    return min === 0 ? `${h} o'clock` : min < 10 ? `${h} oh ${min}` : `${h} ${min}`
  }
  const year = parseInt(m.slice(0, 4), 10)
  if (year < 1100 || year % 1000 < 10) return m
  const left = m.slice(0, 2)
  const right = parseInt(m.slice(2, 4), 10)
  const s = m.endsWith('s') ? 's' : ''
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${s}`
    if (right < 10) return `${left} oh ${right}${s}`
  }
  return `${left} ${right}${s}`
}
function money(m: string): string {
  const unit = m[0] === '$' ? 'dollar' : 'pound'
  if (isNaN(Number(m.slice(1)))) return `${m.slice(1)} ${unit}s`
  if (!m.includes('.')) return `${m.slice(1)} ${unit}${m.slice(1) === '1' ? '' : 's'}`
  const [b, c] = m.slice(1).split('.')
  const cents = parseInt(c.padEnd(2, '0'), 10)
  const sub = m[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence'
  return `${b} ${unit}${b === '1' ? '' : 's'} and ${cents} ${sub}`
}
function decimal(m: string): string {
  const [a, b] = m.split('.')
  return `${a} point ${b.split('').join(' ')}`
}
function normalize(t: string): string {
  return t
    .replace(/[‘’]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/g, ' ')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, money)
    .replace(/\d*\.\d+/g, decimal)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim()
}

const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]'
const PUNCT_RE = new RegExp(`(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g')

async function toPhonemes(text: string, british: boolean): Promise<string> {
  const norm = normalize(text)
  const parts: { punct: boolean; text: string }[] = []
  let last = 0
  for (const m of norm.matchAll(PUNCT_RE)) {
    if (last < m.index!) parts.push({ punct: false, text: norm.slice(last, m.index) })
    if (m[0].length) parts.push({ punct: true, text: m[0] })
    last = m.index! + m[0].length
  }
  if (last < norm.length) parts.push({ punct: false, text: norm.slice(last) })
  const lang = british ? 'en' : 'en-us'
  const out = (await Promise.all(parts.map(async (p) => (p.punct ? p.text : (await phonemize(p.text, lang)).join(' '))))).join('')
  let ph = out
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
  if (!british) ph = ph.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di')
  return ph.trim()
}

async function generate(text: string, voice: string, speed: number): Promise<Float32Array> {
  await load()
  const phonemes = await toPhonemes(text, voice.startsWith('b'))
  const { input_ids } = tokenizer(phonemes, { truncation: true })
  const style = await voiceData(voice)
  const n = Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), 509)
  const ref = style.slice(256 * n, 256 * n + 256)
  const { waveform } = await model({
    input_ids,
    style: new Tensor('float32', ref, [1, 256]),
    speed: new Tensor('float32', [speed], [1])
  })
  return waveform.data as Float32Array
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data
  try {
    if (m.type === 'load') {
      await load()
      await voiceData(m.voice)
      self.postMessage({ type: 'ready', device })
    } else if (m.type === 'speak') {
      const audio = await generate(m.text, m.voice, m.speed ?? 1)
      self.postMessage({ type: 'audio', id: m.id, audio, sampleRate: SAMPLE_RATE }, { transfer: [audio.buffer] })
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, error: String(err) })
  }
}
