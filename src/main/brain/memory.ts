// Long-term memory: JARVIS learns facts about the user from conversations (and optionally
// from app-usage activity), stores them locally, and injects only the relevant ones into
// each session so the prompt stays small and cheap.
import type { MemoryFact } from '@shared/types'
import { memory, getSettings, activity, kv } from '../store'
import { cheapJson, hasApiKey } from './client'
import { recordUsage, dayKey } from '../services/usage'

const STOP = new Set(
  'the a an and or but to of in on for with at by from is are was were be been it this that i you me my your we our they them he she his her its as do does did have has had not no so if then than can could would should will just about what when where who how which'.split(' ')
)

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  )
}

export function relevantFacts(query: string, limit = 25): MemoryFact[] {
  const facts = memory.all()
  if (facts.length <= limit) return facts
  const q = words(query)
  const scored = facts.map((f) => {
    const w = words(f.text)
    let overlap = 0
    for (const x of q) if (w.has(x)) overlap++
    const core = f.category === 'identity' || f.category === 'preference' ? 1.5 : 0
    const recency = Math.max(0, 1 - (Date.now() - f.updated) / (60 * 86400_000))
    return { f, score: f.importance + overlap * 2.5 + core + recency }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.f)
}

export function profileBlock(query: string): string {
  const s = getSettings()
  const facts = relevantFacts(query)
  for (const f of facts) memory.update(f.id, { uses: f.uses + 1 })
  const lines = facts.map((f) => `- [${f.id}] (${f.category}) ${f.text}`)
  return [
    s.userName ? `The user's name is ${s.userName}.` : '',
    lines.length ? `What you know about the user (memory ids in brackets):\n${lines.join('\n')}` : 'You do not know much about the user yet — learn as you go.'
  ]
    .filter(Boolean)
    .join('\n')
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    new_facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          category: {
            type: 'string',
            enum: ['identity', 'preference', 'work', 'routine', 'relationship', 'goal', 'skill', 'other']
          },
          importance: { type: 'integer', enum: [1, 2, 3, 4, 5] }
        },
        required: ['text', 'category', 'importance'],
        additionalProperties: false
      }
    },
    updated_facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false
      }
    },
    obsolete_ids: { type: 'array', items: { type: 'string' } }
  },
  required: ['new_facts', 'updated_facts', 'obsolete_ids'],
  additionalProperties: false
}

interface Extracted {
  new_facts: { text: string; category: MemoryFact['category']; importance: number }[]
  updated_facts: { id: string; text: string }[]
  obsolete_ids: string[]
}

/**
 * Reflect on a finished stretch of conversation and update memory.
 * Runs on the fast model with low effort — typically a fraction of a cent.
 */
export async function learnFromConversation(transcript: string, source: MemoryFact['source'] = 'conversation') {
  const s = getSettings()
  if (!s.learnFromConversations || !hasApiKey() || transcript.trim().length < 40) return
  const known = memory
    .all()
    .slice()
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 150)
    .map((f) => `${f.id}: ${f.text}`)
    .join('\n')
  const system =
    'You maintain a personal assistant\'s long-term memory about its user. Extract durable, useful facts about the USER ' +
    '(identity, preferences, work, routines, relationships, goals, skills). Ignore one-off requests, small talk, and anything about the assistant itself. ' +
    'Write each fact as a short third-person sentence ("Prefers dark mode", "Works as a video editor"). ' +
    'Do not repeat known facts; if new information changes a known fact, put it in updated_facts; if a known fact is now wrong, list its id in obsolete_ids. ' +
    'Never store passwords, API keys, or financial account numbers. Return empty arrays if nothing is worth remembering.'
  const user = `Known facts:\n${known || '(none)'}\n\nNew ${source === 'activity' ? 'activity summary' : 'conversation'}:\n${transcript.slice(-12000)}`
  const { data, usage } = await cheapJson<Extracted>(s.fastModel, system, user, EXTRACT_SCHEMA)
  recordUsage(s.fastModel, usage, 'memory')
  for (const f of data.new_facts) {
    if (f.text.trim()) memory.add({ text: f.text.trim(), category: f.category, importance: f.importance, source })
  }
  for (const u of data.updated_facts) if (memory.all().some((f) => f.id === u.id)) memory.update(u.id, { text: u.text })
  for (const id of data.obsolete_ids) memory.remove(id)
  return data
}

/** Once a day, turn yesterday's app usage into a few memory facts (opt-in). */
export async function learnFromActivity(): Promise<void> {
  const s = getSettings()
  if (!s.trackActivity) return
  const yesterday = dayKey(Date.now() - 86400_000)
  if (kv.get('activityLearnedFor', '') === yesterday) return
  const day = activity.all()[yesterday]
  kv.set('activityLearnedFor', yesterday)
  if (!day) return
  const top = Object.entries(day)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([app, min]) => `${app}: ${Math.round(min)} min`)
    .join('\n')
  await learnFromConversation(`App/window usage on ${yesterday} (${new Date(yesterday).toDateString()}):\n${top}`, 'activity')
}
