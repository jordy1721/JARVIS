// Local JSON persistence. Everything JARVIS knows lives in the user's app-data folder,
// never on a server. The API key is encrypted with the OS keychain via safeStorage.
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_SETTINGS,
  type ActionLogEntry,
  type ChatEntry,
  type CodeChange,
  type JournalEntry,
  type MemoryFact,
  type Settings,
  type Task,
  type UsageRecord
} from '@shared/types'

const dir = () => {
  const d = path.join(app.getPath('userData'), 'jarvis-data')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8')) as T
  } catch {
    return fallback
  }
}

const pendingWrites = new Map<string, NodeJS.Timeout>()
function writeJson(name: string, value: unknown, immediate = false): void {
  const file = path.join(dir(), name)
  const doWrite = () => {
    pendingWrites.delete(name)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
  }
  const existing = pendingWrites.get(name)
  if (existing) clearTimeout(existing)
  if (immediate) doWrite()
  else pendingWrites.set(name, setTimeout(doWrite, 250))
}

export function flushStore(): void {
  for (const [name, t] of pendingWrites) {
    clearTimeout(t)
    pendingWrites.delete(name)
    const value = cache[name as keyof typeof cache]
    if (value !== undefined) writeJson(name, value, true)
  }
}

export const newId = () => randomUUID().slice(0, 12)

// In-memory cache keyed by file name
const cache: Record<string, unknown> = {}
function collection<T>(name: string, fallback: T) {
  return {
    get(): T {
      if (!(name in cache)) cache[name] = readJson<T>(name, fallback)
      return cache[name] as T
    },
    set(value: T): void {
      cache[name] = value
      writeJson(name, value)
    }
  }
}

// ---------- Settings ----------
const settingsCol = collection<Partial<Settings>>('settings.json', {})
export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...settingsCol.get() }
}
export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  settingsCol.set(next)
  return next
}

// ---------- API keys (encrypted) ----------
function secretPath(name: string) {
  return path.join(dir(), `${name}.bin`)
}
export function setSecret(name: string, value: string): void {
  const p = secretPath(name)
  if (!value) {
    fs.rmSync(p, { force: true })
    return
  }
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value)
    : Buffer.from('plain:' + value, 'utf8')
  fs.writeFileSync(p, data)
}
export function getSecret(name: string): string {
  try {
    const buf = fs.readFileSync(secretPath(name))
    const asText = buf.toString('utf8')
    if (asText.startsWith('plain:')) return asText.slice(6)
    return safeStorage.decryptString(buf)
  } catch {
    return ''
  }
}

// ---------- Chat transcript (UI history) ----------
const chatCol = collection<ChatEntry[]>('chat.json', [])
export const chat = {
  all: () => chatCol.get(),
  add(entry: Omit<ChatEntry, 'id' | 'ts'> & Partial<Pick<ChatEntry, 'id' | 'ts'>>): ChatEntry {
    const e: ChatEntry = { id: newId(), ts: Date.now(), ...entry }
    const list = chatCol.get()
    list.push(e)
    if (list.length > 600) list.splice(0, list.length - 600)
    chatCol.set(list)
    return e
  },
  clear: () => chatCol.set([])
}

// ---------- Memory ----------
const memoryCol = collection<MemoryFact[]>('memory.json', [])
export const memory = {
  all: () => memoryCol.get(),
  set: (facts: MemoryFact[]) => memoryCol.set(facts),
  add(fact: Omit<MemoryFact, 'id' | 'created' | 'updated' | 'uses'>): MemoryFact {
    const f: MemoryFact = { ...fact, id: newId(), created: Date.now(), updated: Date.now(), uses: 0 }
    memoryCol.set([...memoryCol.get(), f])
    return f
  },
  update(id: string, patch: Partial<MemoryFact>): void {
    memoryCol.set(memoryCol.get().map((f) => (f.id === id ? { ...f, ...patch, updated: Date.now() } : f)))
  },
  remove(id: string): void {
    memoryCol.set(memoryCol.get().filter((f) => f.id !== id))
  }
}

