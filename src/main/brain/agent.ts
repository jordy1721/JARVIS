// The agent loop. Two interchangeable "engines":
//  • subscription — runs through the user's own Claude Code CLI (Claude Pro/Max plan, no API credits)
//  • api          — calls the Claude API directly with an API key (pay per use)
// Both share the same tools, approvals, action log, conversation memory and long-term memory.
import type Anthropic from '@anthropic-ai/sdk'
import type { AssistantState, ChatEntry, ConfirmRequest } from '@shared/types'
import { actions, chat, getSettings, kv, newId } from '../store'
import { getClient, isConfigured, notConfiguredMessage } from './client'
import { contextBlock, systemPrompt, wantsSmartModel } from './prompts'
import { buildTools, describeAction, runCustomTool, toolRisk, validateInput, type ToolHooks } from './tools'
import { profileBlock, learnFromConversation } from './memory'
import { recordUsage, recordSubscriptionUsage, overBudget, spentToday } from '../services/usage'
import { runComputerAction } from '../computer/control'
import { supportsServerFallbacks } from './pricing'
import { truncate } from '../computer/system'
import { friendlyError, runClaude } from './claudeCli'
import { mcpConfig, subscriptionAllowedTools } from './toolServer'

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam
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

/** Result of running one tool, independent of which engine asked for it. */
export interface ToolOutput {
  text?: string
  imageBase64?: string
  isError?: boolean
}

interface TurnCtx {
  text: string
  computerGranted: boolean
  computerFailed: boolean
  signal: AbortSignal
}

interface ConversationState {
  lines: string[] // "User: …" / "JARVIS: …"
  learnedUpTo: number
  lastActivity: number
  promptTokens: number
  claudeSessionId: string | null // subscription engine session (Claude Code --resume)
}

const IDLE_ROLLOVER_MS = 20 * 60_000

export class Agent {
  private apiMessages: MessageParam[] = []
  private convo: ConversationState
  private carryOver: string
  private abort: AbortController | null = null
  private queue: Promise<void> = Promise.resolve()
  private turnCtx: TurnCtx | null = null
  busy = false

  constructor(private hooks: AgentHooks) {
    // Conversation memory survives restarts.
    this.convo = kv.get<ConversationState>('conversation', {
      lines: [],
      learnedUpTo: 0,
      lastActivity: 0,
      promptTokens: 0,
      claudeSessionId: null
    })
    this.carryOver = kv.get('carryOver', '')
    // API-engine message history can't be resumed after a restart; the subscription engine can.
    if (this.convo.lines.length && Date.now() - this.convo.lastActivity > IDLE_ROLLOVER_MS) {
      setTimeout(() => this.finishConversation(), 10_000)
    }
  }

  private saveConvo() {
    kv.set('conversation', this.convo)
  }

  stop(): void {
    this.abort?.abort()
  }

  newSession(): void {
    this.finishConversation()
  }

  send(text: string, opts: { spoken?: boolean; silent?: boolean; purpose?: 'chat' | 'automation' } = {}): Promise<void> {
    this.queue = this.queue.then(() => this.turn(text, opts)).catch((e) => console.error('[agent]', e))
    return this.queue
  }

  /** Close the current conversation: learn from it, keep a short carry-over, start fresh next time. */
  private finishConversation(): void {
    const c = this.convo
    const pending = c.lines.slice(c.learnedUpTo)
    if (pending.length) {
      learnFromConversation(pending.join('\n'), 'conversation', c.lines.join('\n')).catch((e) => console.warn('[memory]', e))
    }
    if (c.lines.length) {
      this.carryOver = c.lines.slice(-6).map((l) => truncate(l, 400)).join('\n')
      kv.set('carryOver', this.carryOver)
    }
    this.apiMessages = []
    this.convo = { lines: [], learnedUpTo: 0, lastActivity: 0, promptTokens: 0, claudeSessionId: null }
    this.saveConvo()
  }

  private startTurnConversation(): boolean {
    const s = getSettings()
    const c = this.convo
    const stale = c.lines.length && Date.now() - c.lastActivity > IDLE_ROLLOVER_MS
    const tooBig = c.promptTokens > s.sessionTokenLimit
    // After a restart the API engine has no message history, so treat it as a new conversation.
    const apiLost = s.provider === 'api' && c.lines.length && this.apiMessages.length === 0
    if (stale || tooBig || apiLost) this.finishConversation()
    return this.convo.lines.length === 0
  }

