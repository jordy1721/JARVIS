// Types shared between the main process, preload and renderer.

export type VoiceMode = 'off' | 'push-to-talk' | 'open-mic'
export type Autonomy = 'ask-always' | 'ask-risky' | 'autonomous'
export type RoutingMode = 'auto' | 'fast' | 'smart'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Provider = 'subscription' | 'api'

export interface Settings {
  // How JARVIS reaches Claude: the user's Claude plan via Claude Code, or a pay-per-use API key
  provider: Provider
  claudePath: string
  subFastModel: string
  subSmartModel: string
  userName: string
  assistantName: string
  // Models
  fastModel: string
  smartModel: string
  routing: RoutingMode
  fastEffort: Effort
  smartEffort: Effort
  // Cost control
  dailyBudgetUsd: number
  maxToolStepsPerTurn: number
  sessionTokenLimit: number
  // Voice
  voiceMode: VoiceMode
  pushToTalkHotkey: string
  requireWakeWord: boolean
  wakeWord: string
  sttModel: string
  ttsEnabled: boolean
  speakAllReplies: boolean
  ttsEngine: 'neural' | 'system' | 'elevenlabs'
  neuralVoice: string
  ttsVoice: string
  ttsRate: number
  elevenLabsVoiceId: string
  // Computer control
  autonomy: Autonomy
  allowComputerControl: boolean
  allowShell: boolean
  allowWebSearch: boolean
  stopHotkey: string
  // Learning
  learnFromConversations: boolean
  trackActivity: boolean
  // Self modification
  allowSelfModification: boolean
  sourceDir: string
  // App
  launchAtLogin: boolean
  showHud: boolean
  theme: 'dark' | 'light'
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'subscription',
  claudePath: '',
  subFastModel: 'haiku',
  subSmartModel: 'sonnet',
  userName: '',
  assistantName: 'JARVIS',
  fastModel: 'claude-haiku-5-5',
  smartModel: 'claude-opus-5-5',
  routing: 'auto',
  fastEffort: 'low',
  smartEffort: 'medium',
  dailyBudgetUsd: 1,
  maxToolStepsPerTurn: 25,
  sessionTokenLimit: 40000,
  voiceMode: 'push-to-talk',
  pushToTalkHotkey: 'CommandOrControl+Shift+Space',
  requireWakeWord: true,
  wakeWord: 'jarvis',
  sttModel: 'onnx-community/whisper-base.en',
  ttsEnabled: true,
  speakAllReplies: false,
  ttsEngine: 'neural',
  neuralVoice: 'bm_george',
  ttsVoice: '',
  ttsRate: 1.05,
  elevenLabsVoiceId: '',
  autonomy: 'ask-risky',
  allowComputerControl: true,
  allowShell: true,
  allowWebSearch: false,
  stopHotkey: 'CommandOrControl+Shift+X',
  learnFromConversations: true,
  trackActivity: false,
  allowSelfModification: true,
  sourceDir: '',
  launchAtLogin: false,
  showHud: true,
  theme: 'dark'
}

export type AssistantState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'acting' | 'speaking'

export interface ChatEntry {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  ts: number
  model?: string
  costUsd?: number
  tool?: { name: string; input: unknown; ok?: boolean; output?: string }
}

export interface MemoryFact {
  id: string
  text: string
  category: 'identity' | 'preference' | 'work' | 'routine' | 'relationship' | 'goal' | 'skill' | 'other'
  importance: number // 1-5
  created: number
  updated: number
  uses: number
  source: 'conversation' | 'explicit' | 'activity'
}

export type TaskStatus = 'todo' | 'in-progress' | 'done'

export interface Task {
  id: string
  title: string
  notes: string
  status: TaskStatus
  priority: 'low' | 'medium' | 'high'
  due?: number // epoch ms
  remindAt?: number // epoch ms
  reminded?: boolean
  // Automation: a prompt JARVIS runs on a schedule
  automation?: {
    prompt: string
    schedule: { kind: 'once'; at: number } | { kind: 'daily'; time: string } | { kind: 'interval'; minutes: number }
    lastRun?: number
    enabled: boolean
  }
  created: number
  updated: number
}

export interface JournalEntry {
  id: string
  ts: number // when the conversation ended
  started: number
  summary: string
  topics: string[]
}

export interface ConnectionStatus {
  provider: Provider
  ready: boolean
  claudeInstalled: boolean
  claudeVersion: string | null
  claudePath: string | null
  hasApiKey: boolean
}

export interface SubscriptionLimits {
  status?: string
  seenAt: number
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }>
}

export interface UsageRecord {
  ts: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  purpose: 'chat' | 'memory' | 'automation' | 'summary'
  subscription?: boolean
}

export interface UsageSummary {
  todayUsd: number
  monthUsd: number
  totalUsd: number
  todayRequests: number
  byModel: { model: string; usd: number; requests: number }[]
  last14Days: { day: string; usd: number }[]
  cacheHitRate: number
  subscriptionRequestsToday: number
  subscriptionLimits: SubscriptionLimits | null
}

export interface ActionLogEntry {
  id: string
  ts: number
  tool: string
  summary: string
  status: 'approved' | 'auto' | 'denied' | 'error' | 'done'
  detail?: string
}

export interface FileEdit {
  path: string // relative to the source root
  // Either a full replacement or a targeted string replacement
  content?: string
  oldStr?: string
  newStr?: string
}

export interface CodeChange {
  id: string
  title: string
  description: string
  edits: FileEdit[]
  diff: string
  status: 'pending' | 'applied' | 'rejected' | 'failed' | 'reverted'
  created: number
  appliedAt?: number
  commit?: string
  error?: string
}

export interface ConfirmRequest {
  id: string
  title: string
  detail: string
  risk: 'low' | 'medium' | 'high'
}

// ---- Overlay guidance ----
export interface GuideStep {
  // Coordinates are in screenshot pixel space; the main process converts them.
  x: number
  y: number
  width?: number
  height?: number
  label: string
  kind: 'highlight' | 'click' | 'type' | 'arrow' | 'note'
}

export interface GuidePayload {
  title: string
  steps: (GuideStep & { width: number; height: number })[] // converted to overlay (DIP) coordinates
  current: number
}

export interface HudPayload {
  state: AssistantState
  caption?: string
  visible: boolean
}

export interface ActivitySummary {
  day: string
  apps: { name: string; minutes: number }[]
}

export interface DashboardData {
  usage: UsageSummary
  tasks: { open: number; dueToday: number; done: number; upcoming: Task[] }
  memoryCount: number
  journalCount: number
  recentActions: ActionLogEntry[]
  activity: ActivitySummary | null
  pendingChanges: number
  connection: ConnectionStatus
  computerControlAvailable: boolean
}
