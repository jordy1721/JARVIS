// Runs requests through the user's own installed Claude Code CLI, which they sign in to
// with their Claude subscription (Pro/Max) through Anthropic's own login flow.
// JARVIS never sees, stores or forwards any Claude credentials — it only launches the
// unmodified `claude` program, exactly like typing `claude -p` in a terminal.
import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getSettings, kv } from '../store'

let cachedPath: string | null | undefined

function candidates(): string[] {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(local, 'Programs', 'claude', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd')
    ]
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude')
  ]
}

function lookupOnPath(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('where', ['claude'], { windowsHide: true }, (err, out) => resolve(err ? null : out.split(/\r?\n/)[0]?.trim() || null))
    } else {
      // GUI apps on macOS don't inherit the shell PATH, so ask a login shell.
      const sh = process.env.SHELL || '/bin/bash'
      execFile(sh, ['-lc', 'command -v claude'], (err, out) => resolve(err ? null : out.trim() || null))
    }
  })
}

export async function findClaude(force = false): Promise<string | null> {
  if (!force && cachedPath !== undefined) return cachedPath
  const configured = getSettings().claudePath
  if (configured && fs.existsSync(configured)) return (cachedPath = configured)
  for (const c of candidates()) if (fs.existsSync(c)) return (cachedPath = c)
  cachedPath = await lookupOnPath()
  return cachedPath
}

export function claudeFoundSync(): boolean {
  return !!cachedPath
}

function workspace(): string {
  // An empty folder, so no project files or CLAUDE.md change JARVIS's behaviour.
  const d = path.join(app.getPath('userData'), 'claude-workspace')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MCP_TOOL_TIMEOUT: '600000', MCP_TIMEOUT: '30000' }
  // Make sure Claude Code uses the subscription login, not a stray API key.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function spawnClaude(bin: string, args: string[]): ChildProcess {
  // npm installs on Windows give a .cmd shim, which has to go through cmd.exe;
  // quote every argument so empty values and JSON survive. (The native installer gives an .exe.)
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
  if (needsShell) args = args.map((a) => `"${a.replace(/"/g, '\\"')}"`)
  return spawn(needsShell ? `"${bin}"` : bin, args, {
    cwd: workspace(),
    env: childEnv(),
    shell: needsShell,
    windowsHide: true
  })
}

export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined)
  else child.kill('SIGTERM')
}

export interface ClaudeResult {
  type: 'result'
  subtype: string
  is_error: boolean
  result?: string
  session_id: string
  total_cost_usd?: number
  structured_output?: unknown
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>
}

export interface RunOptions {
  prompt: string
  model: string
  systemPrompt?: string
  resume?: string
  mcpConfig?: object
  allowedTools?: string[]
  builtinTools?: string[] // Claude Code built-in tools to enable (default: none)
  jsonSchema?: object
  effort?: string
  maxTurns?: number
  signal?: AbortSignal
  onEvent?: (e: any) => void
}

