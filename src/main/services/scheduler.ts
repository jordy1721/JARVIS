// Reminders and scheduled automations. Checks every 30 seconds.
import { Notification } from 'electron'
import { tasks, getSettings, activity } from '../store'
import type { Task } from '@shared/types'
import { activeWindowTitle } from '../computer/control'
import { dayKey } from './usage'
import { learnFromActivity } from '../brain/memory'

export interface SchedulerHooks {
  remind(task: Task): void
  runAutomation(task: Task): void
}

function automationDue(t: Task, now: number): boolean {
  const a = t.automation
  if (!a?.enabled) return false
  // New automations don't fire for a slot that passed before they were created.
  const last = a.lastRun ?? t.created
  switch (a.schedule.kind) {
    case 'once':
      return !a.lastRun && now >= a.schedule.at
    case 'interval':
      return now - last >= a.schedule.minutes * 60_000
    case 'daily': {
      const [hh, mm] = a.schedule.time.split(':').map(Number)
      const target = new Date()
      target.setHours(hh || 0, mm || 0, 0, 0)
      return now >= target.getTime() && last < target.getTime()
    }
  }
}

export function startScheduler(hooks: SchedulerHooks): void {
  const tick = () => {
    const now = Date.now()
    for (const t of tasks.all()) {
      if (t.remindAt && !t.reminded && now >= t.remindAt && t.status !== 'done') {
        tasks.update(t.id, { reminded: true })
        new Notification({ title: 'Reminder', body: t.title }).show()
        hooks.remind(t)
      }
      if (automationDue(t, now)) {
        tasks.update(t.id, { automation: { ...t.automation!, lastRun: now, enabled: t.automation!.schedule.kind !== 'once' } })
        hooks.runAutomation(t)
      }
    }
  }
  setInterval(tick, 30_000)
  setTimeout(tick, 5_000)
}

/** Opt-in: sample the focused window once a minute to learn what the user works on. */
export function startActivityTracker(): void {
  setInterval(async () => {
    if (!getSettings().trackActivity) return
    const title = await activeWindowTitle()
    if (!title) return
    // Most window titles end with " - AppName"; keep the app part to avoid storing document names.
    const parts = title.split(/ [-–—|] /)
    const app = (parts.length > 1 ? parts[parts.length - 1] : title).slice(0, 60).trim()
    activity.bump(dayKey(Date.now()), app, 1)
  }, 60_000)
  // Turn yesterday's activity into memory once a day.
  setInterval(() => learnFromActivity().catch(() => undefined), 60 * 60_000)
  setTimeout(() => learnFromActivity().catch(() => undefined), 60_000)
}