  private pickModel(text: string): { model: string; fast: boolean } {
    const s = getSettings()
    const sub = s.provider === 'subscription'
    const fastM = sub ? s.subFastModel : s.fastModel
    const smartM = sub ? s.subSmartModel : s.smartModel
    if (s.routing === 'fast') return { model: fastM, fast: true }
    if (s.routing === 'smart') return { model: smartM, fast: false }
    return wantsSmartModel(text) ? { model: smartM, fast: false } : { model: fastM, fast: true }
  }

  // ------------------------------------------------------------------ turn
  private async turn(text: string, opts: { spoken?: boolean; silent?: boolean; purpose?: 'chat' | 'automation' }) {
    const settings = getSettings()
    const h = this.hooks
    if (!opts.silent) h.emitChat(chat.add({ role: 'user', text }))

    if (!(await isConfigured())) {
      h.emitReply(chat.add({ role: 'assistant', text: notConfiguredMessage() }), false, false)
      return
    }
    if (settings.provider === 'api' && overBudget()) {
      const msg = `I've reached today's spending limit of $${settings.dailyBudgetUsd.toFixed(2)} (spent $${spentToday().toFixed(3)}). You can raise it in Settings.`
      h.emitReply(chat.add({ role: 'assistant', text: msg }), settings.ttsEnabled && !!opts.spoken, false)
      return
    }

    const isNew = this.startTurnConversation()
    const { model, fast } = this.pickModel(text)
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const userText = `${opts.spoken ? '(spoken) ' : ''}[${time}] ${text}`
    const context = isNew ? contextBlock(settings, profileBlock(text), this.carryOver) : ''
    this.convo.lines.push(`User: ${text}`)
    this.convo.lastActivity = Date.now()

    this.abort = new AbortController()
    this.busy = true
    this.turnCtx = { text, computerGranted: settings.autonomy === 'autonomous', computerFailed: false, signal: this.abort.signal }
    const speak = settings.ttsEnabled && (!!opts.spoken || opts.purpose === 'automation')
    let out: { reply: string; streamed: boolean; cost: number; model: string }
    try {
      out =
        settings.provider === 'subscription'
          ? await this.subscriptionTurn(context, userText, model, fast, speak, opts.purpose)
          : await this.apiTurn(context, userText, model, fast, speak, opts.purpose)
    } catch (e) {
      const aborted = this.abort.signal.aborted
      const err = e instanceof Error ? e.message : String(e)
      out = { reply: aborted ? 'Stopped.' : `Something went wrong: ${err}`, streamed: false, cost: 0, model }
      // A half-finished tool exchange can't be continued on the API engine; start fresh next time.
      if (!aborted && settings.provider === 'api') this.apiMessages = []
    } finally {
      this.busy = false
      this.abort = null
      this.turnCtx = null
    }

    const reply = out.reply.trim() || 'Done.'
    const entry = chat.add({ role: 'assistant', text: reply, model: out.model, costUsd: out.cost })
    h.emitReply(entry, speak, out.streamed)
    this.convo.lines.push(`${settings.assistantName}: ${truncate(reply, 1500)}`)
    // Learn every few exchanges so memory stays fresh without extra cost per message.
    if (this.convo.lines.length - this.convo.learnedUpTo >= 12) {
      const chunk = this.convo.lines.slice(this.convo.learnedUpTo).join('\n')
      this.convo.learnedUpTo = this.convo.lines.length
      learnFromConversation(chunk).catch((e) => console.warn('[memory]', e))
    }
    this.saveConvo()
    h.setState('idle')
  }

