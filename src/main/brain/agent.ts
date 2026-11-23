// The agent loop: routes each request to the cheap or smart model, streams the reply,
// executes tool calls (with the user's approval where needed), and tracks cost.
import type Anthropic from '@anthropic-ai/sdk'
import type { AssistantState, ChatEntry, ConfirmRequest, GuideStep } from '@shared/types'
import { actions, chat, getSettings, newId } from '../store'
import { getClient, hasApiKey } from './client'
import { contextBlock, systemPrompt, wantsSmartModel } from './prompts'
import { buildTools, describeAction, runCustomTool, toolRisk, validateInput, type ToolHooks } from './tools'
import { profileBlock, learnFromConversation } from './memory'
import { recordUsage, overBudget, spentToday } from '../services/usage'
import { runComputerAction } from '../computer/control'
import { supportsServerFallbacks } from './pricing'
import { truncate } from '../computer/system'

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam

export interface AgentHooks extends ToolHooks {
  emitChat(e: ChatEntry): void
  emitStream(id: string, delta: string, done: boolean, speak: boolean): void
  emitReply(e: ChatEntry, speak: boolean, streamed: boolean): void
  setState(s: AssistantState, caption?: string): void
  confirm(req: Omit<ConfirmRequest, 'id'>): Promise<boolean>
  beforeScreenshot(): Promise<void>
  afterScreenshot(): void
}

interface Session {
  messages: MessageParam[]
  started: number
  lastActivity: number
  lastPromptTokens: number
  transcript: string[]
  learnedUpTo: number
}

const IDLE_ROLLOVER_MS = 20 * 60_000

export class Agent {
  private session: Session | null = null
  private carryOver = ''
  private abort: AbortController | null = null
  private queue: Promise<void> = Promise.resolve()
  busy = false

  constructor(private hooks: AgentHooks) {}

  stop(): void {
    this.abort?.abort()
  }

  newSession(): void {
    this.finishSession()
  }

  /** Queue a user message. `spoken` marks voice input; `silent` hides it from the chat UI. */
  send(text: string, opts: { spoken?: boolean; silent?: boolean; purpose?: 'chat' | 'automation' } = {}): Promise<void> {
    this.queue = this.queue.then(() => this.turn(text, opts)).catch((e) => console.error('[agent]', e))
    return this.queue
  }

  private finishSession(): void {
    const s = this.session
    if (!s) return
    const pending = s.transcript.slice(s.learnedUpTo)
    if (pending.length) learnFromConversation(pending.join('\n')).catch((e) => console.warn('[memory]', e))
    this.carryOver = s.transcript.slice(-6).map((l) => truncate(l, 400)).join('\n')
    this.session = null
  }

  private ensureSession(firstText: string): { session: Session; isNew: boolean } {
    const settings = getSettings()
    const s = this.session
    if (
      s &&
      (Date.now() - s.lastActivity > IDLE_ROLLOVER_MS || s.lastPromptTokens > settings.sessionTokenLimit)
    ) {
      this.finishSession()
    }
    if (this.session) return { session: this.session, isNew: false }
    this.session = {
      messages: [],
      started: Date.now(),
      lastActivity: Date.now(),
      lastPromptTokens: 0,
      transcript: [],
      learnedUpTo: 0
    }
    void firstText
    return { session: this.session, isNew: true }
  }

  private pickModel(text: string): { model: string; fast: boolean } {
    const s = getSettings()
    if (s.routing === 'fast') return { model: s.fastModel, fast: true }
    if (s.routing === 'smart') return { model: s.smartModel, fast: false }
    return wantsSmartModel(text) ? { model: s.smartModel, fast: false } : { model: s.fastModel, fast: true }
  }

