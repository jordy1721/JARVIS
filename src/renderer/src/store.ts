// Tiny global store for the renderer (no extra dependencies).
import { useSyncExternalStore } from 'react'
import type { AssistantState, ChatEntry, ConfirmRequest, Settings } from '@shared/types'

export type Page = 'dashboard' | 'assistant' | 'tasks' | 'memory' | 'code' | 'log' | 'settings'

export interface AppState {
  page: Page
  settings: Settings | null
  chat: ChatEntry[]
  live: { id: string; text: string } | null
  state: AssistantState
  caption: string
  confirms: ConfirmRequest[]
  toasts: { id: number; text: string }[]
  modelProgress: string | null
  level: number
  sttStatus: { state: 'idle' | 'loading' | 'ready' | 'error'; detail: string }
}

let state: AppState = {
  page: 'dashboard',
  settings: null,
  chat: [],
  live: null,
  state: 'idle',
  caption: '',
  confirms: [],
  toasts: [],
  modelProgress: null,
  level: 0,
  sttStatus: { state: 'idle', detail: 'Voice input is off' }
}
const subs = new Set<() => void>()

export function getState() {
  return state
}
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  subs.forEach((f) => f())
}
export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => sel(state)
  )
}

let toastId = 0
export function toast(text: string) {
  const id = ++toastId
  setState((s) => ({ toasts: [...s.toasts, { id, text }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4500)
}

export const api = window.jarvis