  // ------------------------------------------------------------------ subscription engine
  private async subscriptionTurn(
    context: string,
    userText: string,
    model: string,
    fast: boolean,
    speak: boolean,
    purpose?: 'chat' | 'automation'
  ) {
    const settings = getSettings()
    const h = this.hooks
    const replyParts: string[] = []
    let streamId = newId()
    let streamedAny = false
    let streamedThisMsg = ''
    h.setState('thinking')

    const run = (resume: string | null) =>
      runClaude({
        prompt: context ? `${context}\n\n${userText}` : userText,
        model,
        effort: fast ? settings.fastEffort : settings.smartEffort,
        systemPrompt: systemPrompt(settings, 'subscription'),
        resume: resume ?? undefined,
        mcpConfig: mcpConfig(),
        allowedTools: subscriptionAllowedTools(settings),
        builtinTools: settings.allowWebSearch ? ['WebSearch', 'WebFetch'] : [],
        maxTurns: settings.maxToolStepsPerTurn,
        signal: this.abort!.signal,
        onEvent: (ev) => {
          if (ev.parent_tool_use_id) return // ignore sub-agent chatter
          if (ev.type === 'stream_event') {
            const e = ev.event
            if (e?.type === 'message_start') {
              streamId = newId()
              streamedThisMsg = ''
              h.setState('thinking')
            } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
              streamedThisMsg += e.delta.text
              streamedAny = true
              h.emitStream(streamId, e.delta.text, false, speak)
            } else if (e?.type === 'message_stop') {
              h.emitStream(streamId, '', true, speak)
            }
          } else if (ev.type === 'assistant') {
            const text = (ev.message?.content ?? [])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('')
              .trim()
            if (text) replyParts.push(text)
          } else if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
            this.convo.claudeSessionId = ev.session_id
          }
        }
      })

    let result
    try {
      result = await run(this.convo.claudeSessionId)
    } catch (e) {
      // If the old session can't be resumed (e.g. deleted), start a fresh one with context.
      if (this.convo.claudeSessionId && !this.abort?.signal.aborted && !context) {
        this.convo.claudeSessionId = null
        context = contextBlock(settings, profileBlock(userText), this.carryOver)
        result = await run(null)
      } else throw e
    }
    this.convo.claudeSessionId = result.session_id || this.convo.claudeSessionId
    const usage = result.usage ?? {}
    this.convo.promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    recordSubscriptionUsage(result, purpose === 'automation' ? 'automation' : 'chat')

    if (result.is_error) {
      const msg = friendlyError(result.result ?? result.subtype)
      if (/max.?turns/i.test(result.subtype)) replyParts.push('I stopped because this task took more steps than your per-request limit.')
      else replyParts.push(msg)
    } else if (!replyParts.length && result.result) replyParts.push(result.result)
    void streamedThisMsg
    return { reply: replyParts.join('\n\n'), streamed: streamedAny, cost: 0, model: `${model} · subscription` }
  }

  // ------------------------------------------------------------------ API engine
  private async apiTurn(context: string, userText: string, model: string, fast: boolean, speak: boolean, purpose?: 'chat' | 'automation') {
    const settings = getSettings()
    const h = this.hooks
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = []
    if (context) content.push({ type: 'text', text: context })
    content.push({ type: 'text', text: userText })
    this.apiMessages.push({ role: 'user', content })

    let steps = 0
    let turnCost = 0
    let anyStreamed = false
    const replyParts: string[] = []
    const signal = this.abort!.signal

    while (true) {
      if (signal.aborted) throw new Error('aborted')
      if (steps++ > settings.maxToolStepsPerTurn) {
        replyParts.push('I stopped because this task took more steps than your per-request limit.')
        break
      }
      if (overBudget()) {
        replyParts.push("I stopped because today's spending limit was reached.")
        break
      }
      h.setState('thinking')
      const streamId = newId()
      let streamed = ''
      const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
        model,
        max_tokens: 16000,
        system: [{ type: 'text', text: systemPrompt(settings, 'api'), cache_control: { type: 'ephemeral' } }],
        tools: buildTools(settings, model, fast),
        messages: this.apiMessages,
        cache_control: { type: 'ephemeral' },
        output_config: { effort: fast ? settings.fastEffort : settings.smartEffort },
        stream: true
      }
      if (supportsServerFallbacks(model)) {
        params.betas = ['server-side-fallback-2026-07-01']
        ;(params as unknown as Record<string, unknown>).fallbacks = 'default'
      }

      const stream = getClient().beta.messages.stream(params, { signal })
      stream.on('text', (delta) => {
        streamed += delta
        h.emitStream(streamId, delta, false, speak)
      })
      const msg = await stream.finalMessage()
      h.emitStream(streamId, '', true, speak)
      if (streamed.trim()) anyStreamed = true

      turnCost += recordUsage(model, msg.usage, purpose === 'automation' ? 'automation' : 'chat')
      this.convo.promptTokens =
        (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0)
      this.apiMessages.push({ role: 'assistant', content: msg.content } as unknown as MessageParam)
      if (streamed.trim()) replyParts.push(streamed.trim())

      if (msg.stop_reason === 'refusal') {
        replyParts.push("I'm not able to help with that one.")
        break
      }
      if (msg.stop_reason === 'pause_turn') continue
      if (msg.stop_reason !== 'tool_use') break

      const toolUses = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use')
      const results: ToolResult[] = []
      let escalate = false
      h.setState('acting')
      for (const tu of toolUses) {
        const isComputer = tu.toolset_name === 'computer'
        const base = { type: 'tool_result' as const, tool_use_id: tu.id, ...(isComputer ? { toolset_name: 'computer' } : {}) }
        if (tu.name === 'escalate') {
          escalate = true
          results.push({ ...base, content: `Switched to ${settings.smartModel}. Continue the task.` })
          continue
        }
        const r = await this.executeTool(tu.name, (tu.input ?? {}) as Record<string, any>, isComputer)
        results.push(
          r.imageBase64
            ? { ...base, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.imageBase64 } }] }
            : { ...base, content: r.text ?? 'OK', ...(r.isError ? { is_error: true } : {}) }
        )
      }
      this.apiMessages.push({ role: 'user', content: results })
      if (escalate) {
        model = settings.smartModel
        fast = false
        h.setState('thinking', 'Thinking harder…')
      }
    }
    return { reply: replyParts.join('\n\n'), streamed: anyStreamed, cost: turnCost, model }
  }

  // ------------------------------------------------------------------ shared tool execution
  /**
   * Run one tool with approvals and logging. Used by the API engine directly and by the
   * subscription engine through the local MCP bridge.
   */
  async executeTool(name: string, input: Record<string, any>, isComputer: boolean): Promise<ToolOutput> {
    const settings = getSettings()
    const h = this.hooks
    const ctx = this.turnCtx
    if (!ctx) return { text: 'No active request — tools can only run while JARVIS is handling a request.', isError: true }
    if (ctx.signal.aborted) return { text: 'Stopped by the user.', isError: true }
    if (isComputer && ctx.computerFailed) return { text: 'Not executed: an earlier computer action in this turn failed.', isError: true }

    const invalid = isComputer ? null : validateInput(name, input)
    if (invalid) return { text: `INVALID_INPUT: ${invalid}`, isError: true }

    // ---- approval ----
    const risk = toolRisk(name, isComputer)
    const summary = describeAction(name, input)
    let needsAsk = false
    if (settings.autonomy === 'ask-always') needsAsk = risk !== 'none'
    else if (settings.autonomy === 'ask-risky') needsAsk = risk === 'high' || (risk === 'medium' && !isComputer)
    if (isComputer && risk !== 'none' && !ctx.computerGranted && settings.autonomy === 'ask-risky') {
      const ok = await h.confirm({
        title: 'Allow mouse & keyboard control?',
        detail: `${settings.assistantName} wants to control your mouse and keyboard to complete: "${truncate(ctx.text, 200)}".\n\nFirst action: ${summary}\n\nYou can stop at any time with ${settings.stopHotkey}.`,
        risk: 'medium'
      })
      if (!ok) {
        actions.add({ tool: 'computer', summary, status: 'denied' })
        ctx.computerFailed = true
        return { text: 'The user did not allow computer control for this request.', isError: true }
      }
      ctx.computerGranted = true
    } else if (needsAsk) {
      const ok = await h.confirm({ title: `Allow: ${name.replace(/_/g, ' ')}?`, detail: summary, risk: risk === 'high' ? 'high' : 'medium' })
      if (!ok) {
        actions.add({ tool: name, summary, status: 'denied' })
        if (isComputer) ctx.computerFailed = true
        return { text: 'The user denied this action.', isError: true }
      }
    }

    // ---- execute ----
    h.setState('acting', summary.split('\n')[0])
    try {
      if (isComputer) {
        const isShot = name === 'screenshot' || name === 'zoom'
        if (isShot) await h.beforeScreenshot()
        let r
        try {
          r = await runComputerAction(name, input)
        } finally {
          if (isShot) h.afterScreenshot()
        }
        if (!isShot) actions.add({ tool: `computer.${name}`, summary, status: ctx.computerGranted ? 'approved' : 'auto' })
        return r.kind === 'image' ? { imageBase64: r.shot.base64 } : { text: r.text }
      }
      const out = await runCustomTool(name, input, h)
      h.emitChat(chat.add({ role: 'tool', text: summary.split('\n')[0], tool: { name, input, ok: true, output: truncate(out, 800) } }))
      if (risk !== 'none') actions.add({ tool: name, summary, status: needsAsk ? 'approved' : 'auto', detail: truncate(out, 500) })
      return { text: out }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      actions.add({ tool: name, summary, status: 'error', detail: err })
      if (isComputer) ctx.computerFailed = true
      return { text: `Error: ${err}`, isError: true }
    }
  }
}
