import type { ClientTool, MessageParam } from '@deepseek-chat/lib-agent'
import { createAgentIO } from './apiClient.js'
import { createMessageBoard, formatBoardDigest } from './board.js'
import { assignChildCitations, collectCitedUrls } from './citations.js'
import type { ConversationsParams } from './env.js'
import { createId } from './id.js'
import { runAgent, type RunAgentInput } from './runAgent.js'
import {
  POST_TOOL_NAME,
  WAIT_TOOL_NAME,
  buildSubagentOrientation,
  createChildPostTool,
  ensureSummaryParam,
} from './subagentTools.js'
import type { AgentSource, ToolGateway, ToolResult } from './tools.js'
import type {
  AgentRun,
  AssistantMessage,
  BoardPost,
  Message,
  ReplyBlock,
  ToolCallPart,
  ToolResultPart,
  WebSearchSourceMeta,
} from './types.js'

type DeliveredOutcome =
  | {
      kind: 'completed'
      outcome: 'finished' | 'exhausted'
      limit?: 'rounds' | 'toolCalls'
      content: string
      sources: AgentSource[]
    }
  | { kind: 'failed'; errorKind: string; message: string }
  | { kind: 'stopped'; reason: 'user' | 'interrupted' | 'roundLimit' }

type ManagedRun = {
  run: AgentRun
  controller?: AbortController
  promise?: Promise<void>
  stopReasonOverride?: 'user' | 'interrupted' | 'roundLimit'
  deliveredOutcome?: DeliveredOutcome
  reportedToLead: boolean
}

const getSummary = (input: unknown): string | undefined => {
  if (input && typeof input === 'object' && 'summary' in input) {
    const val = (input as { summary?: unknown }).summary
    if (typeof val === 'string' && val.trim()) {
      return val.replace(/\s+/g, ' ').trim()
    }
  }
  return undefined
}

const trimChildBlocks = (blocks: readonly ReplyBlock[], maxChars: number): ReplyBlock[] =>
  blocks.map((block) => {
    if (block.type !== 'tool_result' || block.content.length <= maxChars) {
      return block
    }
    return {
      ...block,
      content: `${block.content.slice(0, maxChars)}\n[Truncated for display]`,
    }
  })

/** Opens each subagent's section in a `wait` result; hydration looks for it to tell what was delivered. */
const resultHeading = (runId: string) => `### Subagent ${runId} (`

const lastTextBlock = (blocks: readonly ReplyBlock[]): string => {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]
    if (block?.type === 'text' && block.text.trim()) {
      return block.text.trim()
    }
  }
  return ''
}

const appendTaskToFork = (prefix: readonly MessageParam[], taskMessage: string): MessageParam[] => {
  if (prefix.length === 0) {
    return [{ role: 'user', content: taskMessage }]
  }
  const copy = [...prefix]
  const last = copy.at(-1)
  if (last?.role === 'user') {
    if (typeof last.content === 'string') {
      copy[copy.length - 1] = { role: 'user', content: `${last.content}\n\n${taskMessage}` }
    } else {
      copy[copy.length - 1] = {
        role: 'user',
        content: [...last.content, { type: 'text', text: taskMessage }],
      }
    }
    return copy
  }
  return [...copy, { role: 'user', content: taskMessage }]
}

export type SpawnContext = {
  readonly sessionId: string
  readonly latestReminder?: string
  readonly forkPrefixMessages: () => MessageParam[]
  readonly getMessages: () => Message[]
  readonly isActive: () => boolean
  readonly saveFiles: (files: readonly { id: string; blob: Blob }[]) => Promise<void>
  readonly loadFile: (id: string) => Promise<Blob | undefined>
}

