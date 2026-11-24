import { translate } from './messages.js'
import type { AssistantMessage, BoardPost, ThinkingPart } from './types.js'
import {
  getTotalThinkingSeconds,
  isImageSearchKind,
  needsWorkingIndicator,
  showsRunning,
  type AgentStep,
  type AskStep,
  type BrowserStep,
  type FileStep,
  type FindStep,
  type PageItem,
  type PythonStep,
  type ReplyView,
  type Source,
  type Step,
} from './view.js'

/** Coalesced, human-scannable phases rendered inside the right-hand Activity panel. */
export type ResearchPhase = {
  type: 'research'
  key: string
  queries: string[]
  pages: PageItem[]
  findPatterns: FindStep['patterns']
  searchCount: number
  sources: Source[]
  failedCount: number
}

export type SubagentsPhase = {
  type: 'subagents'
  key: string
  agents: AgentStep[]
  notes: BoardPost[]
}

export type ActivityPhase =
  | ResearchPhase
  | SubagentsPhase
  | { type: 'python'; key: string; step: PythonStep }
  | { type: 'browser'; key: string; step: BrowserStep }
  | { type: 'file'; key: string; step: FileStep }
  | { type: 'ask'; key: string; step: AskStep }
  | { type: 'preamble'; key: string; markdown: string }

export type ActivityTimeline = {
  phases: ActivityPhase[]
  thinkingBlocks: ThinkingPart[]
  thinkingSeconds: number | null
  thinkingOnly: boolean
  citedSources: Source[]
  otherSources: Source[]
}

export type LiveAgentTrack = {
  runId: string
  label: string
  detail: string | null
  status: AgentStep['state']['status']
}

export type TurnWorkStripState =
  | { mode: 'hidden' }
  | { mode: 'waiting'; label: string }
  | {
      mode: 'live'
      headline: string
      tally: string | null
      detail: string | null
      liveAgents: LiveAgentTrack[]
      overflowAgents: number
      waitingForUser: boolean
      hasInspectableWork: boolean
    }
  | {
      mode: 'settled'
      label: string
      stopped: boolean
      errorCount: number
      hasSources: boolean
      thinkingOnly: boolean
    }

const MAX_LIVE_AGENT_TRACKS = 3

const dedupePush = (list: string[], value: string) => {
  const trimmed = value.trim()
  if (trimmed && !list.includes(trimmed)) {
    list.push(trimmed)
  }
}

const isResearchStep = (step: Step) =>
  step.type === 'search' ||
  step.type === 'open' ||
  step.type === 'find' ||
  step.type === 'read_link'

/**
 * Pure reducer that transforms raw reply steps into coherent human phases for the Activity panel:
 * - Consecutive web search/open/find/read steps merge into one research phase even across hidden thinking blocks.
 * - Subagent runs group together with shared board notes attached; raw `wait` plumbing is folded out.
 * - Thinking blocks are collected cleanly so mixed turns don't drown tool steps in walls of prose.
 */
