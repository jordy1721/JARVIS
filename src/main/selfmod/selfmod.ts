// Self-modification: JARVIS can read its own source and *propose* changes.
// Nothing is written until the user approves the diff in the Code Lab page.
// Every applied change is a git commit, so any change can be reverted with one click.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { CodeChange, FileEdit } from '@shared/types'
import { codeChanges, getSettings, newId } from '../store'

const BLOCKED = /(^|[\\/])(node_modules|\.git|out|release|dist)([\\/]|$)/
const ALLOWED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|html|json|md|yml|yaml|txt|svg)$/i

export function sourceRoot(): string | null {
  const configured = getSettings().sourceDir
  const candidates = [configured, app.getAppPath(), process.cwd()].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'src', 'main')) && fs.existsSync(path.join(c, 'package.json'))) return c
  }
  return null
}

function requireRoot(): string {
  const root = sourceRoot()
  if (!root)
    throw new Error(
      'JARVIS source code was not found. Self-modification works when running from a source checkout (npm run dev / npm start), or set "Source folder" in Settings.'
    )
  return root
}

function safePath(root: string, rel: string): string {
  const full = path.resolve(root, rel)
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path escapes the project: ${rel}`)
  if (BLOCKED.test(path.relative(root, full))) throw new Error(`Editing ${rel} is not allowed`)
  if (!ALLOWED_EXT.test(full)) throw new Error(`File type not editable: ${rel}`)
  return full
}

export function listSourceFiles(): string {
  const root = requireRoot()
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      const rel = path.relative(root, full)
      if (BLOCKED.test(rel) || e.name.startsWith('.')) continue
      if (e.isDirectory()) walk(full)
      else if (ALLOWED_EXT.test(e.name) && e.name !== 'package-lock.json') {
        const lines = fs.readFileSync(full, 'utf8').split('\n').length
        out.push(`${rel.replace(/\\/g, '/')} (${lines} lines)`)
      }
    }
  }
  walk(root)
  return out.join('\n')
}

export function readSourceFile(rel: string, startLine?: number, endLine?: number): string {
  const full = safePath(requireRoot(), rel)
  const lines = fs.readFileSync(full, 'utf8').split('\n')
  const s = Math.max(1, startLine ?? 1)
  const e = Math.min(lines.length, endLine ?? lines.length)
  return lines
    .slice(s - 1, e)
    .map((l, i) => `${String(s + i).padStart(4)}| ${l}`)
    .join('\n')
}

/** Apply edits in memory; returns new contents per file or throws with a precise reason. */
function computeEdits(root: string, edits: FileEdit[]): Map<string, { before: string; after: string }> {
  const files = new Map<string, { before: string; after: string }>()
  for (const e of edits) {
    const full = safePath(root, e.path)
    const prev = files.get(full)
    const before = prev?.before ?? (fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '')
    let current = prev?.after ?? before
    if (typeof e.content === 'string') {
      current = e.content
    } else if (typeof e.oldStr === 'string' && typeof e.newStr === 'string') {
      const count = current.split(e.oldStr).length - 1
      if (count === 0) throw new Error(`In ${e.path}: old_str not found. Re-read the file and copy the text exactly.`)
      if (count > 1) throw new Error(`In ${e.path}: old_str occurs ${count} times; include more surrounding context.`)
      current = current.replace(e.oldStr, () => e.newStr!)
    } else {
      throw new Error(`Edit for ${e.path} needs either "content" or both "old_str" and "new_str".`)
    }
    files.set(full, { before, after: current })
  }
  return files
}

export function proposeChange(title: string, description: string, edits: FileEdit[]): CodeChange {
  const root = requireRoot()
  const files = computeEdits(root, edits)
  const diff = [...files.entries()]
    .map(([full, { before, after }]) => {
      const rel = path.relative(root, full).replace(/\\/g, '/')
      return createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, '', '', { context: 3 })
    })
    .join('\n')
  const change: CodeChange = {
    id: newId(),
    title,
    description,
    edits,
    diff,
    status: 'pending',
    created: Date.now()
  }
  codeChanges.add(change)
  return change
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout.trim())
    })
  })
}

async function ensureRepo(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

export async function applyChange(id: string): Promise<CodeChange> {
  const change = codeChanges.get(id)
  if (!change || change.status !== 'pending') throw new Error('Change not found or not pending')
  const root = requireRoot()
  try {
    const files = computeEdits(root, change.edits)
    for (const [full, { after }] of files) {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, after)
    }
    let commit: string | undefined
    if (await ensureRepo(root)) {
      const rels = [...files.keys()].map((f) => path.relative(root, f))
      await git(root, ['add', '--', ...rels])
      await git(root, [
        '-c', 'user.name=JARVIS', '-c', 'user.email=jarvis@localhost',
        'commit', '-m', `JARVIS self-modification: ${change.title}\n\n${change.description}`, '--', ...rels
      ])
      commit = await git(root, ['rev-parse', 'HEAD'])
    }
    codeChanges.update(id, { status: 'applied', commit })
  } catch (e) {
    codeChanges.update(id, { status: 'failed', error: String(e) })
  }
  return codeChanges.get(id)!
}

export function rejectChange(id: string): void {
  codeChanges.update(id, { status: 'rejected' })
}

export async function revertChange(id: string): Promise<CodeChange> {
  const change = codeChanges.get(id)
  if (!change?.commit) throw new Error('This change has no commit to revert')
  const root = requireRoot()
  await git(root, ['-c', 'user.name=JARVIS', '-c', 'user.email=jarvis@localhost', 'revert', '--no-edit', change.commit])
  codeChanges.update(id, { status: 'reverted' })
  return codeChanges.get(id)!
}
