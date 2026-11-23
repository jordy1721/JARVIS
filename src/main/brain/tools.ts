// Tool definitions and their executors.
import type Anthropic from '@anthropic-ai/sdk'
import type { GuideStep, Settings, Task } from '@shared/types'
import { memory, tasks, updateSettings } from '../store'
import { recallConversations } from './memory'
import * as sys from '../computer/system'
import { listSourceFiles, proposeChange, readSourceFile } from '../selfmod/selfmod'
import { supportsWebSearch } from './pricing'

type Tool = Anthropic.Beta.Messages.BetaToolUnion
type Schema = { type: 'object'; properties: Record<string, any>; required?: string[] }

interface CustomTool {
  name: string
  description: string
  input_schema: Schema
  risk: 'none' | 'medium' | 'high'
}

const str = (description: string) => ({ type: 'string', description })

export const CUSTOM_TOOLS: CustomTool[] = [
  {
    name: 'run_shell',
    description:
      'Run a shell command on the user\'s computer (PowerShell on Windows, the login shell on macOS/Linux) and return its output. Prefer this over GUI clicking whenever a command can do the job.',
    input_schema: {
      type: 'object',
      properties: {
        command: str('The command to run'),
        cwd: str('Working directory (default: home folder)'),
        timeout_sec: { type: 'integer', description: 'Timeout in seconds (default 60, max 600)' }
      },
      required: ['command']
    },
    risk: 'high'
  },
  {
    name: 'launch_app',
    description: 'Launch an application by name (e.g. "Spotify", "Visual Studio Code", "calc", "ms-settings:display").',
    input_schema: { type: 'object', properties: { name: str('Application name or launch URI') }, required: ['name'] },
    risk: 'medium'
  },
  {
    name: 'open',
    description: 'Open a URL in the default browser, or a file/folder with its default app.',
    input_schema: { type: 'object', properties: { target: str('URL, file path or folder path (~ allowed)') }, required: ['target'] },
    risk: 'none'
  },
  {
    name: 'read_file',
    description: 'Read a text file (or list a folder). Output is truncated for very large files.',
    input_schema: { type: 'object', properties: { path: str('File path (~ allowed)') }, required: ['path'] },
    risk: 'none'
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file, or append to it.',
    input_schema: {
      type: 'object',
      properties: { path: str('File path (~ allowed)'), content: str('Text content'), append: { type: 'boolean' } },
      required: ['path', 'content']
    },
    risk: 'medium'
  },
  {
    name: 'list_directory',
    description: 'List the files in a folder.',
    input_schema: { type: 'object', properties: { path: str('Folder path (~ allowed)') }, required: ['path'] },
    risk: 'none'
  },
  {
    name: 'clipboard',
    description: 'Read or set the clipboard text.',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['get', 'set'] }, text: str('Text to copy when action is set') },
      required: ['action']
    },
    risk: 'none'
  },
  {
    name: 'system_info',
    description: 'Get OS, hardware, memory, uptime and the local date/time.',
    input_schema: { type: 'object', properties: {} },
    risk: 'none'
  },
  {
    name: 'remember',
    description: 'Save a durable fact about the user to long-term memory (preferences, people, routines, goals). Use when the user tells you something worth remembering.',
    input_schema: {
      type: 'object',
      properties: {
        fact: str('Short third-person sentence, e.g. "Prefers metric units"'),
        category: { type: 'string', enum: ['identity', 'preference', 'work', 'routine', 'relationship', 'goal', 'skill', 'other'] },
        importance: { type: 'integer', enum: [1, 2, 3, 4, 5] }
      },
      required: ['fact', 'category', 'importance']
    },
    risk: 'none'
  },
  {
    name: 'forget',
    description: 'Delete a memory by its id (ids are shown in brackets in your memory list).',
    input_schema: { type: 'object', properties: { id: str('Memory id') }, required: ['id'] },
    risk: 'none'
  },
  {
    name: 'search_memory',
    description: 'Search everything you remember about the user.',
    input_schema: { type: 'object', properties: { query: str('Keywords') }, required: ['query'] },
    risk: 'none'
  },
  {
    name: 'recall_conversations',
    description:
      'Search your memory of past conversations with the user (summaries of earlier conversations and the message history). Use when the user refers to something discussed before ("like we talked about", "what did I say about…", "last week").',
    input_schema: { type: 'object', properties: { query: str('Keywords to search for') }, required: ['query'] },
    risk: 'none'
  },
  {
    name: 'create_task',
    description:
      'Add a task/to-do, optionally with a due date, a reminder, or an automation (a prompt you will run on a schedule, e.g. "every day at 08:00 summarise my calendar").',
    input_schema: {
      type: 'object',
      properties: {
        title: str('Task title'),
        notes: str('Details'),
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        due: str('Due date/time, ISO 8601 local time (e.g. 2026-11-24T17:00)'),
        remind_at: str('When to remind the user, ISO 8601 local time'),
        automation_prompt: str('Instruction to run automatically on the schedule'),
        schedule: str('For automations: "once:<ISO time>", "daily:HH:MM" or "every:<minutes>"')
      },
      required: ['title']
    },
    risk: 'none'
  },
  {
    name: 'list_tasks',
    description: 'List the user\'s tasks.',
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['todo', 'in-progress', 'done', 'all'] } } },
    risk: 'none'
  },
  {
    name: 'update_task',
    description: 'Update a task (status, title, notes, priority, due date).',
    input_schema: {
      type: 'object',
      properties: {
        id: str('Task id'),
        status: { type: 'string', enum: ['todo', 'in-progress', 'done'] },
        title: str('New title'),
        notes: str('New notes'),
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        due: str('ISO 8601 due date'),
        delete: { type: 'boolean', description: 'Delete the task instead' }
      },
      required: ['id']
    },
    risk: 'none'
  },
  {
    name: 'show_guide',
    description:
      'TEACH MODE: draw on-screen guidance over the user\'s screen instead of doing the task for them. Take a screenshot first; coordinates are in that screenshot\'s pixel space. Give 1–6 steps for what is visible now; the user presses "Next" on the overlay and you will be asked for further steps after the screen changes.',
    input_schema: {
      type: 'object',
      properties: {
        title: str('What the user is learning, e.g. "Changing your display resolution"'),
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'Center x (or left edge when width is given)' },
              y: { type: 'number', description: 'Center y (or top edge when height is given)' },
              width: { type: 'number' },
              height: { type: 'number' },
              label: str('Instruction shown next to the element, e.g. "Click Settings"'),
              kind: { type: 'string', enum: ['highlight', 'click', 'type', 'arrow', 'note'] }
            },
            required: ['x', 'y', 'label', 'kind']
          }
        }
      },
      required: ['title', 'steps']
    },
    risk: 'none'
  },
  {
    name: 'clear_guide',
    description: 'Remove any on-screen guidance.',
    input_schema: { type: 'object', properties: {} },
    risk: 'none'
  },
  {
    name: 'escalate',
    description:
      'Hand this request to the smarter (more expensive) model. Use ONLY for hard multi-step reasoning, writing/modifying code, long computer-control tasks that are going wrong, or when you are unsure. Do not use for simple requests.',
    input_schema: { type: 'object', properties: { reason: str('Why the smart model is needed') }, required: ['reason'] },
    risk: 'none'
  },
  {
    name: 'update_settings',
    description: 'Change one of your own settings when the user asks (voice, speaking rate, name, theme, wake word, hud).',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['userName', 'ttsRate', 'ttsVoice', 'voiceMode', 'requireWakeWord', 'wakeWord', 'theme', 'showHud', 'ttsEnabled'] },
        value: str('New value (numbers and booleans as text, e.g. "1.2", "true")')
      },
      required: ['key', 'value']
    },
    risk: 'none'
  },
  {
    name: 'list_source_files',
    description: 'SELF-MODIFICATION: list the files of your own source code.',
    input_schema: { type: 'object', properties: {} },
    risk: 'none'
  },
  {
    name: 'read_source_file',
    description: 'SELF-MODIFICATION: read one of your own source files (with line numbers). Read before proposing edits.',
    input_schema: {
      type: 'object',
      properties: { path: str('Path relative to the project root, e.g. src/main/brain/agent.ts'), start_line: { type: 'integer' }, end_line: { type: 'integer' } },
      required: ['path']
    },
    risk: 'none'
  },
  {
    name: 'propose_code_change',
    description:
      'SELF-MODIFICATION: propose a change to your own source code. The change is NOT applied — the user reviews the diff in Code Lab and approves or rejects it. Prefer small targeted edits (old_str must match the file exactly once); use content only for new files.',
    input_schema: {
      type: 'object',
      properties: {
        title: str('Short summary of the change'),
        description: str('What it does and why, plus anything the user must do after (e.g. restart)'),
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: str('File path relative to the project root'),
              old_str: str('Exact text to replace'),
              new_str: str('Replacement text'),
              content: str('Full file content (new files only)')
            },
            required: ['path']
          }
        }
      },
      required: ['title', 'description', 'edits']
    },
    risk: 'none'
  }
]

