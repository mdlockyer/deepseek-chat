import {
  ApiError,
  applyEvent,
  streamMessage,
  type AgentIO,
  type AssistantBlockParam,
  type ChatModel,
  type ClientTool,
  type CreateMessageRequest,
  type MessageParam,
  type ToolResultBlockParam,
  type Transcript,
} from '@deepseek-chat/lib-agent'
import type { ReplyBlock, ToolCallPart, ToolResultPart } from './types.js'

export type RunAgentInput = {
  readonly io: AgentIO
  readonly signal: AbortSignal
  readonly request: {
    readonly model: ChatModel
    readonly system: string
    readonly thinking: boolean
    readonly tools: ClientTool[]
    readonly messages: MessageParam[]
  }
  /** The run ends when the model calls this tool. */
  readonly finishTool: string
  readonly limits: { readonly maxRounds: number; readonly maxToolCalls: number }
  readonly runCalls: (calls: ToolCallPart[], signal: AbortSignal) => Promise<ToolResultPart[]>
  /** Unseen board posts appended to the latest tool result (or initial task) before each request. */
  readonly inbox: () => string | null
  /** Called at step boundaries (after each tool round and on end); the runtime persists here. */
  readonly onStep: (t: Transcript<ReplyBlock>, round: number) => void
  /** Called on every streamed event for live UI updates; never persists or emits EventLog facts. */
  readonly onUpdate: (t: Transcript<ReplyBlock>, round: number) => void
  /**
   * Network retries for the whole run, matching the lead's policy: a request that fails with a
   * network error before any content block arrived is sent again after `wait(attempt)`.
   */
  readonly retry?: {
    readonly limit: number
    readonly wait: (attempt: number, signal: AbortSignal) => Promise<void>
  }
}

/**
 * The finish tool's input on an exhausted run: given in the forced-finish round, not given there,
 * or unknown because that request failed (its error kept so the failure is reported, not hidden).
 */
export type FinishOutput =
  | { kind: 'given'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'requestFailed'; error: ApiError }

/** Why a run ended without a proper finish (see `AgentRunState`). */
export type ExhaustedLimit = 'rounds' | 'toolCalls' | 'noFinishCall'

export type AgentOutcome =
  | { kind: 'finished'; output: unknown; transcript: Transcript<ReplyBlock> }
  | {
      kind: 'exhausted'
      limit: ExhaustedLimit
      output: FinishOutput
      transcript: Transcript<ReplyBlock>
    }
  | { kind: 'failed'; error: ApiError; transcript: Transcript<ReplyBlock> }
  | { kind: 'stopped'; transcript: Transcript<ReplyBlock> }

const toAssistantParam = (blocks: readonly ReplyBlock[]): AssistantBlockParam[] => {
  const out: AssistantBlockParam[] = []
  for (const block of blocks) {
    if (block.type === 'thinking') {
      if (block.thinking.trim() || block.signature) {
        out.push({ type: 'thinking', thinking: block.thinking, signature: block.signature ?? '' })
      }
    } else if (block.type === 'text') {
      if (block.text) {
        out.push({ type: 'text', text: block.text })
      }
    } else if (block.type === 'tool_use') {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
    }
  }
  return out
}

const appendInboxToMessages = (messages: MessageParam[], note: string | null): MessageParam[] => {
  if (!note) {
    return messages
  }
  const last = messages.at(-1)
  if (!last || last.role !== 'user') {
    return [...messages, { role: 'user', content: note }]
  }
  const next = [...messages]
  if (typeof last.content === 'string') {
    next[next.length - 1] = { role: 'user', content: `${last.content}\n\n${note}` }
    return next
  }
  const parts = [...last.content]
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i]
    if (part?.type === 'tool_result') {
      parts[i] = { ...part, content: `${part.content}\n\n${note}` }
      next[next.length - 1] = { role: 'user', content: parts }
      return next
    }
  }
  parts.push({ type: 'text', text: note })
  next[next.length - 1] = { role: 'user', content: parts }
  return next
}

/**
 * Runs one child subagent loop inside conversations on top of `libs/agent`'s stateless `streamMessage`
 * and pure `applyEvent`. Enforces round and tool-call limits with one forced-finish request when
 * exhausted or when the model ends its turn without calling `finishTool`.
 */
