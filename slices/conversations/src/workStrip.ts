import type { FrontStageNote, LiveTrack } from '@deepseek-chat/lib-tools'
import type { Locale } from '@deepseek-chat/spine/i18n'
import type { ReactNode } from 'react'
import { translate } from './messages.js'
import type { AssistantMessage } from './types.js'
import {
  getTotalThinkingSeconds,
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
  readonly callId?: string
  readonly lane?: string
  readonly icon?: ReactNode
  readonly label: string
  readonly status: 'running' | 'done' | 'failed'
  readonly errorText?: string
}

export type InlineTrace = {
  readonly items: readonly InlineTraceItem[]
  readonly thinkingMarkdown: string | null
  readonly hasRichDetails: boolean
}

export type InlineTracePreviewEntry = {
  readonly item: InlineTraceItem
  readonly gapBefore: boolean
}

export type InlineTracePreview = {
  readonly entries: readonly InlineTracePreviewEntry[]
  readonly hiddenCount: number
}

export const INLINE_TRACE_PREVIEW_LIMIT = 6

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

const formatTallies = (
  tallies: readonly TallyEntry[],
  maxItems = 3,
  locale?: Locale
): string | null => {
  const labels = tallies.slice(0, maxItems).map((entry) => entry.label(entry.count))
  if (labels.length === 0) {
    return null
  }
  if (labels.length === 1) {
    return labels[0]
  }
  if (labels.length === 2) {
    return `${labels[0]}${translate(locale, 'activityListPairSeparator')}${labels[1]}`
  }
  return `${labels.slice(0, -1).join(translate(locale, 'activityListSeparator'))}${translate(locale, 'activityListLastSeparator')}${labels.at(-1)}`
}

const liveHeadlineAndDetail = (
  view: ReplyView,
  tracks: readonly LiveTrack[],
  stalled: boolean,
  locale?: Locale
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
          ? translate(locale, 'activityLiveParallelCount', { count: runningTracks.length })
          : (trackStep?.summary?.liveVerb ?? translate(locale, 'replyWorking')),
      detail: null,
      waitingForUser: false,
    }
  }

  const active = [...view.steps]
    .reverse()
    .find((s) => !(s.type === 'tool' && s.summary?.hiddenInTimeline) && showsRunning(s))
  if (active?.type === 'tool') {
    return {
      headline: active.summary?.liveVerb ?? active.call.name,
      detail: active.rawSummary ?? active.summary?.detail ?? null,
      waitingForUser: Boolean(active.summary?.waitingForUser),
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
    headline: translate(locale, 'messageThinking'),
    detail:
      stalled && needsWorkingIndicator(view) ? translate(locale, 'replyWorking') : recentDetail,
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
  hasResponse: boolean,
  compacting = false,
  locale?: Locale
): TurnWorkStripState => {
  const hasSteps = view.steps.length > 0
  const thinkingEnabled = message.thinking ?? view.steps.some((step) => step.type === 'thinking')

  if (streaming && compacting) {
    if (!hasSteps) {
      return {
        mode: 'waiting',
        label: translate(locale, 'compactingConversation'),
      }
    }
    return {
      mode: 'live',
      headline: translate(locale, 'compactingConversation'),
      detail: null,
      liveTracks: [],
      overflowTracks: 0,
      waitingForUser: false,
      hasInspectableWork: true,
    }
  }

  if (!hasSteps) {
    if (streaming && !hasResponse) {
      return {
        mode: 'waiting',
        label: thinkingEnabled
          ? translate(locale, 'messageThinking')
          : translate(locale, 'replyWaiting'),
      }
    }
    return { mode: 'hidden' }
  }

  const { tallies, tracks, errorCount, hasToolWork } = collectMetrics(view)
  const anyToolRunning = view.steps.some((step) => showsRunning(step))

  if (streaming && (!hasResponse || anyToolRunning)) {
    const { headline, detail, waitingForUser } = liveHeadlineAndDetail(
      view,
      tracks,
      stalled,
      locale
    )
    const hasRunningTracks = tracks.some((t) => t.status === 'running')
    const orderedTracks = hasRunningTracks
      ? [
          ...tracks.filter((t) => t.status === 'running'),
          ...tracks.filter((t) => t.status !== 'running'),
        ]
      : []
    const liveTracks = orderedTracks.slice(0, MAX_LIVE_TRACKS)
    const overflowTracks = Math.max(0, orderedTracks.length - liveTracks.length)

    return {
      mode: 'live',
      headline,
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
  const workPhrase = formatTallies(tallies, 3, locale)

  let label: string
  if (stopped) {
    label = workPhrase
      ? translate(locale, 'activityStoppedAfter', { work: workPhrase })
      : translate(locale, 'messageThinkStopped')
  } else if (workPhrase) {
    label = workPhrase
  } else if (hasThinking) {
    label =
      thinkingSeconds !== null
        ? translate(
            locale,
            thinkingSeconds === 1 ? 'messageThinkDuration' : 'messageThinkDurationPlural',
            {
              count: thinkingSeconds,
            }
          )
        : translate(locale, 'thinkingSwitch')
  } else {
    const noteStep = [...view.steps]
      .reverse()
      .find((s): s is ToolStep => s.type === 'tool' && Boolean(s.result?.frontStageNote))
    if (noteStep?.result?.frontStageNote) {
      label =
        noteStep.result.frontStageNote.status === 'skipped'
          ? translate(locale, 'noteSkipped')
          : noteStep.rawSummary || translate(locale, 'noteAnswered')
    } else {
      label = translate(locale, 'activityPanelTitle')
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
        callId: step.call.id,
        ...(step.summary?.lane ? { lane: step.summary.lane } : {}),
        ...(step.summary?.icon !== undefined ? { icon: step.summary.icon } : {}),
        label,
        status,
        ...(errorText ? { errorText } : {}),
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

/**
 * Selects a bounded preview of inline trace steps in original chronological order.
 * Any currently running step is always retained so live progress is never hidden.
 */
export const selectInlineTracePreview = (
  items: readonly InlineTraceItem[],
  maxVisible = INLINE_TRACE_PREVIEW_LIMIT
): InlineTracePreview => {
  if (items.length <= maxVisible) {
    return {
      entries: items.map((item) => ({ item, gapBefore: false })),
      hiddenCount: 0,
    }
  }

  const selected = new Set<number>()
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].status === 'running') {
      selected.add(i)
    }
  }

  const remaining = Math.max(0, maxVisible - selected.size)
  let added = 0
  for (let i = 0; i < items.length && added < remaining; i += 1) {
    if (!selected.has(i)) {
      selected.add(i)
      added += 1
    }
  }

  const orderedIndices = [...selected].sort((a, b) => a - b)
  return {
    entries: orderedIndices.map((index, pos) => ({
      item: items[index],
      gapBefore: pos > 0 && index > orderedIndices[pos - 1] + 1,
    })),
    hiddenCount: items.length - orderedIndices.length,
  }
}