/** Run one prompt through Claude Code in print mode. Resolves with the final result line. */
export async function runClaude(o: RunOptions): Promise<ClaudeResult> {
  const bin = await findClaude()
  if (!bin) throw new Error('Claude Code is not installed. Open Settings → Connection to install it and sign in.')
  const dir = workspace()
  const args = ['-p', '--model', o.model, '--setting-sources', '', '--permission-mode', 'dontAsk']
  args.push('--tools', (o.builtinTools ?? []).join(','))
  if (o.effort) args.push('--effort', o.effort)
  if (o.maxTurns) args.push('--max-turns', String(o.maxTurns))
  if (o.systemPrompt) {
    const f = path.join(dir, 'jarvis-system-prompt.md')
    fs.writeFileSync(f, o.systemPrompt)
    args.push('--system-prompt-file', f)
  }
  if (o.mcpConfig) {
    const f = path.join(dir, 'jarvis-mcp.json')
    fs.writeFileSync(f, JSON.stringify(o.mcpConfig))
    args.push('--mcp-config', f, '--strict-mcp-config')
  } else args.push('--strict-mcp-config')
  if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','))
  if (o.resume) args.push('--resume', o.resume)
  else if (!o.mcpConfig) args.push('--no-session-persistence')
  if (o.jsonSchema) args.push('--output-format', 'json', '--json-schema', JSON.stringify(o.jsonSchema))
  else args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages')

  const child = spawnClaude(bin, args)
  const onAbort = () => killTree(child)
  o.signal?.addEventListener('abort', onAbort)
  child.stdin?.end(o.prompt)

  return new Promise((resolve, reject) => {
    let buf = ''
    let stderr = ''
    let result: ClaudeResult | null = null
    let jsonOut = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (o.jsonSchema) {
        jsonOut += chunk
        return
      }
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let ev: any
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === 'result') result = ev
        else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) kv.set('subscriptionLimits', { ...ev.rate_limit_info, seenAt: Date.now() })
        o.onEvent?.(ev)
      }
    })
    child.stderr?.on('data', (d) => (stderr += String(d)))
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort)
      if (o.signal?.aborted) return reject(new Error('aborted'))
      if (o.jsonSchema) {
        try {
          result = JSON.parse(jsonOut)
        } catch {
          /* handled below */
        }
      }
      if (result) return resolve(result)
      reject(new Error(friendlyError(stderr || jsonOut || `Claude Code exited with code ${code}`)))
    })
  })
}

export function friendlyError(text: string): string {
  if (/log ?in|logged in|auth|credential|401/i.test(text))
    return 'Claude Code is not signed in. Open Settings → Connection and click "Sign in to Claude".'
  if (/rate.?limit|usage limit|limit reached|429/i.test(text))
    return 'You have reached your Claude plan usage limit for now. It resets automatically — check the reset time in Claude.'
  return text.trim().slice(0, 500)
}

/** Structured JSON answer through the subscription (used for memory extraction). */
export async function claudeJson<T>(model: string, system: string, user: string, schema: object): Promise<{ data: T; result: ClaudeResult }> {
  const result = await runClaude({ prompt: user, model, systemPrompt: system, jsonSchema: schema, effort: 'low' })
  if (result.is_error) throw new Error(friendlyError(result.result ?? 'error'))
  const data = (result.structured_output ?? JSON.parse(result.result ?? '{}')) as T
  return { data, result }
}

export async function claudeVersion(): Promise<string | null> {
  const bin = await findClaude(true)
  if (!bin) return null
  return new Promise((resolve) => {
    const child = spawnClaude(bin, ['--version'])
    let out = ''
    child.stdout?.on('data', (d) => (out += String(d)))
    child.on('close', () => resolve(out.trim() || 'unknown version'))
    child.on('error', () => resolve(null))
  })
}

export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await runClaude({ prompt: 'Reply with exactly the word: ONLINE', model: 'haiku', effort: 'low' })
    if (r.is_error) return { ok: false, detail: friendlyError(r.result ?? r.subtype) }
    return { ok: true, detail: `Connected — Claude replied "${(r.result ?? '').trim().slice(0, 40)}"` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

function openTerminal(command: string): void {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', command], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  } else if (process.platform === 'darwin') {
    const esc = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${esc}"`, '-e', 'tell application "Terminal" to activate'], {
      detached: true,
      stdio: 'ignore'
    }).unref()
  } else {
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']) {
      try {
        const args = term === 'gnome-terminal' ? ['--', 'bash', '-lc', `${command}; exec bash`] : ['-e', `bash -lc '${command}; exec bash'`]
        spawn(term, args, { detached: true, stdio: 'ignore' }).unref()
        return
      } catch {
        /* try the next one */
      }
    }
  }
}

/** Opens a terminal running Claude Code so the user signs in through Anthropic's own login. */
export async function openSignIn(): Promise<boolean> {
  const bin = await findClaude(true)
  if (!bin) return false
  openTerminal(process.platform === 'win32' ? `& '${bin}'` : `'${bin}'`)
  return true
}

/** Opens a terminal running Anthropic's official Claude Code installer. */
export function openInstaller(): void {
  openTerminal(
    process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'
  )
}
