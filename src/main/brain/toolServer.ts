// Localhost endpoint that the MCP bridge (launched by Claude Code) talks to.
// Bound to 127.0.0.1 only and protected by a random token generated at each app start.
import http from 'node:http'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Settings } from '@shared/types'
import { getSettings } from '../store'
import { CUSTOM_TOOLS } from './tools'
import type { ToolOutput } from './agent'

type Executor = (name: string, input: Record<string, any>, isComputer: boolean) => Promise<ToolOutput>

const TOKEN = randomBytes(24).toString('hex')
let port = 0
let executor: Executor | null = null

const SELF_MOD = new Set(['list_source_files', 'read_source_file', 'propose_code_change'])

/** The computer toolset is an API feature, so on the subscription route it's offered as one MCP tool. */
const COMPUTER_TOOL = {
  name: 'computer',
  description:
    'See and control the screen. Actions: screenshot; zoom (region [x0,y0,x1,y1]); left_click/right_click/middle_click/double_click/triple_click (coordinate [x,y], optional text = modifier keys like "shift"); left_click_drag (start_coordinate, coordinate); mouse_move (coordinate); left_mouse_down; left_mouse_up; scroll (coordinate, scroll_direction, scroll_amount); type (text); key (text like "ctrl+c" or "Return", optional repeat); hold_key (text, duration); wait (duration seconds); cursor_position. Coordinates are pixels in the most recent screenshot. Take a screenshot before clicking.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag',
          'mouse_move', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key', 'wait', 'cursor_position'
        ]
      },
      coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      start_coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
      text: { type: 'string' },
      scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      scroll_amount: { type: 'integer' },
      repeat: { type: 'integer' },
      duration: { type: 'number' }
    },
    required: ['action']
  }
}

export function mcpTools(s: Settings) {
  const tools: object[] = CUSTOM_TOOLS.filter((t) => {
    if (t.name === 'escalate') return false
    if (t.name === 'run_shell' && !s.allowShell) return false
    if (SELF_MOD.has(t.name) && !s.allowSelfModification) return false
    return true
  }).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))
  if (s.allowComputerControl) tools.push(COMPUTER_TOOL)
  return tools
}

export function subscriptionAllowedTools(s: Settings): string[] {
  // JARVIS applies its own approval rules inside each tool, so Claude Code may call them freely.
  const allowed = ['mcp__jarvis']
  if (s.allowWebSearch) allowed.push('WebSearch', 'WebFetch')
  return allowed
}

function bridgeScript(): string {
  // When packaged, the bridge is unpacked from the asar archive so Node can run it directly.
  return path.join(__dirname, 'mcp-bridge.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

export function mcpConfig() {
  return {
    mcpServers: {
      jarvis: {
        type: 'stdio',
        command: process.execPath,
        args: [bridgeScript()],
        env: { ELECTRON_RUN_AS_NODE: '1', JARVIS_PORT: String(port), JARVIS_TOKEN: TOKEN }
      }
    }
  }
}

function authorized(req: http.IncomingMessage): boolean {
  const got = Buffer.from(String(req.headers.authorization ?? ''))
  const want = Buffer.from(`Bearer ${TOKEN}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

export function startToolServer(exec: Executor): Promise<void> {
  executor = exec
  const server = http.createServer((req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!authorized(req)) return reply(401, { error: 'unauthorized' })
    if (req.method === 'GET' && req.url === '/tools') return reply(200, mcpTools(getSettings()))
    if (req.method === 'POST' && req.url === '/call') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        try {
          const { name, arguments: args } = JSON.parse(body)
          const isComputer = name === 'computer'
          const out = await executor!(isComputer ? String(args.action) : name, args ?? {}, isComputer)
          const content = out.imageBase64
            ? [{ type: 'image', data: out.imageBase64, mimeType: 'image/jpeg' }]
            : [{ type: 'text', text: out.text ?? 'OK' }]
          reply(200, { content, isError: !!out.isError })
        } catch (e) {
          reply(200, { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true })
        }
      })
      return
    }
    reply(404, { error: 'not found' })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  )
}