export const buildActivityTimeline = (view: ReplyView, now: number): ActivityTimeline => {
  const phases: ActivityPhase[] = []
  const thinkingBlocks: ThinkingPart[] = []
  const boardNotes: BoardPost[] = []

  for (const step of view.steps) {
    if (step.type === 'thinking') {
      thinkingBlocks.push(...step.blocks)
      continue
    }
    if (step.type === 'wait') {
      continue
    }
    if (step.type === 'board') {
      boardNotes.push(...step.posts)
      continue
    }
    if (isResearchStep(step)) {
      const prev = phases.at(-1)
      let phase: ResearchPhase
      if (prev?.type === 'research') {
        phase = prev
      } else {
        phase = {
          type: 'research',
          key:
            step.type === 'search'
              ? step.key
              : step.type === 'open'
                ? `open-${step.pages[0]?.id ?? phases.length}`
                : step.type === 'find'
                  ? `find-${step.patterns[0]?.id ?? phases.length}`
                  : `read-${step.links[0]?.id ?? phases.length}`,
          queries: [],
          pages: [],
          findPatterns: [],
          searchCount: 0,
          sources: [],
          failedCount: 0,
        }
        phases.push(phase)
      }

      if (step.type === 'search') {
        phase.searchCount += Math.max(1, step.queries.length)
        for (const q of step.queries) {
          dedupePush(phase.queries, q)
        }
        for (const source of step.results) {
          if (!phase.sources.some((s) => s.url === source.url)) {
            phase.sources.push(source)
          }
        }
        if (step.status === 'failed') {
          phase.failedCount += 1
        }
      } else if (step.type === 'open') {
        for (const page of step.pages) {
          if (!phase.pages.some((p) => p.url === page.url)) {
            phase.pages.push(page)
          }
          if (page.status === 'failed') {
            phase.failedCount += 1
          }
        }
      } else if (step.type === 'find') {
        phase.findPatterns.push(...step.patterns)
        for (const item of step.patterns) {
          if (item.status === 'failed') {
            phase.failedCount += 1
          }
        }
      } else if (step.type === 'read_link') {
        for (const link of step.links) {
          if (!phase.pages.some((p) => p.url === link.url)) {
            phase.pages.push(link)
          }
        }
      }
      continue
    }

    if (step.type === 'agent') {
      const prev = phases.at(-1)
      if (prev?.type === 'subagents') {
        prev.agents.push(step)
      } else {
        phases.push({
          type: 'subagents',
          key: `subagents-${step.key}`,
          agents: [step],
          notes: [],
        })
      }
      continue
    }

    if (step.type === 'python') {
      phases.push({ type: 'python', key: step.key, step })
      continue
    }
    if (step.type === 'browser') {
      phases.push({ type: 'browser', key: step.key, step })
      continue
    }
    if (step.type === 'file') {
      phases.push({ type: 'file', key: step.key, step })
      continue
    }
    if (step.type === 'ask') {
      phases.push({ type: 'ask', key: step.key, step })
      continue
    }
    if (step.type === 'text') {
      phases.push({ type: 'preamble', key: step.key, markdown: step.markdown })
    }
  }

  if (boardNotes.length > 0) {
    const subagentsPhase = [...phases].reverse().find((p) => p.type === 'subagents')
    if (subagentsPhase && subagentsPhase.type === 'subagents') {
      subagentsPhase.notes.push(...boardNotes)
    } else {
      phases.push({
        type: 'subagents',
        key: `board-${boardNotes.length}`,
        agents: [],
        notes: boardNotes,
      })
    }
  }

  const byIndex = new Map(view.sources.map((source) => [source.index, source]))
  const citedSet = new Set(view.citedSourceIndexes)
  const citedSources: Source[] = []
  for (const idx of view.citedSourceIndexes) {
    const found = byIndex.get(idx)
    if (found) {
      citedSources.push(found)
    }
  }
  const otherSources = view.sources.filter((source) => !citedSet.has(source.index))

  const thinkingSeconds =
    thinkingBlocks.length > 0 ? getTotalThinkingSeconds(view.steps, now) : null

  return {
    phases,
    thinkingBlocks,
    thinkingSeconds,
    thinkingOnly: phases.length === 0 && thinkingBlocks.length > 0,
    citedSources,
    otherSources,
  }
}

type WorkMetrics = {
  searchCount: number
  pagesRead: number
  pythonCount: number
  browserActions: number
  fileCount: number
  agentCount: number
  errorCount: number
}

const collectWorkMetrics = (view: ReplyView): WorkMetrics => {
  let searchCount = 0
  const readUrls = new Set<string>()
  let pythonCount = 0
  let browserActions = 0
  const touchedFiles = new Set<string>()
  let agentCount = 0
  let errorCount = 0

  for (const step of view.steps) {
    switch (step.type) {
      case 'search':
        searchCount += Math.max(1, step.queries.length)
        if (step.status === 'failed') {
          errorCount += 1
        }
        break
      case 'open':
        for (const page of step.pages) {
          readUrls.add(page.url || page.id)
          if (page.status === 'failed') {
            errorCount += 1
          }
        }
        break
      case 'find':
        for (const item of step.patterns) {
          if (item.status === 'failed') {
            errorCount += 1
          }
        }
        break
      case 'python':
        pythonCount += 1
        if (step.result?.status === 'error') {
          errorCount += 1
        }
        break
      case 'browser':
        browserActions += step.actions.length
        if (step.status === 'failed') {
          errorCount += 1
        }
        break
      case 'file':
        for (const action of step.actions) {
          touchedFiles.add(action.path || action.id)
          if (action.status === 'failed') {
            errorCount += 1
          }
        }
        break
      case 'agent':
        agentCount += 1
        if (step.state.status === 'failed') {
          errorCount += 1
        }
        break
      case 'thinking':
      case 'text':
      case 'read_link':
      case 'ask':
      case 'wait':
      case 'board':
        break
    }
  }

  return {
    searchCount,
    pagesRead: readUrls.size,
    pythonCount,
    browserActions,
    fileCount: touchedFiles.size,
    agentCount,
    errorCount,
  }
}