export const runAgent = async (input: RunAgentInput): Promise<AgentOutcome> => {
  let transcript: Transcript<ReplyBlock> = { blocks: [] }
  let messages: MessageParam[] = [...input.request.messages]
  let toolCallsUsed = 0
  let currentRound = 0
  let networkRetries = 0

  const streamOneRound = async (
    roundMessages: MessageParam[],
    toolChoice?: CreateMessageRequest['tool_choice']
  ): Promise<
    | { ok: true; roundBlocks: ReplyBlock[] }
    | { ok: false; outcome: Extract<AgentOutcome, { kind: 'stopped' | 'failed' }> }
  > => {
    const startIdx = transcript.blocks.length
    const before = transcript
    const body: CreateMessageRequest = {
      model: input.request.model,
      system: input.request.system,
      messages: roundMessages,
      thinking: { type: input.request.thinking ? 'enabled' : 'disabled' },
      tools: input.request.tools,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    }
    for (;;) {
      if (input.signal.aborted) {
        return { ok: false, outcome: { kind: 'stopped', transcript } }
      }
      let receivedContent = false
      let receivedStopReason = false
      try {
        for await (const event of streamMessage(input.io, body, input.signal)) {
          receivedContent ||= event.type === 'content_block_start'
          receivedStopReason ||= event.type === 'message_delta' && Boolean(event.delta.stop_reason)
          transcript = applyEvent(transcript, event, Date.now())
          input.onUpdate(transcript, currentRound)
        }
      } catch (error) {
        if (input.signal.aborted) {
          return { ok: false, outcome: { kind: 'stopped', transcript } }
        }
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError('protocol', error instanceof Error ? error.message : String(error))
        // The stop reason arrived and only the closing message_stop is missing: the round is whole.
        if (apiError.kind === 'interrupted' && receivedStopReason) {
          return { ok: true, roundBlocks: transcript.blocks.slice(startIdx) }
        }
        // Nothing of the answer arrived (e.g. a reused connection the server had just closed), so
        // sending the same request again can't duplicate anything.
        if (
          apiError.kind === 'network' &&
          !receivedContent &&
          input.retry &&
          networkRetries < input.retry.limit
        ) {
          await input.retry.wait(networkRetries, input.signal)
          networkRetries += 1
          transcript = before
          continue
        }
        return { ok: false, outcome: { kind: 'failed', error: apiError, transcript } }
      }
      return { ok: true, roundBlocks: transcript.blocks.slice(startIdx) }
    }
  }

  const runForcedFinish = async (
    reason: string,
    mode: { kind: 'exhausted'; limit: 'rounds' | 'toolCalls' } | { kind: 'noFinishCall' }
  ): Promise<AgentOutcome> => {
    if (input.signal.aborted) {
      return { kind: 'stopped', transcript }
    }
    currentRound += 1
    const inboxNote = input.inbox()
    const nudge = inboxNote ? `${reason}\n\n${inboxNote}` : reason
    const last = messages.at(-1)
    let finishMessages: MessageParam[]
    if (last?.role === 'user') {
      finishMessages = appendInboxToMessages(messages, nudge)
    } else {
      finishMessages = [...messages, { role: 'user', content: nudge }]
    }

    // DeepSeek rejects a named `tool_choice` with HTTP 400 in thinking mode, so a thinking child
    // gets the nudge alone and keeps `auto` tool choice.
    const toolChoice: CreateMessageRequest['tool_choice'] = input.request.thinking
      ? undefined
      : { type: 'tool', name: input.finishTool }
    const limit: ExhaustedLimit = mode.kind === 'exhausted' ? mode.limit : 'noFinishCall'
    const round = await streamOneRound(finishMessages, toolChoice)
    if (!round.ok) {
      if (round.outcome.kind === 'stopped') {
        return round.outcome
      }
      // The child already did its work, so a failed nudge request must not discard it: the
      // runtime falls back to the child's last text and reports the request's error with it.
      input.onStep(transcript, currentRound)
      return {
        kind: 'exhausted',
        limit,
        output: { kind: 'requestFailed', error: round.outcome.error },
        transcript,
      }
    }

    const finishCall = round.roundBlocks.find(
      (b): b is ToolCallPart => b.type === 'tool_use' && b.name === input.finishTool
    )
    if (finishCall) {
      transcript = {
        ...transcript,
        blocks: [
          ...transcript.blocks,
          {
            type: 'tool_result',
            tool_use_id: finishCall.id,
            content: 'Finished.',
            status: 'ok',
          },
        ],
      }
      input.onStep(transcript, currentRound)
      if (mode.kind === 'noFinishCall') {
        return { kind: 'finished', output: finishCall.input, transcript }
      }
      return {
        kind: 'exhausted',
        limit: mode.limit,
        output: { kind: 'given', value: finishCall.input },
        transcript,
      }
    }

    input.onStep(transcript, currentRound)
    return { kind: 'exhausted', limit, output: { kind: 'missing' }, transcript }
  }

  const maxRounds = Math.max(1, input.limits.maxRounds)
  const maxToolCalls = Math.max(1, input.limits.maxToolCalls)

  for (let roundNum = 1; roundNum <= maxRounds; roundNum += 1) {
    if (input.signal.aborted) {
      return { kind: 'stopped', transcript }
    }
    currentRound = roundNum
    messages = appendInboxToMessages(messages, input.inbox())

    const round = await streamOneRound(messages)
    if (!round.ok) {
      return round.outcome
    }

    const calls = round.roundBlocks.filter((b): b is ToolCallPart => b.type === 'tool_use')
    const finishCall = calls.find((call) => call.name === input.finishTool)
    if (finishCall) {
      transcript = {
        ...transcript,
        blocks: [
          ...transcript.blocks,
          {
            type: 'tool_result',
            tool_use_id: finishCall.id,
            content: 'Finished.',
            status: 'ok',
          },
        ],
      }
      input.onStep(transcript, currentRound)
      return { kind: 'finished', output: finishCall.input, transcript }
    }

    const assistantBlocks = toAssistantParam(round.roundBlocks)
    if (assistantBlocks.length > 0) {
      messages = [...messages, { role: 'assistant', content: assistantBlocks }]
    }

    if (calls.length === 0) {
      input.onStep(transcript, currentRound)
      return runForcedFinish(
        `You ended your turn without calling \`${input.finishTool}\`. Call \`${input.finishTool}\` now with your findings.`,
        { kind: 'noFinishCall' }
      )
    }

    const remaining = Math.max(0, maxToolCalls - toolCallsUsed)
    const toRun = calls.slice(0, remaining)
    const overflow = calls.slice(remaining)
    toolCallsUsed += toRun.length

    const ranResults = toRun.length > 0 ? await input.runCalls(toRun, input.signal) : []
    if (input.signal.aborted) {
      return { kind: 'stopped', transcript }
    }

    const overflowResults: ToolResultPart[] = overflow.map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: `Tool call budget reached (${maxToolCalls} tool calls). Call \`${input.finishTool}\` now with what you have.`,
      status: 'error',
    }))
    const allResults = [...ranResults, ...overflowResults]
    transcript = { ...transcript, blocks: [...transcript.blocks, ...allResults] }

    const toolResultParams: ToolResultBlockParam[] = allResults.map((res) => ({
      type: 'tool_result',
      tool_use_id: res.tool_use_id,
      content: res.content,
    }))
    messages = [...messages, { role: 'user', content: toolResultParams }]
    input.onStep(transcript, currentRound)

    if (toolCallsUsed >= maxToolCalls) {
      return runForcedFinish(
        `You have reached your budget of ${maxToolCalls} tool calls. Call \`${input.finishTool}\` now with what you have.`,
        { kind: 'exhausted', limit: 'toolCalls' }
      )
    }
    if (roundNum >= maxRounds) {
      return runForcedFinish(
        `You have reached your limit of ${maxRounds} rounds. Call \`${input.finishTool}\` now with what you have.`,
        { kind: 'exhausted', limit: 'rounds' }
      )
    }
  }

  return {
    kind: 'exhausted',
    limit: 'rounds',
    output: { kind: 'missing' },
    transcript,
  }
}
