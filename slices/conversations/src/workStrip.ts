import type { FrontStageNote, LiveTrack } from '@deepseek-chat/lib-tools'
import { translate } from './messages.js'
import type { AssistantMessage } from './types.js'
import {
  getTotalThinkingSeconds,
  isImageSearchKind,
  needsWorkingIndicator,
  showsRunning,
  type ReplyView,
  type Step,
  type ToolStep,
} from './view.js'

export type TurnWorkStripState =
  | { mode: 'hidden' }
  | { mode: 'waiting'; label: string }
  | {
      mode: 'live'
      headline: string
      tally: string | null
      detail: string | null
      liveTracks: LiveTrack[]
      overflowTracks: number
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

export type FrontStageNoteEntry = {
  readonly key: string
  readonly note: FrontStageNote
}

export type InlineTraceItem = {
  readonly key: string
  readonly label: string
  readonly status: 'running' | 'done' | 'failed'
  readonly errorText?: string
  readonly durationMs?: number
}

export type InlineTrace = {
  readonly items: readonly InlineTraceItem[]
  readonly thinkingMarkdown: string | null
  readonly hasRichDetails: boolean
}

const MAX_LIVE_TRACKS = 3

type TallyEntry = {
  count: number
  label: (count: number) => string
}

const collectMetrics = (view: ReplyView) => {
  const tallies = new Map<string, TallyEntry>()
  const tracksById = new Map<string, LiveTrack>()
  let errorCount = 0
  let hasToolWork = false

  const addTally = (key: string, count: number, label: (n: number) => string) => {
    const existing = tallies.get(key)
    if (existing) {
      existing.count += count
    } else {
      tallies.set(key, { count, label })
    }
  }

  for (const step of view.steps) {
    if (step.type === 'search') {
      hasToolWork = true
      addTally('server-search', Math.max(1, step.queries.length), (count) =>
        translate(count === 1 ? 'activityCountSearchOne' : 'activityCountSearchMany', { count })
      )
      if (step.status === 'failed') {
        errorCount += 1
      }
      continue
    }
    if (step.type === 'open') {
      hasToolWork = true
      addTally('server-page', step.pages.length, (count) =>
        translate(count === 1 ? 'activityCountPageOne' : 'activityCountPageMany', { count })
      )
      for (const page of step.pages) {
        if (page.status === 'failed') {
          errorCount += 1
        }
      }
      continue
    }
    if (step.type === 'find') {
      hasToolWork = true
      for (const item of step.patterns) {
        if (item.status === 'failed') {
          errorCount += 1
        }
      }
      continue
    }
    if (step.type === 'tool') {
      const { summary, result } = step
      if (summary?.tally) {
        addTally(summary.tally.key, summary.tally.count, summary.tally.label)
      }
      if (summary?.liveTracks) {
        for (const track of summary.liveTracks) {
          tracksById.set(track.id, track)
        }
      }
      const failed = summary
        ? Boolean(summary.failed)
        : Boolean(result && result.status !== 'ok' && result.status !== 'running')
      if (failed) {
        errorCount += 1
      }
      if (!summary?.hiddenInTimeline && !result?.frontStageNote) {
        hasToolWork = true
      }
    }
  }

  return {
    tallies: [...tallies.values()],
    tracks: [...tracksById.values()],
    errorCount,
    hasToolWork,
  }
}

const formatTallies = (tallies: readonly TallyEntry[], maxItems = 3): string | null => {
  if (tallies.length === 0) {
    return null
  }
  return tallies
    .slice(0, maxItems)
    .map((entry) => entry.label(entry.count))
    .join(translate('activityListSeparator'))
}

const liveHeadlineAndDetail = (
  view: ReplyView,
  tracks: readonly LiveTrack[],
  stalled: boolean
): { headline: string; detail: string | null; waitingForUser: boolean } => {
  const last = view.steps.at(-1)
  if (last?.type === 'tool' && last.summary?.waitingForUser && showsRunning(last)) {
    return {
      headline: last.summary.liveVerb,
      detail: last.rawSummary ?? last.summary.detail ?? null,
      waitingForUser: true,
    }
  }

  const runningTracks = tracks.filter((track) => track.status === 'running')
  if (runningTracks.length > 0) {
    const trackStep = [...view.steps]
      .reverse()
      .find((s): s is ToolStep => s.type === 'tool' && Boolean(s.summary?.liveTracks?.length))
    return {
      headline:
        runningTracks.length > 1
          ? translate('activityLiveParallel')
          : (trackStep?.summary?.liveVerb ?? translate('replyWorking')),
      detail: null,
      waitingForUser: false,
    }
  }

  const active = [...view.steps]
    .reverse()
    .find((s) => !(s.type === 'tool' && s.summary?.hiddenInTimeline) && showsRunning(s))
  if (active) {
    if (active.type === 'search') {
      return {
        headline: translate(
          isImageSearchKind(active.kind) ? 'imageSearching' : 'deepSearchSearching'
        ),
        detail: active.queries.at(-1) ?? null,
        waitingForUser: false,
      }
    }
    if (active.type === 'open') {
      const wipPage = [...active.pages].reverse().find((p) => p.status === 'wip')
      return {
        headline: translate('groupTitleToolOpen'),
        detail: wipPage?.title ?? null,
        waitingForUser: false,
      }
    }
    if (active.type === 'find') {
      return {
        headline: translate('groupTitleToolOpen'),
        detail: active.patterns.at(-1)?.pattern ?? null,
        waitingForUser: false,
      }
    }
    if (active.type === 'read_link') {
      return {
        headline: translate('readingLink'),
        detail: active.links.at(-1)?.title ?? null,
        waitingForUser: false,
      }
    }
    if (active.type === 'tool') {
      return {
        headline: active.summary?.liveVerb ?? active.call.name,
        detail: active.rawSummary ?? active.summary?.detail ?? null,
        waitingForUser: Boolean(active.summary?.waitingForUser),
      }
    }
  }

  let recentDetail: string | null = null
  for (let i = view.steps.length - 1; i >= 0; i -= 1) {
    const step: Step = view.steps[i]
    if (step.type === 'tool' && !step.summary?.hiddenInTimeline) {
      const text = step.rawSummary ?? step.summary?.detail
      if (text) {
        recentDetail = text
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
 * Pure Front Stage Turn Work Strip reducer, driven solely by `ToolStepPresenter.summarize`.
 * Bounded to at most 2 lines for sequential tools and 3 compact tracks (+ overflow) for parallel work.
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

  const { tallies, tracks, errorCount, hasToolWork } = collectMetrics(view)
  const anyToolRunning = view.steps.some((step) => showsRunning(step))

  if (streaming && (!hasResponse || anyToolRunning)) {
    const { headline, detail, waitingForUser } = liveHeadlineAndDetail(view, tracks, stalled)
    const hasRunningTracks = tracks.some((t) => t.status === 'running')
    const orderedTracks = hasRunningTracks
      ? [
          ...tracks.filter((t) => t.status === 'running'),
          ...tracks.filter((t) => t.status !== 'running'),
        ]
      : []
    const liveTracks = orderedTracks.slice(0, MAX_LIVE_TRACKS)
    const overflowTracks = Math.max(0, orderedTracks.length - liveTracks.length)
    const baseTally = formatTallies(tallies, 2)
    const tallyWithSources =
      liveTracks.length > 0 && view.sources.length > 0
        ? [
            baseTally,
            translate(
              view.sources.length === 1 ? 'activityCountSourceOne' : 'activityCountSourceMany',
              { count: view.sources.length }
            ),
          ]
            .filter(Boolean)
            .join(' · ')
        : baseTally

    return {
      mode: 'live',
      headline,
      tally: tallyWithSources,
      detail: liveTracks.length > 0 ? null : detail,
      liveTracks,
      overflowTracks,
      waitingForUser,
      hasInspectableWork: hasSteps,
    }
  }

  const stopped = !streaming && !hasResponse
  const hasThinking = view.steps.some((step) => step.type === 'thinking')
  const thinkingOnly = !hasToolWork && hasThinking
  const thinkingSeconds = hasThinking ? getTotalThinkingSeconds(view.steps, now) : null
  const workPhrase = formatTallies(tallies, 3)

  let label: string
  if (stopped) {
    label = workPhrase
      ? translate('activityStoppedAfter', { work: workPhrase })
      : translate('messageThinkStopped')
  } else if (workPhrase) {
    const pieces = [workPhrase]
    if (errorCount > 0) {
      pieces.push(
        translate(errorCount === 1 ? 'activityWithErrorsOne' : 'activityWithErrorsMany', {
          count: errorCount,
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
    const noteStep = [...view.steps]
      .reverse()
      .find((s): s is ToolStep => s.type === 'tool' && Boolean(s.result?.frontStageNote))
    if (noteStep?.result?.frontStageNote) {
      label =
        noteStep.result.frontStageNote.status === 'skipped'
          ? translate('noteSkipped')
          : noteStep.rawSummary || translate('noteAnswered')
    } else {
      label = translate('activityPanelTitle')
    }
  }

  return {
    mode: 'settled',
    label,
    stopped,
    errorCount,
    hasSources: view.sources.length > 0,
    thinkingOnly,
  }
}

/** Settled Front Stage notes emitted by any capability (e.g. answered clarifying questions). */
export const getFrontStageNotes = (view: ReplyView): FrontStageNoteEntry[] =>
  view.steps.flatMap((step) => {
    if (step.type !== 'tool' || !step.result?.frontStageNote) {
      return []
    }
    const note = step.result.frontStageNote
    if (note.status !== 'done' && note.status !== 'skipped') {
      return []
    }
    return [{ key: step.key, note }]
  })

const firstErrorLine = (content: string | undefined): string | undefined => {
  if (!content) {
    return undefined
  }
  const line = content
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean)
  if (!line) {
    return undefined
  }
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

const mapServerStatus = (status: 'wip' | 'done' | 'failed'): 'running' | 'done' | 'failed' =>
  status === 'wip' ? 'running' : status

/**
 * Pure Tier-1 inline trace projection for the expandable transcript inlay.
 * Domain-blind: derives plain-prose rows strictly from `ReplyView.steps`.
 */
export const buildInlineTrace = (view: ReplyView): InlineTrace => {
  const items: InlineTraceItem[] = []
  const thinkingParts: string[] = []

  for (const step of view.steps) {
    if (step.type === 'thinking') {
      const joined = step.blocks
        .map((block) => block.thinking.trim())
        .filter(Boolean)
        .join('\n\n')
      if (joined) {
        thinkingParts.push(joined)
      }
      continue
    }
    if (step.type === 'search') {
      const status = mapServerStatus(step.status)
      step.queries.forEach((query, index) => {
        const trimmed = query.trim()
        if (trimmed) {
          items.push({ key: `${step.key}-q-${index}`, label: trimmed, status })
        }
      })
      continue
    }
    if (step.type === 'open') {
      for (const page of step.pages) {
        const label = page.title || page.url
        if (label) {
          items.push({ key: page.id, label, status: mapServerStatus(page.status) })
        }
      }
      continue
    }
    if (step.type === 'read_link') {
      for (const link of step.links) {
        const label = link.title || link.url
        if (label) {
          items.push({ key: link.id, label, status: mapServerStatus(link.status) })
        }
      }
      continue
    }
    if (step.type === 'find') {
      for (const pattern of step.patterns) {
        if (pattern.pattern) {
          items.push({
            key: pattern.id,
            label: pattern.pattern,
            status: mapServerStatus(pattern.status),
          })
        }
      }
      continue
    }
    if (step.type === 'tool') {
      if (step.summary?.hiddenInTimeline || step.result?.frontStageNote) {
        continue
      }
      const running = showsRunning(step)
      const failed = step.summary
        ? Boolean(step.summary.failed)
        : Boolean(step.result && step.result.status !== 'ok' && step.result.status !== 'running')
      const status: InlineTraceItem['status'] = running ? 'running' : failed ? 'failed' : 'done'
      const label =
        step.rawSummary ?? step.summary?.detail ?? step.summary?.liveVerb ?? step.call.name
      const errorText = status === 'failed' ? firstErrorLine(step.result?.content) : undefined
      items.push({
        key: step.key,
        label,
        status,
        ...(errorText ? { errorText } : {}),
        ...(step.result?.durationMs !== undefined ? { durationMs: step.result.durationMs } : {}),
      })
    }
  }

  const thinkingMarkdown = thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null
  const hasRichDetails =
    items.length > 0 ||
    view.sources.length > 0 ||
    (thinkingMarkdown !== null && thinkingMarkdown.length > 600)

  return {
    items,
    thinkingMarkdown,
    hasRichDetails,
  }
}