const SELF_MOD_TOOLS = new Set(['list_source_files', 'read_source_file', 'propose_code_change'])

export function buildTools(settings: Settings, model: string, isFastModel: boolean): Tool[] {
  const tools: Tool[] = CUSTOM_TOOLS.filter((t) => {
    if (t.name === 'run_shell' && !settings.allowShell) return false
    if (SELF_MOD_TOOLS.has(t.name) && !settings.allowSelfModification) return false
    if (t.name === 'escalate' && (!isFastModel || settings.routing !== 'auto')) return false
    return true
  }).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    eager_input_streaming: true
  }))
  if (settings.allowComputerControl) {
    tools.push({ type: 'computer_toolset_20260801' } as Tool)
  }
  if (settings.allowWebSearch && supportsWebSearch(model)) {
    tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 } as Tool)
  }
  // Cache breakpoint on the last tool so the (large, stable) tool list is cached.
  const last = tools[tools.length - 1] as { cache_control?: unknown }
  last.cache_control = { type: 'ephemeral' }
  return tools
}

export function toolRisk(name: string, isComputer: boolean): 'none' | 'medium' | 'high' {
  if (isComputer) {
    return ['screenshot', 'zoom', 'cursor_position', 'wait', 'mouse_move'].includes(name) ? 'none' : 'medium'
  }
  return CUSTOM_TOOLS.find((t) => t.name === name)?.risk ?? 'none'
}

