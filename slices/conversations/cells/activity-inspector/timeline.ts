import type {
  ActivityStepEntry,
  DeliveredFileRef,
  ToolStepPresenter,
  ToolStepSummary,
  ToolStepVisualArtifact,
} from '@deepseek-chat/lib-tools'
import type { Locale } from '@deepseek-chat/spine/i18n'
import type { ThinkingPart, ToolResultPart } from '../../kernel/index.js'
import { activityInspectorMessages } from './messages.js'
import { extractTurnSources, type ExtractedTurnSources } from './sources.js'
import type { TurnSnapshot } from './types.js'

export type ActivityThinkingRound = {
  readonly key: string
  readonly index: number
  readonly markdown: string
  readonly seconds: number | null
  readonly nextStepCallId: string | null
  readonly nextStepLabel: string | null
}

export type ActivityFailedStep = {
  readonly callId: string
  readonly label: string
  readonly preview: string | null
}

export type ActivityStepRecord = {
  readonly entry: ActivityStepEntry
  readonly callId: string
  readonly label: string
  readonly status: 'running' | 'ok' | 'error'
  readonly summary: ToolStepSummary | null
  readonly visuals: readonly ToolStepVisualArtifact[]
  readonly hasDetail: boolean
  readonly precedingNote?: string
  readonly errorPreview?: string
}

export type ActivityLanePhase = {
  readonly type: 'lane'
  readonly key: string
  readonly lane: string
  readonly capabilityId: string | undefined
  readonly presenter: ToolStepPresenter | null
  readonly entries: ActivityStepEntry[]
  readonly items: ActivityStepRecord[]
}

export type ActivityTimelinePhase = ActivityLanePhase

export type ActivityVisualItem = {
  readonly key: string
  readonly callId: string
  readonly stepLabel: string
  readonly src: string
  readonly alt: string
  readonly caption?: string
  readonly href?: string
}

export type ActivityFileItem = {
  readonly key: string
  readonly callId: string
  readonly file: DeliveredFileRef
}

export type ActivityTimeline = {
  readonly phases: ActivityTimelinePhase[]
  readonly thinkingBlocks: ThinkingPart[]
  readonly thinkingRounds: readonly ActivityThinkingRound[]
  readonly thinkingSeconds: number | null
  readonly completedThinkingMs: number
  readonly activeThinkingStartedAt: number | null
  readonly thinkingOnly: boolean
  readonly sources: ExtractedTurnSources
  readonly stepCount: number
  readonly errorCount: number
  readonly failedSteps: readonly ActivityFailedStep[]
  readonly tallyLabel: string | null
  readonly files: readonly ActivityFileItem[]
  readonly visuals: readonly ActivityVisualItem[]
}

type TallyEntry = {
  count: number
  label: (count: number) => string
}

type MutableThinkingRound = {
  key: string
  index: number
  markdown: string
  seconds: number | null
  nextStepCallId: string | null
  nextStepLabel: string | null
}

const readCallSummary = (input: unknown, inputJson: string | undefined): string => {
  if (input && typeof input === 'object' && 'summary' in input) {
    const value = (input as { summary?: unknown }).summary
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/\s+/g, ' ').trim()
    }
  }
  if (!inputJson) {
    return ''
  }
  try {
    const parsed = JSON.parse(inputJson) as unknown
    if (parsed && typeof parsed === 'object' && 'summary' in parsed) {
      const value = (parsed as { summary?: unknown }).summary
      if (typeof value === 'string' && value.trim()) {
        return value.replace(/\s+/g, ' ').trim()
      }
    }
  } catch {
    const match = /(?:^|[{,])\s*"summary"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(inputJson)
    if (match) {
      try {
        const decoded: unknown = JSON.parse(`"${match[1]}"`)
        if (typeof decoded === 'string' && decoded.trim()) {
          return decoded.replace(/\s+/g, ' ').trim()
        }
      } catch {
        return ''
      }
    }
  }
  return ''
}

const firstErrorLine = (content: string | undefined): string | null => {
  if (!content) {
    return null
  }
  const line = content
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean)
  if (!line) {
    return null
  }
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

const blockDurationSeconds = (block: ThinkingPart, now: number): number | null => {
  if (block.startedAt !== undefined) {
    const end = block.endedAt ?? now
    return Math.max(1, Math.round(Math.max(0, end - block.startedAt) / 1000))
  }
  if (block.elapsedSeconds !== undefined) {
    return Math.max(1, Math.round(Math.max(0, block.elapsedSeconds)))
  }
  return null
}

