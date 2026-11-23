import Anthropic from '@anthropic-ai/sdk'
import { getSecret } from '../store'

let client: Anthropic | null = null
let clientKey = ''

export function hasApiKey(): boolean {
  return !!(getSecret('anthropic') || process.env.ANTHROPIC_API_KEY)
}

export function getClient(): Anthropic {
  const key = getSecret('anthropic') || process.env.ANTHROPIC_API_KEY || ''
  if (!key) throw new Error('No Anthropic API key set. Add one in Settings.')
  if (!client || key !== clientKey) {
    client = new Anthropic({ apiKey: key, maxRetries: 2 })
    clientKey = key
  }
  return client
}

export function resetClient(): void {
  client = null
}

/** One-shot JSON call on the cheap model, used for memory extraction and summaries. */
export async function cheapJson<T>(
  model: string,
  system: string,
  user: string,
  schema: Record<string, unknown>,
  maxTokens = 2000
): Promise<{ data: T; usage: Anthropic.Usage }> {
  const res = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }]
  })
  if (res.stop_reason === 'refusal') throw new Error('Request declined')
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return { data: JSON.parse(text) as T, usage: res.usage }
}

export async function cheapText(model: string, system: string, user: string, maxTokens = 1500) {
  const res = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: user }]
  })
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return { text, usage: res.usage }
}