export type SubagentRuntime = {
  readonly snapshot: () => { agents: AgentRun[]; board: BoardPost[] }
  readonly hasRunning: () => boolean
  readonly runningCount: () => number
  readonly spawn: (call: ToolCallPart, ctx: SpawnContext) => ToolResult
  readonly postFromLead: (input: unknown) => ToolResult
  /** `defaultTimeoutS` replaces `waitDefaultTimeoutS` when the input names no `timeout_s`. */
  readonly wait: (
    input: unknown,
    replyBlocks: readonly ReplyBlock[],
    signal: AbortSignal,
    options?: { readonly defaultTimeoutS?: number }
  ) => Promise<ToolResult>
  readonly stopAll: (reason: 'user' | 'interrupted' | 'roundLimit') => Promise<void>
}

export const createSubagentRuntime = (options: {
  readonly initialReply: AssistantMessage
  readonly tools: ToolGateway
  readonly params: ConversationsParams
  readonly apiKey: () => string | null
  /** Called on live updates (`persist = false`) and step boundaries (`persist = true`). */
  readonly onSync: (agents: AgentRun[], board: BoardPost[], persist: boolean) => void
  /** Network retry policy for each child's requests; the store passes the lead's. */
  readonly retry?: RunAgentInput['retry']
}): SubagentRuntime => {
  const { tools, params, onSync } = options
  const runs = new Map<string, ManagedRun>()
  const undeliveredQueue: string[] = []
  let waiters: Array<() => void> = []

  const wakeWaiters = () => {
    const current = waiters
    waiters = []
    for (const wake of current) {
      wake()
    }
  }

  const snapshot = () => ({
    agents: [...runs.values()].map((entry) => entry.run),
    board: board.posts(),
  })

  const sync = (persist: boolean) => {
    const snap = snapshot()
    onSync(snap.agents, snap.board, persist)
  }

  const board = createMessageBoard(options.initialReply.board ?? [], params, (post) => {
    sync(true)
    if (post.kind === 'question') {
      wakeWaiters()
    }
  })

  // Hydrate any previously persisted runs (e.g. when resuming an interrupted reply).
  const priorWaitContents = options.initialReply.blocks
    .filter((b): b is ToolResultPart => b.type === 'tool_result' && b.status === 'ok')
    .filter((b) => {
      const call = options.initialReply.blocks.find(
        (u): u is ToolCallPart => u.type === 'tool_use' && u.id === b.tool_use_id
      )
      return call?.name === WAIT_TOOL_NAME
    })
    .map((b) => b.content)

  for (const existing of options.initialReply.agents ?? []) {
    // Board digests in a wait result also name the runId, so match the result heading itself.
    const heading = resultHeading(existing.runId)
    const alreadyReported = priorWaitContents.some((text) => text.includes(heading))
    const entry: ManagedRun = {
      run: existing,
      reportedToLead: alreadyReported,
    }
    const { state } = existing
    if (!alreadyReported && (state.status === 'finished' || state.status === 'exhausted')) {
      // A result that finished while no wait was collecting it (the lead was stopped or failed
      // mid-wait). Without a saved result there is nothing to deliver but the fact it was lost.
      entry.deliveredOutcome = existing.result
        ? {
            kind: 'completed',
            outcome: state.status,
            ...(state.status === 'exhausted' ? { limit: state.limit } : {}),
            content: existing.result.content,
            sources: existing.result.sources,
          }
        : {
            kind: 'failed',
            errorKind: 'protocol',
            message: 'The subagent ended, but its result was not saved.',
          }
      undeliveredQueue.push(existing.runId)
    } else if (!alreadyReported && existing.state.status === 'stopped') {
      entry.deliveredOutcome = { kind: 'stopped', reason: existing.state.reason }
      undeliveredQueue.push(existing.runId)
    } else if (!alreadyReported && existing.state.status === 'failed') {
      entry.deliveredOutcome = {
        kind: 'failed',
        errorKind: existing.state.error.kind,
        message: existing.state.error.message,
      }
      undeliveredQueue.push(existing.runId)
    }
    runs.set(existing.runId, entry)
  }

  const activeRunIds = () => {
    const set = new Set<string>()
    for (const [id, entry] of runs) {
      if (entry.run.state.status === 'running') {
        set.add(id)
      }
    }
    return set
  }

  const runningCount = () => activeRunIds().size

  const spawn = (call: ToolCallPart, ctx: SpawnContext): ToolResult => {
    const profile = tools.agentProfile(call.name)
    if (!profile) {
      return { content: `Unknown subagent profile: ${call.name}`, status: 'error' }
    }
    if (runningCount() >= params.maxRunningChildren) {
      return {
        content: `Cannot start subagent: running limit reached (maxRunningChildren = ${params.maxRunningChildren}). Wait for a running subagent to finish before starting another.`,
        status: 'error',
      }
    }
    if (runs.size >= params.maxChildrenPerReply) {
      return {
        content: `Cannot start subagent: per-reply limit reached (maxChildrenPerReply = ${params.maxChildrenPerReply}). Do not start more subagents in this reply.`,
        status: 'error',
      }
    }
    const builtTask = profile.task(call.input)
    if (builtTask.kind === 'invalid') {
      return { content: `Invalid subagent task: ${builtTask.reason}`, status: 'error' }
    }

    // Enforce read-only allow-list and depth 1 (runtime rule 2).
    const allowedToolNames = new Set<string>()
    const childTools: ClientTool[] = []
    for (const name of profile.tools) {
      if (tools.effectOf(name) !== 'read' || tools.kindOf(name) === 'subagent') {
        continue
      }
      const described = tools.describe(name, 'agent')
      if (described) {
        allowedToolNames.add(name)
        childTools.push(described)
      }
    }
    childTools.push(createChildPostTool(params))
    childTools.push(ensureSummaryParam(profile.finish))

    const orientation = buildSubagentOrientation({
      finishTool: profile.finish.name,
      maxPosts: params.maxPostsPerChild,
      maxPostChars: params.maxPostChars,
      maxToolCalls: profile.limits.maxToolCalls,
      maxRounds: profile.limits.maxRounds,
    })
    const toolSections = tools.instructions(allowedToolNames, 'agent')
    const system = [orientation, ...toolSections, profile.system]
      .filter((section) => section.trim().length > 0)
      .join('\n\n')

    const initialMessages: MessageParam[] =
      profile.context === 'fork'
        ? appendTaskToFork(ctx.forkPrefixMessages(), builtTask.message)
        : [
            ...(ctx.latestReminder
              ? [{ role: 'latest_reminder' as const, content: ctx.latestReminder }]
              : []),
            { role: 'user' as const, content: builtTask.message },
          ]

    const runId = `agent-${runs.size + 1}-${createId().slice(0, 6)}`
    const childController = new AbortController()
    const summary = getSummary(call.input)
    const entry: ManagedRun = {
      run: {
        runId,
        profile: call.name,
        label: profile.label ?? call.name,
        startedBy: call.id,
        ...(summary ? { summary } : {}),
        state: { status: 'running', round: 1 },
        blocks: [],
      },
      controller: childController,
      reportedToLead: false,
    }
    runs.set(runId, entry)
    sync(true)

    const runChildCalls = async (
      childCalls: ToolCallPart[],
      signal: AbortSignal
    ): Promise<ToolResultPart[]> => {
      const results: ToolResultPart[] = new Array(childCalls.length)
      const maxParallel = Math.max(1, params.maxParallelReadCalls)

      const executeChildCall = async (childCall: ToolCallPart, index: number) => {
        if (childCall.name === POST_TOOL_NAME) {
          const outcome = board.postFromChild(runId, childCall.input)
          results[index] = outcome.ok
            ? {
                type: 'tool_result',
                tool_use_id: childCall.id,
                content: `Posted ${outcome.post.kind} to the shared board.`,
                status: 'ok',
              }
            : {
                type: 'tool_result',
                tool_use_id: childCall.id,
                content: outcome.error,
                status: 'error',
              }
          return
        }
        if (
          !allowedToolNames.has(childCall.name) ||
          tools.effectOf(childCall.name) !== 'read' ||
          tools.kindOf(childCall.name) === 'subagent'
        ) {
          results[index] = {
            type: 'tool_result',
            tool_use_id: childCall.id,
            content: `Error: tool "${childCall.name}" is not allowed for subagent "${call.name}". Subagents may only use their read-only tools and "post".`,
            status: 'error',
          }
          return
        }
        const toolOutcome = await tools.run(childCall, {
          sessionId: ctx.sessionId,
          signal,
          caller: { kind: 'agent', profile: call.name, runId },
          ...(childCall.inputJson !== undefined ? { inputJson: childCall.inputJson } : {}),
          replyBlocks: entry.run.blocks,
          citedUrls: new Map(),
          messages: ctx.getMessages(),
          isActive: ctx.isActive,
          onPhase: () => undefined,
          saveFiles: ctx.saveFiles,
          loadFile: ctx.loadFile,
        })
        results[index] = {
          type: 'tool_result',
          tool_use_id: childCall.id,
          ...toolOutcome,
        }
      }

      // Run consecutive allowed read calls concurrently; post / disallowed calls run inline.
      for (let i = 0; i < childCalls.length; ) {
        if (signal.aborted) {
          break
        }
        const first = childCalls[i]
        const isAllowedRead =
          first.name !== POST_TOOL_NAME &&
          allowedToolNames.has(first.name) &&
          tools.effectOf(first.name) === 'read' &&
          tools.kindOf(first.name) !== 'subagent'
        if (!isAllowedRead) {
          await executeChildCall(first, i)
          i += 1
          continue
        }
        let end = i + 1
        while (end < childCalls.length) {
          const next = childCalls[end]
          const nextIsAllowedRead =
            next.name !== POST_TOOL_NAME &&
            allowedToolNames.has(next.name) &&
            tools.effectOf(next.name) === 'read' &&
            tools.kindOf(next.name) !== 'subagent'
          if (!nextIsAllowedRead) {
            break
          }
          end += 1
        }
        let cursor = i
        const segmentEnd = end
        i = end
        const workers = Math.min(maxParallel, segmentEnd - cursor)
        const worker = async () => {
          while (!signal.aborted) {
            const idx = cursor
            if (idx >= segmentEnd) {
              return
            }
            cursor += 1
            await executeChildCall(childCalls[idx], idx)
          }
        }
        await Promise.all(Array.from({ length: workers }, () => worker()))
      }

      for (let idx = 0; idx < childCalls.length; idx += 1) {
        if (!results[idx]) {
          results[idx] = {
            type: 'tool_result',
            tool_use_id: childCalls[idx].id,
            content: 'Aborted.',
            status: 'aborted',
          }
        }
      }
      return results
    }

    entry.promise = (async () => {
      const outcome = await runAgent({
        io: {
          ...createAgentIO(),
          apiKey: options.apiKey,
        },
        signal: childController.signal,
        request: {
          model: profile.model,
          system,
          thinking: profile.thinking,
          tools: childTools,
          messages: initialMessages,
        },
        finishTool: profile.finish.name,
        limits: profile.limits,
        ...(options.retry ? { retry: options.retry } : {}),
        runCalls: runChildCalls,
        inbox: () => formatBoardDigest(board.drainForAgent(runId)),
        onUpdate: (t, round) => {
          entry.run = {
            ...entry.run,
            state: { status: 'running', round: Math.max(1, round) },
            blocks: t.blocks,
            usage: t.usage ?? entry.run.usage,
          }
          sync(false)
        },
        onStep: (t, round) => {
          entry.run = {
            ...entry.run,
            state: { status: 'running', round: Math.max(1, round) },
            blocks: t.blocks,
            usage: t.usage ?? entry.run.usage,
          }
          sync(true)
        },
      })

      const trimmedBlocks = trimChildBlocks(
        outcome.transcript.blocks,
        params.childToolResultDisplayChars
      )

      if (outcome.kind === 'finished') {
        try {
          const completed = await profile.complete(outcome.output, { runId, outcome: 'finished' })
          entry.run = {
            ...entry.run,
            state: { status: 'finished' },
            blocks: trimmedBlocks,
            usage: outcome.transcript.usage ?? entry.run.usage,
            result: { content: completed.content, sources: completed.sources },
          }
          entry.deliveredOutcome = {
            kind: 'completed',
            outcome: 'finished',
            content: completed.content,
            sources: completed.sources,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          entry.run = {
            ...entry.run,
            state: { status: 'failed', error: { kind: 'protocol', message } },
            blocks: trimmedBlocks,
            usage: outcome.transcript.usage ?? entry.run.usage,
          }
          entry.deliveredOutcome = { kind: 'failed', errorKind: 'protocol', message }
        }
      } else if (outcome.kind === 'exhausted') {
        const rawOutput =
          outcome.output.kind === 'given'
            ? outcome.output.value
            : { answer: lastTextBlock(outcome.transcript.blocks), sources: [] }
        try {
          const completed = await profile.complete(rawOutput, { runId, outcome: 'exhausted' })
          entry.run = {
            ...entry.run,
            state: { status: 'exhausted', limit: outcome.limit },
            blocks: trimmedBlocks,
            usage: outcome.transcript.usage ?? entry.run.usage,
            result: { content: completed.content, sources: completed.sources },
          }
          entry.deliveredOutcome = {
            kind: 'completed',
            outcome: 'exhausted',
            limit: outcome.limit,
            content: completed.content,
            sources: completed.sources,
          }
        } catch (error) {
          const fallbackText = lastTextBlock(outcome.transcript.blocks)
          const message =
            fallbackText ||
            `Subagent reached its ${outcome.limit} limit without returning structured output (${error instanceof Error ? error.message : String(error)}).`
          entry.run = {
            ...entry.run,
            state: { status: 'exhausted', limit: outcome.limit },
            blocks: trimmedBlocks,
            usage: outcome.transcript.usage ?? entry.run.usage,
            result: { content: message, sources: [] },
          }
          entry.deliveredOutcome = {
            kind: 'completed',
            outcome: 'exhausted',
            limit: outcome.limit,
            content: message,
            sources: [],
          }
        }
      } else if (outcome.kind === 'failed') {
        entry.run = {
          ...entry.run,
          state: {
            status: 'failed',
            error: { kind: outcome.error.kind, message: outcome.error.message },
          },
          blocks: trimmedBlocks,
          usage: outcome.transcript.usage ?? entry.run.usage,
        }
        entry.deliveredOutcome = {
          kind: 'failed',
          errorKind: outcome.error.kind,
          message: outcome.error.message,
        }
      } else {
        const reason = entry.stopReasonOverride ?? 'user'
        entry.run = {
          ...entry.run,
          state: { status: 'stopped', reason },
          blocks: trimmedBlocks,
          usage: outcome.transcript.usage ?? entry.run.usage,
        }
        entry.deliveredOutcome = { kind: 'stopped', reason }
      }

      undeliveredQueue.push(runId)
      sync(true)
      wakeWaiters()
    })()

    return {
      content: `Started subagent "${runId}" (${call.name}). Call \`wait\` to collect its result or board updates.`,
      status: 'ok',
    }
  }

  const postFromLead = (input: unknown): ToolResult => {
    const known = new Set(runs.keys())
    const outcome = board.postFromLead(input, activeRunIds(), known)
    if (!outcome.ok) {
      return { content: outcome.error, status: 'error' }
    }
    const target =
      outcome.post.kind === 'direction'
        ? outcome.post.to.kind === 'all'
          ? 'all running subagents'
          : outcome.post.to.runId
        : 'board'
    return { content: `Posted direction to ${target}.`, status: 'ok' }
  }

  const wait = async (
    input: unknown,
    replyBlocks: readonly ReplyBlock[],
    signal: AbortSignal,
    waitOptions?: { readonly defaultTimeoutS?: number }
  ): Promise<ToolResult> => {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const until: 'any' | 'all' = record.until === 'all' ? 'all' : 'any'
    const rawTimeout =
      typeof record.timeout_s === 'number' &&
      Number.isFinite(record.timeout_s) &&
      record.timeout_s > 0
        ? record.timeout_s
        : (waitOptions?.defaultTimeoutS ?? params.waitDefaultTimeoutS)
    const timeoutMs = Math.max(1, Math.round(rawTimeout * 1000))

    const shouldWakeNow = () => {
      if (signal.aborted) {
        return true
      }
      if (until === 'all') {
        return runningCount() === 0
      }
      return undeliveredQueue.length > 0 || board.hasUnseenQuestionForLead() || runningCount() === 0
    }

    let timedOut = false
    if (!shouldWakeNow()) {
      await new Promise<void>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = () => {
          if (settled) {
            return
          }
          settled = true
          if (timer !== undefined) {
            clearTimeout(timer)
          }
          signal.removeEventListener('abort', onAbort)
          waiters = waiters.filter((w) => w !== check)
          resolve()
        }
        const onAbort = () => done()
        const check = () => {
          if (shouldWakeNow()) {
            done()
          } else {
            waiters.push(check)
          }
        }
        timer = setTimeout(() => {
          timedOut = true
          done()
        }, timeoutMs)
        signal.addEventListener('abort', onAbort, { once: true })
        waiters.push(check)
      })
    }

    if (signal.aborted) {
      return { content: 'Aborted.', status: 'aborted' }
    }

    const sections: string[] = []
    const unseenPosts = board.drainForLead()
    const boardText = formatBoardDigest(unseenPosts)
    if (boardText) {
      sections.push(boardText)
    }

    let citedUrls = collectCitedUrls(replyBlocks)
    const collectedSources: WebSearchSourceMeta[] = []
    const deliveredIds = undeliveredQueue.splice(0, undeliveredQueue.length)

    for (const runId of deliveredIds) {
      const entry = runs.get(runId)
      if (!entry || entry.reportedToLead) {
        continue
      }
      entry.reportedToLead = true
      const outcome = entry.deliveredOutcome
      if (!outcome) {
        continue
      }
      if (outcome.kind === 'completed') {
        const numbered = assignChildCitations(outcome.content, outcome.sources, citedUrls)
        citedUrls = numbered.citedUrls
        collectedSources.push(...numbered.searchResults)
        const statusLabel =
          outcome.outcome === 'finished'
            ? 'finished'
            : `exhausted (${outcome.limit ?? 'rounds'} limit)`
        sections.push(
          `${resultHeading(runId)}${entry.run.profile}) — ${statusLabel}\n${numbered.content}`
        )
      } else if (outcome.kind === 'failed') {
        sections.push(
          `${resultHeading(runId)}${entry.run.profile}) — failed (${outcome.errorKind})\n${outcome.message || 'Subagent request failed.'}`
        )
      } else {
        sections.push(
          `${resultHeading(runId)}${entry.run.profile}) — stopped (${outcome.reason})\nSubagent stopped before finishing (reason: ${outcome.reason}).`
        )
      }
    }

    const stillRunning = runningCount()
    if (timedOut && sections.length === 0) {
      sections.push(
        `Wait timed out after ${rawTimeout}s. ${stillRunning} subagent(s) still running.`
      )
    } else if (sections.length === 0) {
      sections.push(
        stillRunning === 0
          ? 'No subagents are running.'
          : `${stillRunning} subagent(s) still running.`
      )
    } else if (stillRunning > 0) {
      sections.push(`${stillRunning} subagent(s) still running.`)
    }

    return {
      content: sections.join('\n\n'),
      status: signal.aborted ? 'aborted' : 'ok',
      ...(collectedSources.length > 0 ? { searchResults: collectedSources } : {}),
    }
  }

  const stopAll = async (reason: 'user' | 'interrupted' | 'roundLimit') => {
    const pending: Promise<void>[] = []
    for (const entry of runs.values()) {
      if (entry.run.state.status === 'running' && entry.controller) {
        entry.stopReasonOverride = reason
        entry.controller.abort()
        if (entry.promise) {
          pending.push(entry.promise)
        }
      }
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending)
    }
  }

  return {
    snapshot,
    hasRunning: () => runningCount() > 0,
    runningCount,
    spawn,
    postFromLead,
    wait,
    stopAll,
  }
}