const formatLiveTally = (metrics: WorkMetrics, sourceCount: number): string | null => {
  const parts: string[] = []
  if (metrics.agentCount > 0) {
    parts.push(
      translate(metrics.agentCount === 1 ? 'activityCountAgentOne' : 'activityCountAgentMany', {
        count: metrics.agentCount,
      })
    )
    if (sourceCount > 0) {
      parts.push(
        translate(sourceCount === 1 ? 'activityCountSourceOne' : 'activityCountSourceMany', {
          count: sourceCount,
        })
      )
    }
    return parts.join(' · ')
  }
  if (metrics.searchCount > 0) {
    parts.push(
      translate(metrics.searchCount === 1 ? 'activityCountSearchOne' : 'activityCountSearchMany', {
        count: metrics.searchCount,
      })
    )
  }
  if (metrics.pagesRead > 0) {
    parts.push(
      translate(metrics.pagesRead === 1 ? 'activityCountPageOne' : 'activityCountPageMany', {
        count: metrics.pagesRead,
      })
    )
  }
  if (parts.length > 0) {
    return parts.join(translate('activityListSeparator'))
  }
  if (metrics.fileCount > 0) {
    return translate(
      metrics.fileCount === 1 ? 'activitySettledFilesOne' : 'activitySettledFilesMany',
      { count: metrics.fileCount }
    )
  }
  if (metrics.browserActions > 0) {
    return translate(
      metrics.browserActions === 1 ? 'activitySettledBrowsedOne' : 'activitySettledBrowsedMany',
      { count: metrics.browserActions }
    )
  }
  return null
}

const formatSettledWorkPhrase = (metrics: WorkMetrics): string | null => {
  const parts: string[] = []
  const add = (first: string, rest: string) => {
    parts.push(parts.length === 0 ? first : rest)
  }

  if (metrics.agentCount > 0) {
    add(
      translate(
        metrics.agentCount === 1 ? 'activitySettledAgentsOneCap' : 'activitySettledAgentsManyCap',
        { count: metrics.agentCount }
      ),
      translate(
        metrics.agentCount === 1 ? 'activitySettledAgentsOne' : 'activitySettledAgentsMany',
        { count: metrics.agentCount }
      )
    )
  } else {
    if (metrics.searchCount > 0) {
      add(
        translate(
          metrics.searchCount === 1 ? 'activitySettledSearchedOne' : 'activitySettledSearchedMany',
          { count: metrics.searchCount }
        ),
        translate(
          metrics.searchCount === 1 ? 'activitySettledSearchedOne' : 'activitySettledSearchedMany',
          { count: metrics.searchCount }
        ).toLowerCase()
      )
    }
    if (metrics.pagesRead > 0) {
      add(
        translate(
          metrics.pagesRead === 1 ? 'activitySettledReadOneCap' : 'activitySettledReadManyCap',
          { count: metrics.pagesRead }
        ),
        translate(metrics.pagesRead === 1 ? 'activitySettledReadOne' : 'activitySettledReadMany', {
          count: metrics.pagesRead,
        })
      )
    }
  }

  if (metrics.pythonCount > 0) {
    add(
      translate(
        metrics.pythonCount === 1 ? 'activitySettledPythonOneCap' : 'activitySettledPythonManyCap',
        { count: metrics.pythonCount }
      ),
      translate(
        metrics.pythonCount === 1 ? 'activitySettledPythonOne' : 'activitySettledPythonMany',
        { count: metrics.pythonCount }
      )
    )
  }

  if (metrics.browserActions > 0 && parts.length < 3) {
    add(
      translate(
        metrics.browserActions === 1
          ? 'activitySettledBrowsedOneCap'
          : 'activitySettledBrowsedManyCap',
        { count: metrics.browserActions }
      ),
      translate(
        metrics.browserActions === 1 ? 'activitySettledBrowsedOne' : 'activitySettledBrowsedMany',
        { count: metrics.browserActions }
      )
    )
  }

  if (metrics.fileCount > 0 && parts.length < 3) {
    add(
      translate(
        metrics.fileCount === 1 ? 'activitySettledFilesOneCap' : 'activitySettledFilesManyCap',
        { count: metrics.fileCount }
      ),
      translate(metrics.fileCount === 1 ? 'activitySettledFilesOne' : 'activitySettledFilesMany', {
        count: metrics.fileCount,
      })
    )
  }

  return parts.length > 0 ? parts.join(translate('activityListSeparator')) : null
}

