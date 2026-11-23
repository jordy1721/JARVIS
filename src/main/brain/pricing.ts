// Per-million-token prices in USD (Anthropic first-party API). Edit here if prices change.
interface Price {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number // 5-minute cache write
  label: string
}

export const MODEL_PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, label: 'Claude Haiku 5.5 (fast, cheapest)' },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, label: 'Claude Sonnet 5.5 (balanced)' },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, label: 'Claude Opus 5.5 (smart)' },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, label: 'Claude Fable 5.2 (most capable, expensive)' }
}

export function priceFor(model: string): Price {
  return MODEL_PRICES[model] ?? MODEL_PRICES['claude-opus-5-5']
}

export interface UsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function costOf(model: string, u: UsageLike): number {
  const p = priceFor(model)
  const input = u.input_tokens ?? 0
  // Haiku 5.5 is priced higher above 100K prompt tokens.
  const longPrompt = model === 'claude-haiku-5-5' && input + (u.cache_read_input_tokens ?? 0) > 100_000
  const mult = longPrompt ? 5 : 1
  return (
    (input * p.input * mult +
      (u.output_tokens ?? 0) * p.output * mult +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead * mult +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite * mult) /
    1_000_000
  )
}

/** Models that accept the server-side refusal `fallbacks: "default"` parameter. */
export function supportsServerFallbacks(model: string): boolean {
  return ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'].includes(model)
}

/** Models that accept the dynamic-filtering web search tool. */
export function supportsWebSearch(model: string): boolean {
  return model !== 'claude-haiku-5-5'
}