  private async turn(text: string, opts: { spoken?: boolean; silent?: boolean; purpose?: 'chat' | 'automation' }) {
    const settings = getSettings()
    const h = this.hooks
    if (!opts.silent) h.emitChat(chat.add({ role: 'user', text }))

    if (!hasApiKey()) {
      h.emitReply(chat.add({ role: 'assistant', text: 'I need an Anthropic API key before I can help. Add one in Settings.' }), false, false)
      return
    }
    if (overBudget()) {
      const msg = `I've reached today's spending limit of $${settings.dailyBudgetUsd.toFixed(2)} (spent $${spentToday().toFixed(3)}). You can raise it in Settings.`
      h.emitReply(chat.add({ role: 'assistant', text: msg }), settings.ttsEnabled && !!opts.spoken, false)
      return
    }

    const { session, isNew } = this.ensureSession(text)
    let { model, fast } = this.pickModel(text)
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const userText = `${opts.spoken ? '(spoken) ' : ''}[${time}] ${text}`
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = []
    if (isNew) content.push({ type: 'text', text: contextBlock(settings, profileBlock(text), this.carryOver) })
    content.push({ type: 'text', text: userText })
    session.messages.push({ role: 'user', content })
    session.transcript.push(`User: ${text}`)
    session.lastActivity = Date.now()

    this.abort = new AbortController()
    this.busy = true
    let computerGranted = settings.autonomy === 'autonomous'
    let steps = 0
    let turnCost = 0
    const replyParts: string[] = []
    const speak = settings.ttsEnabled && (!!opts.spoken || opts.purpose === 'automation')
    let anyStreamed = false

    try {
      while (true) {
        if (this.abort.signal.aborted) throw new Error('aborted')
        if (steps++ > settings.maxToolStepsPerTurn) {
          replyParts.push('I stopped because this task took more steps than your per-request limit.')
          break
        }
        if (overBudget()) {
          replyParts.push('I stopped because today\'s spending limit was reached.')
          break
        }
        h.setState('thinking')
        const streamId = newId()
        let streamed = ''
        const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
          model,
          max_tokens: 16000,
          system: [{ type: 'text', text: systemPrompt(settings), cache_control: { type: 'ephemeral' } }],
          tools: buildTools(settings, model, fast),
          messages: session.messages,
          cache_control: { type: 'ephemeral' },
          output_config: { effort: fast ? settings.fastEffort : settings.smartEffort },
          stream: true
        }
        const betas: Anthropic.Beta.AnthropicBeta[] = []
        if (supportsServerFallbacks(model)) {
          betas.push('server-side-fallback-2026-07-01')
          ;(params as unknown as Record<string, unknown>).fallbacks = 'default'
        }
        if (betas.length) params.betas = betas

        const stream = getClient().beta.messages.stream(params, { signal: this.abort.signal })
        stream.on('text', (delta) => {
          streamed += delta
          h.emitStream(streamId, delta, false, speak)
        })
        const msg = await stream.finalMessage()
        h.emitStream(streamId, '', true, speak)
        if (streamed.trim()) anyStreamed = true

        const cost = recordUsage(model, msg.usage, opts.purpose === 'automation' ? 'automation' : 'chat')
        turnCost += cost
        session.lastPromptTokens =
          (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0)
        session.messages.push({ role: 'assistant', content: msg.content } as unknown as MessageParam)
        if (streamed.trim()) replyParts.push(streamed.trim())

        if (msg.stop_reason === 'refusal') {
          replyParts.push("I'm not able to help with that one.")
          break
        }
        if (msg.stop_reason === 'pause_turn') continue
        if (msg.stop_reason !== 'tool_use') break

        // ---- execute tool calls ----
        const toolUses = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use')
        const results: ToolResult[] = []
        let computerFailed = false
        let escalateTo: string | null = null
        h.setState('acting')

        for (const tu of toolUses) {
          const input = (tu.input ?? {}) as Record<string, any>
          const isComputer = tu.toolset_name === 'computer'
          const base = { type: 'tool_result' as const, tool_use_id: tu.id, ...(isComputer ? { toolset_name: 'computer' } : {}) }

          if (this.abort.signal.aborted) {
            results.push({ ...base, is_error: true, content: 'Stopped by the user.' })
            continue
          }
          if (isComputer && computerFailed) {
            results.push({ ...base, is_error: true, content: 'Not executed: an earlier computer action in this turn failed.' })
            continue
          }
          if (tu.name === 'escalate') {
            escalateTo = settings.smartModel
            results.push({ ...base, content: `Switched to ${settings.smartModel}. Continue the task.` })
            continue
          }
          const invalid = isComputer ? null : validateInput(tu.name, input)
          if (invalid) {
            results.push({ ...base, is_error: true, content: `INVALID_INPUT: ${invalid}` })
            continue
          }

          // ---- approval ----
          const risk = toolRisk(tu.name, isComputer)
          const summary = describeAction(tu.name, input)
          let needsAsk = false
          if (settings.autonomy === 'ask-always') needsAsk = risk !== 'none'
          else if (settings.autonomy === 'ask-risky') needsAsk = risk === 'high' || (risk === 'medium' && !isComputer)
          if (isComputer && risk !== 'none' && !computerGranted && settings.autonomy === 'ask-risky') {
            const ok = await h.confirm({
              title: 'Allow mouse & keyboard control?',
              detail: `${settings.assistantName} wants to control your mouse and keyboard to complete: "${truncate(text, 200)}".\n\nFirst action: ${summary}\n\nYou can stop at any time with ${settings.stopHotkey}.`,
              risk: 'medium'
            })
            if (!ok) {
              actions.add({ tool: 'computer', summary, status: 'denied' })
              results.push({ ...base, is_error: true, content: 'The user did not allow computer control for this request.' })
              computerFailed = true
              continue
            }
            computerGranted = true
          } else if (needsAsk) {
            const ok = await h.confirm({ title: `Allow: ${tu.name.replace(/_/g, ' ')}?`, detail: summary, risk: risk === 'high' ? 'high' : 'medium' })
            if (!ok) {
              actions.add({ tool: tu.name, summary, status: 'denied' })
              results.push({ ...base, is_error: true, content: 'The user denied this action.' })
              if (isComputer) computerFailed = true
              continue
            }
          }

          // ---- execute ----
          h.setState('acting', summary.split('\n')[0])
          try {
            if (isComputer) {
              const isShot = tu.name === 'screenshot' || tu.name === 'zoom'
              if (isShot) await h.beforeScreenshot()
              let r
              try {
                r = await runComputerAction(tu.name, input)
              } finally {
                if (isShot) h.afterScreenshot()
              }
              if (r.kind === 'image') {
                results.push({
                  ...base,
                  content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.shot.base64 } }]
                })
              } else results.push({ ...base, content: r.text })
              if (!isShot) actions.add({ tool: `computer.${tu.name}`, summary, status: computerGranted ? 'approved' : 'auto' })
            } else {
              const out = await runCustomTool(tu.name, input, h)
              results.push({ ...base, content: out })
              const entry = chat.add({ role: 'tool', text: summary.split('\n')[0], tool: { name: tu.name, input, ok: true, output: truncate(out, 800) } })
              h.emitChat(entry)
              if (risk !== 'none') actions.add({ tool: tu.name, summary, status: needsAsk ? 'approved' : 'auto', detail: truncate(out, 500) })
            }
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e)
            results.push({ ...base, is_error: true, content: `Error: ${err}` })
            actions.add({ tool: tu.name, summary, status: 'error', detail: err })
            if (isComputer) computerFailed = true
          }
        }
        session.messages.push({ role: 'user', content: results })
        if (escalateTo) {
          model = escalateTo
          fast = false
          h.setState('thinking', 'Thinking harder…')
        }
      }
    } catch (e) {
      const aborted = this.abort.signal.aborted
      const err = e instanceof Error ? e.message : String(e)
      replyParts.push(aborted ? 'Stopped.' : `Something went wrong: ${err}`)
      // Keep the session valid: drop a dangling tool_use turn by starting fresh next time.
      this.finishSession()
    } finally {
      this.busy = false
      this.abort = null
    }

    const reply = replyParts.join('\n\n').trim() || 'Done.'
    const entry = chat.add({ role: 'assistant', text: reply, model, costUsd: turnCost })
    h.emitReply(entry, speak, anyStreamed)
    if (this.session) {
      this.session.transcript.push(`${settings.assistantName}: ${truncate(reply, 1500)}`)
      // Learn every few exchanges so memory stays fresh without extra cost per message.
      const s = this.session
      if (s.transcript.length - s.learnedUpTo >= 12) {
        const chunk = s.transcript.slice(s.learnedUpTo).join('\n')
        s.learnedUpTo = s.transcript.length
        learnFromConversation(chunk).catch((e) => console.warn('[memory]', e))
      }
    }
    h.setState('idle')
  }
}

export type { GuideStep }