const liveHeadlineAndDetail = (
  view: ReplyView,
  stalled: boolean
): { headline: string; detail: string | null; waitingForUser: boolean } => {
  const agents = view.steps.filter((s): s is AgentStep => s.type === 'agent')
  const runningAgents = agents.filter((a) => a.state.status === 'running')
  const last = view.steps.at(-1)

  if (last?.type === 'ask' && last.status === 'wip') {
    return {
      headline: translate('askWaiting'),
      detail: last.summary ?? null,
      waitingForUser: true,
    }
  }

  if (runningAgents.length > 0) {
    return {
      headline:
        runningAgents.length > 1 ? translate('activityLiveParallel') : translate('agentRunning'),
      detail: null,
      waitingForUser: false,
    }
  }

  const active = [...view.steps].reverse().find((s) => s.type !== 'wait' && showsRunning(s))
  if (active) {
    switch (active.type) {
      case 'search':
        return {
          headline: translate(
            isImageSearchKind(active.kind) ? 'imageSearching' : 'deepSearchSearching'
          ),
          detail: active.summary ?? active.queries.at(-1) ?? null,
          waitingForUser: false,
        }
      case 'open': {
        const wipPage = [...active.pages].reverse().find((p) => p.status === 'wip')
        return {
          headline: translate('groupTitleToolOpen'),
          detail: wipPage?.summary ?? wipPage?.title ?? null,
          waitingForUser: false,
        }
      }
      case 'find':
        return {
          headline: translate('groupTitleToolOpen'),
          detail: active.patterns.at(-1)?.pattern ?? null,
          waitingForUser: false,
        }
      case 'read_link':
        return {
          headline: translate('readingLink'),
          detail: active.links.at(-1)?.title ?? null,
          waitingForUser: false,
        }
      case 'python': {
        const phase = active.result?.phase
        const headline =
          phase === 'installing'
            ? translate('pythonInstalling')
            : phase === 'starting'
              ? translate('pythonStarting')
              : translate('pythonRunning')
        return {
          headline,
          detail: active.summary ?? null,
          waitingForUser: false,
        }
      }
      case 'browser':
        return {
          headline: translate('activityLiveBrowsing'),
          detail: active.actions.at(-1)?.summary ?? null,
          waitingForUser: false,
        }
      case 'file': {
        const lastAction = active.actions.at(-1)
        const name = lastAction?.title || lastAction?.path || ''
        const fallback =
          lastAction?.tool === 'edit_file'
            ? translate('previewToolEditing', { name })
            : lastAction?.tool === 'read_file'
              ? translate('previewToolReading', { name })
              : translate('previewToolPresenting', { name })
        return {
          headline: translate('activityLiveUpdatingFiles'),
          detail: lastAction?.summary ?? (name ? fallback : null),
          waitingForUser: false,
        }
      }
      case 'ask':
        return {
          headline: translate('askWaiting'),
          detail: active.summary ?? null,
          waitingForUser: true,
        }
      case 'agent':
      case 'wait':
      case 'thinking':
      case 'text':
      case 'board':
        break
    }
  }

  // Between tool rounds or thinking: show most recent completed tool summary or Working… on stall.
  let recentDetail: string | null = null
  for (let i = view.steps.length - 1; i >= 0; i -= 1) {
    const step = view.steps[i]
    if (step.type === 'search' && step.summary) {
      recentDetail = step.summary
      break
    }
    if (step.type === 'open') {
      const s = [...step.pages].reverse().find((p) => p.summary)?.summary
      if (s) {
        recentDetail = s
        break
      }
    }
    if (step.type === 'python' && step.summary) {
      recentDetail = step.summary
      break
    }
    if (step.type === 'browser') {
      const s = step.actions.at(-1)?.summary
      if (s) {
        recentDetail = s
        break
      }
    }
    if (step.type === 'file') {
      const s = step.actions.at(-1)?.summary
      if (s) {
        recentDetail = s
        break
      }
    }
  }

  return {
    headline: translate('messageThinking'),
    detail: stalled && needsWorkingIndicator(view) ? translate('replyWorking') : recentDetail,
    waitingForUser: false,
  }
}

/**
 * Pure state machine for the Front Stage Turn Work Strip:
 * - Bounded 2-line live ticker while working (<= 4 compact lines for parallel subagents).
 * - Folds automatically into 1 quiet summary line once the answer streams or finishes.
 */
