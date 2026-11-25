import type { AgentIO, ClientTool, MessageParam } from '@deepseek-chat/lib-agent'
import {
  withSummaryParam,
  type CitedSourceMeta,
  type ToolCallRecord,
  type ToolRunContext,
  type ToolRunResult,
} from '@deepseek-chat/lib-tools'
import { createMessageBoard, formatBoardDigest } from './board.js'
import { assignChildCitations } from './citations.js'
import { runAgent, type AgentOutcome, type RunAgentInput } from './runAgent.js'
import { POST_TOOL_NAME, buildSubagentOrientation, createChildPostTool } from './tools.js'
import type {
  AgentRun,
  AgentRunResult,
  AgentRunState,
  ChildBlock,
  ChildToolResultBlock,
  ChildToolUseBlock,
  SubagentsParams,
  SubagentsReplyState,
  SubagentsToolHost,
} from './types.js'

type StopReason = Extract<AgentRunState, { status: 'stopped' }>['reason']
const STOP_REASONS: readonly StopReason[] = ['user', 'interrupted', 'roundLimit']

const stopReasonOf = (signal: AbortSignal): StopReason =>
  STOP_REASONS.find((reason) => reason === signal.reason) ?? 'user'

type ManagedRun = {
  run: AgentRun
  live?: { readonly controller: AbortController; readonly promise: Promise<void> }
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

const trimChildBlocks = (blocks: readonly ChildBlock[], maxChars: number): ChildBlock[] =>
  blocks.map((block) => {
    if (block.type !== 'tool_result' || block.content.length <= maxChars) {
      return block
    }
    return {
      ...block,
      content: `${block.content.slice(0, maxChars)}\n[Truncated for display]`,
    }
  })

const resultHeading = (runId: string) => `### Subagent ${runId} (`
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const lastTextBlock = (blocks: readonly ChildBlock[]): string => {
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

export type ReplySubagentRuntime = {
  readonly snapshot: () => SubagentsReplyState
  readonly hasRunning: () => boolean
  readonly runningCount: () => number
  readonly spawn: (call: ToolCallRecord, ctx: ToolRunContext) => ToolRunResult
  readonly postFromLead: (input: unknown) => ToolRunResult
  readonly wait: (
    input: unknown,
    ctx: ToolRunContext,
    options?: { readonly defaultTimeoutS?: number }
  ) => Promise<ToolRunResult>
  readonly stopAll: (reason: StopReason) => Promise<void>
}

export const settleHydratedSubagentsState = (state: SubagentsReplyState): SubagentsReplyState => ({
  ...state,
  agents: state.agents.map((agent) =>
    agent.state.status === 'running'
      ? { ...agent, state: { status: 'stopped', reason: 'interrupted' } }
      : agent
  ),
})

export const createReplySubagentRuntime = (options: {
  readonly initialState: SubagentsReplyState
  readonly deliveredRunIds?: ReadonlySet<string>
  readonly io: AgentIO
  readonly tools: SubagentsToolHost
  readonly params: SubagentsParams
  readonly onSync: (state: SubagentsReplyState, persist: boolean) => void
  readonly retry?: RunAgentInput['retry']
  readonly newId: () => string
}): ReplySubagentRuntime => {
  const { tools, params, onSync, newId } = options
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

  const snapshot = (): SubagentsReplyState => ({
    agents: [...runs.values()].map((entry) => entry.run),
    board: board.posts(),
  })

  const sync = (persist: boolean) => {
    onSync(snapshot(), persist)
  }

  const board = createMessageBoard(
    options.initialState.board,
    params,
    (post) => {
      sync(true)
      if (post.kind === 'question') {
        wakeWaiters()
      }
    },
    newId
  )

  for (const existing of options.initialState.agents) {
    const reportedToLead = options.deliveredRunIds?.has(existing.runId) ?? false
    runs.set(existing.runId, { run: existing, reportedToLead })
    if (!reportedToLead && existing.state.status !== 'running') {
      undeliveredQueue.push(existing.runId)
    }
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

  const spawn = (call: ToolCallRecord, ctx: ToolRunContext): ToolRunResult => {
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

    const allowedToolNames = new Set<string>()
    const childTools: ClientTool[] = []
    for (const name of profile.tools) {
      if (tools.effectOf(name) !== 'read' || tools.agentProfile(name) !== null) {
        continue
      }
      const described = tools.describe(name, 'agent')
      if (described) {
        allowedToolNames.add(name)
        childTools.push(described)
      }
    }
    childTools.push(createChildPostTool(params))
    childTools.push(withSummaryParam(profile.finish))

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

    const forkPrefix = (ctx.forkMessages?.() ?? []) as readonly MessageParam[]
    const initialMessages: MessageParam[] =
      profile.context === 'fork'
        ? appendTaskToFork(forkPrefix, builtTask.message)
        : [
            ...(ctx.latestReminder
              ? [{ role: 'latest_reminder' as const, content: ctx.latestReminder }]
              : []),
            { role: 'user' as const, content: builtTask.message },
          ]

    const runId = `agent-${runs.size + 1}-${newId().slice(0, 6)}`
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
      reportedToLead: false,
    }
    runs.set(runId, entry)
    sync(true)

    const runChildCalls = async (
      childCalls: ChildToolUseBlock[],
      signal: AbortSignal
    ): Promise<ChildToolResultBlock[]> => {
      const results: ChildToolResultBlock[] = new Array(childCalls.length)
      const maxParallel = Math.max(1, params.maxParallelReadCalls)

      const executeChildCall = async (childCall: ChildToolUseBlock, index: number) => {
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
          tools.agentProfile(childCall.name) !== null
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
          replyId: ctx.replyId,
          signal,
          caller: { kind: 'agent', profile: call.name, runId },
          ...(childCall.inputJson !== undefined ? { inputJson: childCall.inputJson } : {}),
          citedUrls: new Map(),
          isActive: ctx.isActive,
          onProgress: () => undefined,
          readReplyState: () => undefined,
          writeReplyState: () => undefined,
        })
        results[index] = {
          type: 'tool_result',
          tool_use_id: childCall.id,
          content: toolOutcome.content,
          status: toolOutcome.status,
          ...(toolOutcome.sources ? { sources: toolOutcome.sources } : {}),
          ...(toolOutcome.payload !== undefined ? { payload: toolOutcome.payload } : {}),
        }
      }

      for (let i = 0; i < childCalls.length; ) {
        if (signal.aborted) {
          break
        }
        const first = childCalls[i]
        const isAllowedRead =
          first.name !== POST_TOOL_NAME &&
          allowedToolNames.has(first.name) &&
          tools.effectOf(first.name) === 'read' &&
          tools.agentProfile(first.name) === null
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
            tools.agentProfile(next.name) === null
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

    const endStateOf = async (outcome: AgentOutcome): Promise<AgentRunState> => {
      switch (outcome.kind) {
        case 'finished':
          try {
            const result = await profile.complete(outcome.output, { runId, outcome: 'finished' })
            return { status: 'finished', result }
          } catch (error) {
            return { status: 'failed', error: { kind: 'protocol', message: messageOf(error) } }
          }
        case 'exhausted': {
          const lastText = lastTextBlock(outcome.transcript.blocks)
          const requestNote =
            outcome.output.kind === 'requestFailed'
              ? `(The request asking this subagent to finish failed: ${outcome.output.error.message || outcome.output.error.kind}.)`
              : null
          const rawOutput =
            outcome.output.kind === 'given'
              ? outcome.output.value
              : { answer: lastText, sources: [] }
          let result: AgentRunResult
          try {
            result = await profile.complete(rawOutput, { runId, outcome: 'exhausted' })
          } catch (error) {
            const readNote = `(Its final output could not be read: ${messageOf(error)}.)`
            result = { content: [lastText, readNote].filter(Boolean).join('\n\n'), sources: [] }
          }
          return {
            status: 'exhausted',
            limit: outcome.limit,
            result: requestNote
              ? { ...result, content: `${result.content}\n\n${requestNote}` }
              : result,
          }
        }
        case 'failed':
          return {
            status: 'failed',
            error: { kind: outcome.error.kind, message: outcome.error.message },
          }
        case 'stopped':
          return { status: 'stopped', reason: stopReasonOf(childController.signal) }
      }
    }

    const promise = (async () => {
      const outcome = await runAgent({
        io: options.io,
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

      entry.run = {
        ...entry.run,
        state: await endStateOf(outcome),
        blocks: trimChildBlocks(outcome.transcript.blocks, params.childToolResultDisplayChars),
        usage: outcome.transcript.usage ?? entry.run.usage,
      }
      undeliveredQueue.push(runId)
      sync(true)
      wakeWaiters()
    })()
    entry.live = { controller: childController, promise }

    return {
      content: `Started subagent "${runId}" (${call.name}). Call \`wait\` to collect its result or board updates.`,
      status: 'ok',
      payload: { kind: 'spawn', runId, profile: call.name },
    }
  }

  const postFromLead = (input: unknown): ToolRunResult => {
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
    return {
      content: `Posted direction to ${target}.`,
      status: 'ok',
      payload: { kind: 'post', post: outcome.post },
    }
  }

  const wait = async (
    input: unknown,
    ctx: ToolRunContext,
    waitOptions?: { readonly defaultTimeoutS?: number }
  ): Promise<ToolRunResult> => {
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
      if (ctx.signal.aborted) {
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
          ctx.signal.removeEventListener('abort', onAbort)
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
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        waiters.push(check)
      })
    }

    if (ctx.signal.aborted) {
      return { content: 'Aborted.', status: 'aborted' }
    }

    const sections: string[] = []
    const unseenPosts = board.drainForLead()
    const boardText = formatBoardDigest(unseenPosts)
    if (boardText) {
      sections.push(boardText)
    }

    let citedUrls = new Map(ctx.citedUrls)
    const collectedSources: CitedSourceMeta[] = []
    const deliveredIds = undeliveredQueue.splice(0, undeliveredQueue.length)

    for (const runId of deliveredIds) {
      const entry = runs.get(runId)
      if (!entry || entry.reportedToLead) {
        continue
      }
      entry.reportedToLead = true
      const heading = `${resultHeading(runId)}${entry.run.profile}) —`
      const { state } = entry.run
      switch (state.status) {
        case 'finished':
        case 'exhausted': {
          const numbered = assignChildCitations(
            state.result.content,
            state.result.sources,
            citedUrls
          )
          citedUrls = numbered.citedUrls
          collectedSources.push(...numbered.sources)
          const statusLabel =
            state.status === 'finished'
              ? 'finished'
              : state.limit === 'noFinishCall'
                ? 'exhausted (ended without calling its finish tool)'
                : `exhausted (${state.limit} limit)`
          sections.push(`${heading} ${statusLabel}\n${numbered.content}`)
          break
        }
        case 'failed':
          sections.push(
            `${heading} failed (${state.error.kind})\n${state.error.message || 'Subagent request failed.'}`
          )
          break
        case 'stopped':
          sections.push(
            `${heading} stopped (${state.reason})\nSubagent stopped before finishing (reason: ${state.reason}).`
          )
          break
        case 'running':
          throw new Error(`Subagent ${runId} was queued for delivery while still running.`)
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
      status: ctx.signal.aborted ? 'aborted' : 'ok',
      ...(collectedSources.length > 0 ? { sources: collectedSources } : {}),
      payload: { kind: 'wait', deliveredIds, until },
    }
  }

  const stopAll = async (reason: StopReason) => {
    const pending: Promise<void>[] = []
    for (const entry of runs.values()) {
      if (entry.run.state.status === 'running' && entry.live) {
        entry.live.controller.abort(reason)
        pending.push(entry.live.promise)
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