/** Minimal validation for streamed tool inputs (eager streaming skips server-side validation). */
export function validateInput(name: string, input: unknown): string | null {
  const def = CUSTOM_TOOLS.find((t) => t.name === name)
  if (!def) return null
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Input must be an object'
  const obj = input as Record<string, unknown>
  for (const req of def.input_schema.required ?? []) {
    if (obj[req] === undefined || obj[req] === null) return `Missing required field "${req}"`
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = def.input_schema.properties[k]
    if (!p || v === undefined || v === null) continue
    const t = p.type
    const ok =
      (t === 'string' && typeof v === 'string') ||
      ((t === 'integer' || t === 'number') && typeof v === 'number') ||
      (t === 'boolean' && typeof v === 'boolean') ||
      (t === 'array' && Array.isArray(v)) ||
      (t === 'object' && typeof v === 'object')
    if (!ok) return `Field "${k}" should be ${t}`
  }
  return null
}

export function describeAction(name: string, input: Record<string, any>): string {
  switch (name) {
    case 'run_shell':
      return `Run command: ${input.command}${input.cwd ? `  (in ${input.cwd})` : ''}`
    case 'write_file':
      return `${input.append ? 'Append to' : 'Write'} file: ${input.path}\n\n${String(input.content).slice(0, 600)}`
    case 'launch_app':
      return `Launch app: ${input.name}`
    case 'type':
      return `Type text: "${String(input.text).slice(0, 200)}"`
    case 'key':
      return `Press keys: ${input.text}${input.repeat > 1 ? ` ×${input.repeat}` : ''}`
    default:
      if (input.coordinate) return `${name.replace(/_/g, ' ')} at (${input.coordinate.join(', ')})`
      return `${name} ${JSON.stringify(input).slice(0, 300)}`
  }
}

function parseLocalDate(s?: string): number | undefined {
  if (!s) return undefined
  const t = Date.parse(s)
  return isNaN(t) ? undefined : t
}

function parseSchedule(s?: string, prompt?: string): Task['automation'] | undefined {
  if (!prompt) return undefined
  const spec = s || ''
  let schedule: NonNullable<Task['automation']>['schedule'] | undefined
  if (spec.startsWith('daily:')) schedule = { kind: 'daily', time: spec.slice(6) }
  else if (spec.startsWith('every:')) schedule = { kind: 'interval', minutes: Math.max(15, Number(spec.slice(6)) || 60) }
  else if (spec.startsWith('once:')) schedule = { kind: 'once', at: parseLocalDate(spec.slice(5)) ?? Date.now() + 60_000 }
  if (!schedule) schedule = { kind: 'once', at: Date.now() + 60_000 }
  return { prompt, schedule, enabled: true }
}

