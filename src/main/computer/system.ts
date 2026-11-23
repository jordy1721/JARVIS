// "Cheap" computer control: shell, apps, files, clipboard. These need no screenshots,
// so the assistant is told to prefer them over clicking around the screen.
import { clipboard, shell } from 'electron'
import { exec, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MAX_OUT = 6000

export function truncate(s: string, max = MAX_OUT): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return `${s.slice(0, half)}\n…[${s.length - max} characters truncated]…\n${s.slice(-half)}`
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

export function runShell(command: string, cwd?: string, timeoutSec = 60): Promise<string> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const opts = {
      cwd: cwd ? expandHome(cwd) : os.homedir(),
      timeout: Math.min(600, timeoutSec) * 1000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      shell: isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
    }
    exec(command, opts, (err, stdout, stderr) => {
      let out = ''
      if (stdout) out += stdout
      if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr
      if (err && (err as { killed?: boolean }).killed) out += '\n[timed out]'
      else if (err) out += `\n[exit code ${(err as { code?: number }).code ?? 1}]`
      resolve(truncate(out.trim() || '(no output)'))
    })
  })
}

export async function launchApp(name: string): Promise<string> {
  const p = process.platform
  if (p === 'darwin') {
    spawn('open', ['-a', name], { detached: true, stdio: 'ignore' }).unref()
  } else if (p === 'win32') {
    // `start` resolves Start-menu app names, executables on PATH, and URIs like ms-settings:
    spawn('cmd.exe', ['/c', 'start', '""', name], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } else {
    spawn(name, [], { detached: true, stdio: 'ignore', shell: true }).unref()
  }
  return `Launching ${name}`
}

export async function openTarget(target: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith('mailto:')) {
    await shell.openExternal(target)
    return `Opened ${target}`
  }
  const err = await shell.openPath(expandHome(target))
  return err ? `Error: ${err}` : `Opened ${target}`
}

export async function readFileTool(p: string, maxChars = 12000): Promise<string> {
  const full = expandHome(p)
  const stat = await fs.stat(full)
  if (stat.isDirectory()) return await listDirectory(p)
  if (stat.size > 5 * 1024 * 1024) return `File is ${(stat.size / 1e6).toFixed(1)} MB — too large to read.`
  return truncate(await fs.readFile(full, 'utf8'), maxChars)
}

export async function writeFileTool(p: string, content: string, append = false): Promise<string> {
  const full = expandHome(p)
  await fs.mkdir(path.dirname(full), { recursive: true })
  if (append) await fs.appendFile(full, content)
  else await fs.writeFile(full, content)
  return `${append ? 'Appended to' : 'Wrote'} ${full} (${content.length} chars)`
}

export async function listDirectory(p: string): Promise<string> {
  const full = expandHome(p || '~')
  const entries = await fs.readdir(full, { withFileTypes: true })
  const lines = entries
    .filter((e) => !e.name.startsWith('.'))
    .slice(0, 300)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  return `${full}\n${lines.join('\n')}${entries.length > 300 ? `\n…and ${entries.length - 300} more` : ''}`
}

export async function getClipboard(): Promise<string> {
  return truncate((await clipboard.readText()) || '(clipboard is empty)')
}
export async function setClipboard(text: string): Promise<string> {
  await clipboard.writeText(text)
  return 'Copied to clipboard'
}

export function systemInfo(): string {
  const mem = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`
  return [
    `OS: ${os.type()} ${os.release()} (${process.platform}/${os.arch()})`,
    `Host: ${os.hostname()}  User: ${os.userInfo().username}  Home: ${os.homedir()}`,
    `CPU: ${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}  Load: ${os.loadavg().map((l) => l.toFixed(2)).join(' ')}`,
    `Memory: ${mem(os.totalmem() - os.freemem())} used of ${mem(os.totalmem())}`,
    `Uptime: ${(os.uptime() / 3600).toFixed(1)} h`,
    `Local time: ${new Date().toString()}`
  ].join('\n')
}