// ---------- Conversation journal (episodic memory) ----------
const journalCol = collection<JournalEntry[]>('journal.json', [])
export const journal = {
  all: () => journalCol.get(),
  add(e: Omit<JournalEntry, 'id'>): JournalEntry {
    const entry = { ...e, id: newId() }
    const list = journalCol.get()
    list.push(entry)
    if (list.length > 2000) list.splice(0, list.length - 2000)
    journalCol.set(list)
    return entry
  },
  remove(id: string): void {
    journalCol.set(journalCol.get().filter((e) => e.id !== id))
  },
  clear: () => journalCol.set([])
}

// ---------- Tasks ----------
const tasksCol = collection<Task[]>('tasks.json', [])
export const tasks = {
  all: () => tasksCol.get(),
  get: (id: string) => tasksCol.get().find((t) => t.id === id),
  add(t: Partial<Task> & { title: string }): Task {
    const task: Task = {
      notes: '',
      status: 'todo',
      priority: 'medium',
      ...t,
      id: newId(),
      created: Date.now(),
      updated: Date.now()
    }
    tasksCol.set([...tasksCol.get(), task])
    return task
  },
  update(id: string, patch: Partial<Task>): Task | undefined {
    let out: Task | undefined
    tasksCol.set(
      tasksCol.get().map((t) => {
        if (t.id !== id) return t
        out = { ...t, ...patch, updated: Date.now() }
        return out
      })
    )
    return out
  },
  remove(id: string): void {
    tasksCol.set(tasksCol.get().filter((t) => t.id !== id))
  }
}

// ---------- Usage ----------
const usageCol = collection<UsageRecord[]>('usage.json', [])
export const usage = {
  all: () => usageCol.get(),
  add(r: UsageRecord): void {
    const list = usageCol.get()
    list.push(r)
    // keep ~90 days of detail
    const cutoff = Date.now() - 90 * 86400_000
    const trimmed = list.filter((x) => x.ts >= cutoff)
    usageCol.set(trimmed)
  }
}

// ---------- Action log ----------
const actionsCol = collection<ActionLogEntry[]>('actions.json', [])
export const actions = {
  all: () => actionsCol.get(),
  add(a: Omit<ActionLogEntry, 'id' | 'ts'>): ActionLogEntry {
    const e = { ...a, id: newId(), ts: Date.now() }
    const list = actionsCol.get()
    list.push(e)
    if (list.length > 1000) list.splice(0, list.length - 1000)
    actionsCol.set(list)
    return e
  }
}

// ---------- Code changes ----------
const changesCol = collection<CodeChange[]>('code-changes.json', [])
export const codeChanges = {
  all: () => changesCol.get(),
  get: (id: string) => changesCol.get().find((c) => c.id === id),
  add(c: CodeChange): void {
    changesCol.set([...changesCol.get(), c])
  },
  update(id: string, patch: Partial<CodeChange>): void {
    changesCol.set(changesCol.get().map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }
}

// ---------- Activity (app usage minutes per day) ----------
type ActivityDb = Record<string, Record<string, number>> // day -> app -> minutes
const activityCol = collection<ActivityDb>('activity.json', {})
export const activity = {
  all: () => activityCol.get(),
  bump(day: string, appName: string, minutes: number): void {
    const db = activityCol.get()
    db[day] = db[day] || {}
    db[day][appName] = (db[day][appName] || 0) + minutes
    // keep 30 days
    const days = Object.keys(db).sort()
    while (days.length > 30) delete db[days.shift()!]
    activityCol.set(db)
  }
}

// ---------- Small key/value state ----------
const stateCol = collection<Record<string, unknown>>('state.json', {})
export const kv = {
  get<T>(key: string, fallback: T): T {
    const v = stateCol.get()[key]
    return v === undefined ? fallback : (v as T)
  },
  set(key: string, value: unknown): void {
    stateCol.set({ ...stateCol.get(), [key]: value })
  }
}
