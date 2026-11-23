import type { UsageRecord, UsageSummary } from '@shared/types'
import { usage, getSettings } from '../store'
import { costOf, type UsageLike } from '../brain/pricing'

export const dayKey = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function recordUsage(model: string, u: UsageLike, purpose: UsageRecord['purpose']): number {
  const cost = costOf(model, u)
  usage.add({
    ts: Date.now(),
    model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: cost,
    purpose
  })
  return cost
}

export function spentToday(): number {
  const today = dayKey(Date.now())
  return usage
    .all()
    .filter((r) => dayKey(r.ts) === today)
    .reduce((s, r) => s + r.costUsd, 0)
}

export function overBudget(): boolean {
  const { dailyBudgetUsd } = getSettings()
  return dailyBudgetUsd > 0 && spentToday() >= dailyBudgetUsd
}

export function usageSummary(): UsageSummary {
  const all = usage.all()
  const now = new Date()
  const today = dayKey(now.getTime())
  const monthPrefix = today.slice(0, 7)
  const byModel = new Map<string, { usd: number; requests: number }>()
  let todayUsd = 0
  let monthUsd = 0
  let totalUsd = 0
  let todayRequests = 0
  let cacheRead = 0
  let promptTokens = 0
  for (const r of all) {
    const d = dayKey(r.ts)
    totalUsd += r.costUsd
    if (d === today) {
      todayUsd += r.costUsd
      todayRequests++
    }
    if (d.startsWith(monthPrefix)) monthUsd += r.costUsd
    const m = byModel.get(r.model) ?? { usd: 0, requests: 0 }
    m.usd += r.costUsd
    m.requests++
    byModel.set(r.model, m)
    cacheRead += r.cacheReadTokens
    promptTokens += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens
  }
  const last14Days: { day: string; usd: number }[] = []
  for (let i = 13; i >= 0; i--) {
    const d = dayKey(Date.now() - i * 86400_000)
    last14Days.push({ day: d, usd: all.filter((r) => dayKey(r.ts) === d).reduce((s, r) => s + r.costUsd, 0) })
  }
  return {
    todayUsd,
    monthUsd,
    totalUsd,
    todayRequests,
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.usd - a.usd),
    last14Days,
    cacheHitRate: promptTokens ? cacheRead / promptTokens : 0
  }
}