const computeThinkingTiming = (blocks: readonly ThinkingPart[], now: number) => {
  let completedMs = 0
  let totalMs = 0
  let hasDuration = false
  let activeStartedAt: number | null = null

  for (const block of blocks) {
    if (block.startedAt !== undefined) {
      hasDuration = true
      if (block.endedAt !== undefined) {
        const delta = Math.max(0, block.endedAt - block.startedAt)
        completedMs += delta
        totalMs += delta
      } else {
        activeStartedAt = block.startedAt
        totalMs += Math.max(0, now - block.startedAt)
      }
    } else if (block.elapsedSeconds !== undefined) {
      hasDuration = true
      const delta = Math.max(0, block.elapsedSeconds) * 1000
      completedMs += delta
      totalMs += delta
    }
  }

  return {
    thinkingSeconds: hasDuration ? Math.max(1, Math.round(totalMs / 1000)) : null,
    completedThinkingMs: completedMs,
    activeThinkingStartedAt: activeStartedAt,
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
    return labels[0] ?? null
  }
  if (labels.length === 2) {
    return `${labels[0]}${activityInspectorMessages.translate(locale, 'listPairSeparator')}${labels[1]}`
  }
  return `${labels.slice(0, -1).join(activityInspectorMessages.translate(locale, 'listSeparator'))}${activityInspectorMessages.translate(locale, 'listLastSeparator')}${labels.at(-1)}`
}

const collectStepVisuals = (
  label: string,
  summary: ToolStepSummary | null,
  result: ToolResultPart | undefined
): readonly ToolStepVisualArtifact[] => {
  if (summary?.visuals && summary.visuals.length > 0) {
    return summary.visuals
  }
  const raw = result?.previewImages?.length ? result.previewImages : (result?.images ?? [])
  if (raw.length === 0) {
    return []
  }
  return raw.map((src) => ({ src, alt: label, caption: label }))
}

/**
 * Pure reducer turning a turn snapshot into chronological, capability-agnostic Activity phases,
 * unified step records (with inter-tool narration folded into `precedingNote`), round-linked
 * reasoning, promoted failed-step summaries, and extracted visual artifacts.
 */