export const buildTurnWorkStrip = (
  message: AssistantMessage,
  view: ReplyView,
  streaming: boolean,
  now: number,
  stalled: boolean,
  hasResponse: boolean
): TurnWorkStripState => {
  const hasSteps = view.steps.length > 0
  const thinkingEnabled = message.thinking ?? view.steps.some((step) => step.type === 'thinking')

  if (!hasSteps) {
    if (streaming && !hasResponse) {
      return {
        mode: 'waiting',
        label: thinkingEnabled ? translate('messageThinking') : translate('replyWaiting'),
      }
    }
    return { mode: 'hidden' }
  }

  const metrics = collectWorkMetrics(view)
  const anyToolRunning = view.steps.some((step) => showsRunning(step))

  if (streaming && (!hasResponse || anyToolRunning)) {
    const { headline, detail, waitingForUser } = liveHeadlineAndDetail(view, stalled)
    const agents = view.steps.filter((s): s is AgentStep => s.type === 'agent')
    const hasRunningAgents = agents.some((a) => a.state.status === 'running')
    const orderedAgents = hasRunningAgents
      ? [
          ...agents.filter((a) => a.state.status === 'running'),
          ...agents.filter((a) => a.state.status !== 'running'),
        ]
      : []
    const liveAgents: LiveAgentTrack[] = orderedAgents
      .slice(0, MAX_LIVE_AGENT_TRACKS)
      .map((agent) => ({
        runId: agent.runId,
        label: agent.summary || agent.label,
        detail:
          agent.state.status === 'running'
            ? (agent.latestStep ?? translate('agentRunning'))
            : agent.state.status === 'finished'
              ? translate('agentFinished')
              : agent.state.status === 'exhausted'
                ? translate('agentExhausted')
                : agent.state.status === 'failed'
                  ? translate('agentFailed')
                  : translate('agentStopped'),
        status: agent.state.status,
      }))
    const overflowAgents = Math.max(0, orderedAgents.length - liveAgents.length)

    return {
      mode: 'live',
      headline,
      tally: formatLiveTally(metrics, view.sources.length),
      detail: liveAgents.length > 0 ? null : detail,
      liveAgents,
      overflowAgents,
      waitingForUser,
      hasInspectableWork: hasSteps,
    }
  }

  // Settled state (answer started/finished, or turn stopped/failed).
  const stopped = !streaming && !hasResponse
  const hasToolWork =
    metrics.searchCount > 0 ||
    metrics.pagesRead > 0 ||
    metrics.pythonCount > 0 ||
    metrics.browserActions > 0 ||
    metrics.fileCount > 0 ||
    metrics.agentCount > 0
  const hasThinking = view.steps.some((step) => step.type === 'thinking')
  const thinkingOnly = !hasToolWork && hasThinking
  const thinkingSeconds = hasThinking ? getTotalThinkingSeconds(view.steps, now) : null
  const workPhrase = formatSettledWorkPhrase(metrics)

  let label: string
  if (stopped) {
    label = workPhrase
      ? translate('activityStoppedAfter', { work: workPhrase.toLowerCase() })
      : translate('messageThinkStopped')
  } else if (workPhrase) {
    const pieces = [workPhrase]
    if (metrics.errorCount > 0) {
      pieces.push(
        translate(metrics.errorCount === 1 ? 'activityWithErrorsOne' : 'activityWithErrorsMany', {
          count: metrics.errorCount,
        })
      )
    }
    if (thinkingSeconds !== null) {
      pieces.push(translate('activityDurationShort', { count: thinkingSeconds }))
    }
    label = pieces.join(' · ')
  } else if (hasThinking) {
    label =
      thinkingSeconds !== null
        ? translate(thinkingSeconds === 1 ? 'messageThinkDuration' : 'messageThinkDurationPlural', {
            count: thinkingSeconds,
          })
        : translate('thinkingSwitch')
  } else {
    // Only ask_user or preamble text steps.
    const askStep = [...view.steps].reverse().find((s): s is AskStep => s.type === 'ask')
    if (askStep) {
      label =
        askStep.askAction?.status === 'skipped'
          ? translate('askSkipped')
          : askStep.summary || translate('askAnswered')
    } else {
      label = translate('activityPanelTitle')
    }
  }

  return {
    mode: 'settled',
    label,
    stopped,
    errorCount: metrics.errorCount,
    hasSources: view.sources.length > 0,
    thinkingOnly,
  }
}

/** Settled clarifying questions that stay visible Front Stage as part of the conversation. */
export const getFrontStageAsks = (view: ReplyView): AskStep[] =>
  view.steps.filter(
    (step): step is AskStep =>
      step.type === 'ask' &&
      step.status !== 'wip' &&
      Boolean(
        step.askAction &&
        (step.askAction.status === 'answered' || step.askAction.status === 'skipped')
      )
  )
