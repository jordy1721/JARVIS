import Anthropic from '@anthropic-ai/sdk'
import { getSecret, getSettings } from '../store'
import { claudeJson, findClaude } from './claudeCli'

let client: Anthropic | null = null
let clientKey = ''

export function hasApiKey(): boolean {
  return !!(getSecret('anthropic') || process.env.ANTHROPIC_API_KEY)
}

/** Is the selected engine ready to use? */
export async function isConfigured(): Promise<boolean> {
  return getSettings().provider === 'subscription' ? !!(await findClaude()) : hasApiKey()
}

export function notConfiguredMessage(): string {
  return getSettings().provider === 'subscription'
    ? 'I need Claude Code to use your Claude subscription. Open Settings → Connection, click "Install Claude Code", then "Sign in to Claude".'
    : 'I need an Anthropic API key before I can help. Add one in Settings, or switch to your Claude subscription.'
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

/**
 * One-shot structured JSON call on the cheap model, used for memory extraction.
 * Goes through the Claude subscription or the API, whichever is selected.
 */
export async function cheapJson<T>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  maxTokens = 2000
): Promise<{ data: T; usage: Anthropic.Usage | null; model: string; subscription: boolean }> {
  const s = getSettings()
  if (s.provider === 'subscription') {
    const { data, result } = await claudeJson<T>(s.subFastModel, system, user, schema)
    return { data, usage: (result.usage as Anthropic.Usage) ?? null, model: s.subFastModel, subscription: true }
  }
  const res = await getClient().messages.create({
    model: s.fastModel,
    max_tokens: maxTokens,
    system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }]
  })
  if (res.stop_reason === 'refusal') throw new Error('Request declined')
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return { data: JSON.parse(text) as T, usage: res.usage, model: s.fastModel, subscription: false }
}