export const buildActivityTimeline = (
  turn: TurnSnapshot,
  getPresenter: (capabilityId: string | undefined, toolName: string) => ToolStepPresenter | null,
  now = Date.now(),
  locale?: Locale
): ActivityTimeline => {
  const toolResults = new Map<string, ToolResultPart>()
  for (const block of turn.blocks) {
    if (block.type === 'tool_result') {
      toolResults.set(block.tool_use_id, block)
    }
  }

  const phases: ActivityTimelinePhase[] = []
  const thinkingBlocks: ThinkingPart[] = []
  const thinkingRounds: MutableThinkingRound[] = []
  const pendingThinkingRounds: MutableThinkingRound[] = []
  const tallies = new Map<string, TallyEntry>()
  const filesByKey = new Map<string, ActivityFileItem>()
  const visuals: ActivityVisualItem[] = []
  const failedSteps: ActivityFailedStep[] = []
  let pendingText: string[] = []
  let stepCount = 0
  let errorCount = 0

  const addTally = (key: string, count: number, label: (n: number) => string) => {
    const existing = tallies.get(key)
    if (existing) {
      existing.count += count
    } else {
      tallies.set(key, { count, label })
    }
  }

  const consumePendingNote = (): string | undefined => {
    const joined = pendingText.join('').trim()
    pendingText = []
    return joined || undefined
  }

  const linkPendingThinking = (callId: string | null, stepLabel: string) => {
    if (pendingThinkingRounds.length === 0) {
      return
    }
    for (const round of pendingThinkingRounds) {
      round.nextStepCallId = callId
      round.nextStepLabel = stepLabel
    }
    pendingThinkingRounds.length = 0
  }

  turn.blocks.forEach((block, index) => {
    if (block.type === 'text') {
      if (!block.isTemplate) {
        pendingText.push(block.text)
      }
      return
    }
    if (block.type === 'thinking') {
      const trimmed = block.thinking.trim()
      if (trimmed) {
        thinkingBlocks.push(block)
        const round: MutableThinkingRound = {
          key: `think-${index}`,
          index: thinkingRounds.length + 1,
          markdown: trimmed,
          seconds: blockDurationSeconds(block, now),
          nextStepCallId: null,
          nextStepLabel: null,
        }
        thinkingRounds.push(round)
        pendingThinkingRounds.push(round)
      }
      return
    }
    if (block.type === 'tool_use') {
      const result = toolResults.get(block.id)
      const capabilityId = result?.capability
      const presenter = getPresenter(capabilityId, block.name)
      const capState = capabilityId ? turn.capabilityState?.[capabilityId] : undefined
      const summary =
        presenter?.summarize(block, result, {
          streaming: turn.streaming,
          capabilityState: capState,
          locale,
        }) ?? null
      if (summary?.hiddenInTimeline) {
        return
      }
      const precedingNote = consumePendingNote()
      const lane = summary?.lane ?? capabilityId ?? block.name
      const rawSummary = readCallSummary(block.input, block.inputJson)
      const label = rawSummary || summary?.detail || summary?.liveVerb || block.name
      linkPendingThinking(block.id, label)

      const running = summary
        ? Boolean(summary.stillRunning)
        : !result || result.status === 'running'
      const failed = summary
        ? Boolean(summary.failed)
        : Boolean(result && result.status !== 'ok' && result.status !== 'running')
      const status: ActivityStepRecord['status'] = running ? 'running' : failed ? 'error' : 'ok'
      const stepVisuals = collectStepVisuals(label, summary, result)
      const errorPreview = failed ? (firstErrorLine(result?.content) ?? undefined) : undefined
      const hasFallbackContent = Boolean(
        precedingNote ||
        block.inputJson ||
        (block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0) ||
        result?.content?.trim() ||
        stepVisuals.length > 0
      )
      const hasDetail = presenter?.renderStepDetail
        ? Boolean(
            precedingNote ||
            (summary?.hasDetail ??
              Boolean(stepVisuals.length > 0 || result?.content?.trim() || failed))
          )
        : hasFallbackContent

      stepCount += 1
      if (failed) {
        errorCount += 1
        failedSteps.push({
          callId: block.id,
          label,
          preview: errorPreview ?? null,
        })
      }
      if (summary?.tally) {
        addTally(summary.tally.key, summary.tally.count, summary.tally.label)
      }
      if (result?.status === 'ok' && result.files?.length) {
        for (const file of result.files) {
          const dedupeKey = (file.path ?? file.name).toLowerCase()
          filesByKey.set(dedupeKey, {
            key: `${block.id}-f-${file.id}`,
            callId: block.id,
            file,
          })
        }
      }
      stepVisuals.forEach((visual, visualIndex) => {
        visuals.push({
          key: `${block.id}-v-${visualIndex}`,
          callId: block.id,
          stepLabel: label,
          src: visual.src,
          alt: visual.alt,
          ...(visual.caption ? { caption: visual.caption } : {}),
          ...(visual.href ? { href: visual.href } : {}),
        })
      })

      const entry: ActivityStepEntry = { call: block, result }
      const record: ActivityStepRecord = {
        entry,
        callId: block.id,
        label,
        status,
        summary,
        visuals: stepVisuals,
        hasDetail,
        ...(precedingNote ? { precedingNote } : {}),
        ...(errorPreview ? { errorPreview } : {}),
      }

      const prev = phases.at(-1)
      if (prev?.type === 'lane' && prev.lane === lane && prev.capabilityId === capabilityId) {
        prev.entries.push(entry)
        prev.items.push(record)
      } else {
        phases.push({
          type: 'lane',
          key: block.id,
          lane,
          capabilityId,
          presenter,
          entries: [entry],
          items: [record],
        })
      }
    }
  })

  const sources = extractTurnSources(turn.blocks)
  const { thinkingSeconds, completedThinkingMs, activeThinkingStartedAt } =
    thinkingBlocks.length > 0
      ? computeThinkingTiming(thinkingBlocks, now)
      : { thinkingSeconds: null, completedThinkingMs: 0, activeThinkingStartedAt: null }
  const tallyLabel = formatTallies([...tallies.values()], 3, locale)

  return {
    phases,
    thinkingBlocks,
    thinkingRounds,
    thinkingSeconds,
    completedThinkingMs,
    activeThinkingStartedAt,
    thinkingOnly: phases.length === 0 && thinkingBlocks.length > 0,
    sources,
    stepCount,
    errorCount,
    failedSteps,
    tallyLabel,
    files: [...filesByKey.values()],
    visuals,
  }
}
