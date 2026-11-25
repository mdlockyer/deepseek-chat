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
import type { ChildBlock, ChildToolResultBlock, ChildToolUseBlock } from './types.js'

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
  readonly finishTool: string
  readonly limits: { readonly maxRounds: number; readonly maxToolCalls: number }
  readonly runCalls: (
    calls: ChildToolUseBlock[],
    signal: AbortSignal
  ) => Promise<ChildToolResultBlock[]>
  readonly inbox: () => string | null
  readonly onStep: (t: Transcript<ChildBlock>, round: number) => void
  readonly onUpdate: (t: Transcript<ChildBlock>, round: number) => void
  readonly retry?: {
    readonly limit: number
    readonly wait: (attempt: number, signal: AbortSignal) => Promise<void>
  }
}

export type FinishOutput =
  | { readonly kind: 'given'; readonly value: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'requestFailed'; readonly error: ApiError }

export type ExhaustedLimit = 'rounds' | 'toolCalls' | 'noFinishCall'

export type AgentOutcome =
  | {
      readonly kind: 'finished'
      readonly output: unknown
      readonly transcript: Transcript<ChildBlock>
    }
  | {
      readonly kind: 'exhausted'
      readonly limit: ExhaustedLimit
      readonly output: FinishOutput
      readonly transcript: Transcript<ChildBlock>
    }
  | {
      readonly kind: 'failed'
      readonly error: ApiError
      readonly transcript: Transcript<ChildBlock>
    }
  | { readonly kind: 'stopped'; readonly transcript: Transcript<ChildBlock> }

const toAssistantParam = (blocks: readonly ChildBlock[]): AssistantBlockParam[] => {
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

export const runAgent = async (input: RunAgentInput): Promise<AgentOutcome> => {
  let transcript: Transcript<ChildBlock> = { blocks: [] }
  let messages: MessageParam[] = [...input.request.messages]
  let toolCallsUsed = 0
  let currentRound = 0
  let networkRetries = 0

  const streamOneRound = async (
    roundMessages: MessageParam[],
    toolChoice?: CreateMessageRequest['tool_choice']
  ): Promise<
    | { ok: true; roundBlocks: ChildBlock[] }
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
        if (apiError.kind === 'interrupted' && receivedStopReason) {
          return { ok: true, roundBlocks: transcript.blocks.slice(startIdx) }
        }
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
    const finishMessages: MessageParam[] =
      last?.role === 'user'
        ? appendInboxToMessages(messages, nudge)
        : [...messages, { role: 'user', content: nudge }]

    const toolChoice: CreateMessageRequest['tool_choice'] = input.request.thinking
      ? undefined
      : { type: 'tool', name: input.finishTool }
    const limit: ExhaustedLimit = mode.kind === 'exhausted' ? mode.limit : 'noFinishCall'
    const round = await streamOneRound(finishMessages, toolChoice)
    if (!round.ok) {
      if (round.outcome.kind === 'stopped') {
        return round.outcome
      }
      input.onStep(transcript, currentRound)
      return {
        kind: 'exhausted',
        limit,
        output: { kind: 'requestFailed', error: round.outcome.error },
        transcript,
      }
    }

    const finishCall = round.roundBlocks.find(
      (b): b is ChildToolUseBlock => b.type === 'tool_use' && b.name === input.finishTool
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

    const calls = round.roundBlocks.filter((b): b is ChildToolUseBlock => b.type === 'tool_use')
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

    const overflowResults: ChildToolResultBlock[] = overflow.map((call) => ({
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

  return { kind: 'exhausted', limit: 'rounds', output: { kind: 'missing' }, transcript }
}
