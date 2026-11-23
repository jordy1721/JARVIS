// A tiny MCP server (stdio) that Claude Code launches. It forwards tool calls to the
// running JARVIS app over a localhost connection protected by a per-launch token, so the
// subscription route gets exactly the same tools, approvals and action log as the API route.
// Runs under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1); no extra install needed.
import http from 'node:http'

const PORT = Number(process.env.JARVIS_PORT)
const TOKEN = process.env.JARVIS_TOKEN ?? ''

function callJarvis(pathname: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method: data ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
      },
      (res) => {
        let out = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (out += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(out))
          } catch {
            reject(new Error(`Bad response from JARVIS (${res.statusCode})`))
          }
        })
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function send(msg: object) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(msg: any) {
  const { id, method, params } = msg
  if (id === undefined) return // notification
  try {
    let result: unknown
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'jarvis', version: '1.0.0' }
        }
        break
      case 'ping':
        result = {}
        break
      case 'tools/list':
        result = { tools: await callJarvis('/tools') }
        break
      case 'tools/call':
        result = await callJarvis('/call', { name: params.name, arguments: params.arguments ?? {} })
        break
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
    send({ jsonrpc: '2.0', id, result })
  } catch (e) {
    if (method === 'tools/call') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true } })
    } else send({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buf += chunk
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      void handle(JSON.parse(line))
    } catch {
      /* ignore malformed input */
    }
  }
})
process.stdin.on('end', () => process.exit(0))