export interface ToolHooks {
  showGuide(title: string, steps: GuideStep[]): void
  clearGuide(): void
  onSettingsChanged(): void
  onChangeProposed(id: string): void
  onTasksChanged(): void
}

/** Execute a custom (non-computer) tool. Returns text for the tool_result. */
export async function runCustomTool(name: string, input: Record<string, any>, hooks: ToolHooks): Promise<string> {
  switch (name) {
    case 'run_shell':
      return sys.runShell(input.command, input.cwd, input.timeout_sec ?? 60)
    case 'launch_app':
      return sys.launchApp(input.name)
    case 'open':
      return sys.openTarget(input.target)
    case 'read_file':
      return sys.readFileTool(input.path)
    case 'write_file':
      return sys.writeFileTool(input.path, input.content, !!input.append)
    case 'list_directory':
      return sys.listDirectory(input.path)
    case 'clipboard':
      return input.action === 'set' ? sys.setClipboard(input.text ?? '') : sys.getClipboard()
    case 'system_info':
      return sys.systemInfo()
    case 'remember': {
      const f = memory.add({ text: input.fact, category: input.category, importance: input.importance, source: 'explicit' })
      return `Remembered [${f.id}]`
    }
    case 'forget':
      memory.remove(input.id)
      return 'Forgotten'
    case 'search_memory': {
      const q = String(input.query).toLowerCase().split(/\s+/)
      const hits = memory.all().filter((f) => q.some((w) => f.text.toLowerCase().includes(w)))
      return hits.length ? hits.map((f) => `[${f.id}] ${f.text}`).join('\n') : 'Nothing found'
    }
    case 'recall_conversations':
      return recallConversations(String(input.query))
    case 'create_task': {
      const t = tasks.add({
        title: input.title,
        notes: input.notes ?? '',
        priority: input.priority ?? 'medium',
        due: parseLocalDate(input.due),
        remindAt: parseLocalDate(input.remind_at),
        automation: parseSchedule(input.schedule, input.automation_prompt)
      })
      hooks.onTasksChanged()
      return `Created task [${t.id}] "${t.title}"`
    }
    case 'list_tasks': {
      const status = input.status ?? 'all'
      const list = tasks.all().filter((t) => (status === 'all' ? t.status !== 'done' : t.status === status))
      if (!list.length) return 'No tasks'
      return list
        .map(
          (t) =>
            `[${t.id}] ${t.title} — ${t.status}, ${t.priority}${t.due ? `, due ${new Date(t.due).toLocaleString()}` : ''}${t.automation ? ' (automation)' : ''}`
        )
        .join('\n')
    }
    case 'update_task': {
      if (input.delete) {
        tasks.remove(input.id)
        hooks.onTasksChanged()
        return 'Deleted'
      }
      const patch: Partial<Task> = {}
      for (const k of ['status', 'title', 'notes', 'priority'] as const) if (input[k] !== undefined) (patch as any)[k] = input[k]
      if (input.due) patch.due = parseLocalDate(input.due)
      const t = tasks.update(input.id, patch)
      hooks.onTasksChanged()
      return t ? `Updated "${t.title}"` : 'Task not found'
    }
    case 'show_guide':
      hooks.showGuide(input.title, input.steps)
      return 'Guide is now displayed on the user\'s screen. Briefly tell them what to do first.'
    case 'clear_guide':
      hooks.clearGuide()
      return 'Cleared'
    case 'update_settings': {
      let value: unknown = input.value
      if (value === 'true' || value === 'false') value = value === 'true'
      else if (input.key === 'ttsRate') value = Math.min(2, Math.max(0.5, Number(value) || 1))
      updateSettings({ [input.key]: value } as Partial<Settings>)
      hooks.onSettingsChanged()
      return `Set ${input.key} = ${String(value)}`
    }
    case 'list_source_files':
      return listSourceFiles()
    case 'read_source_file':
      return sys.truncate(readSourceFile(input.path, input.start_line, input.end_line), 30000)
    case 'propose_code_change': {
      const change = proposeChange(
        input.title,
        input.description,
        (input.edits as any[]).map((e) => ({ path: e.path, content: e.content, oldStr: e.old_str, newStr: e.new_str }))
      )
      hooks.onChangeProposed(change.id)
      return `Proposed change ${change.id} is waiting for the user's approval in Code Lab. Tell them to review it; do not claim it is applied.`
    }
    default:
      throw new Error(`Unknown tool ${name}`)
  }
}
