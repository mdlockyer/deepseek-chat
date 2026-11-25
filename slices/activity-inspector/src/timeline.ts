import type {
  ActivityStepEntry,
  ToolStepPresenter,
  ToolStepSummary,
  ToolStepVisualArtifact,
} from '@deepseek-chat/lib-tools'
import { activityInspectorMessages } from './messages.js'
import { extractTurnSources, type ExtractedTurnSources } from './sources.js'
import type { TurnSnapshot, TurnThinkingBlock, TurnToolResultBlock } from './types.js'

export type ActivityStepRecord = {
  readonly entry: ActivityStepEntry
  readonly callId: string
  readonly label: string
  readonly status: 'running' | 'ok' | 'error'
  readonly summary: ToolStepSummary | null
  readonly visuals: readonly ToolStepVisualArtifact[]
  readonly hasDetail: boolean
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

export type ActivityServerSearchPhase = {
  readonly type: 'server_search'
  readonly key: string
  readonly queries: string[]
  readonly pages: { readonly url: string; readonly title: string }[]
}

export type ActivityPreamblePhase = {
  readonly type: 'preamble'
  readonly key: string
  readonly markdown: string
}

export type ActivityTimelinePhase =
  | ActivityLanePhase
  | ActivityServerSearchPhase
  | ActivityPreamblePhase

export type ActivityVisualItem = {
  readonly key: string
  readonly callId: string
  readonly stepLabel: string
  readonly src: string
  readonly alt: string
  readonly caption?: string
  readonly href?: string
}

export type ActivityTimeline = {
  readonly phases: ActivityTimelinePhase[]
  readonly thinkingBlocks: TurnThinkingBlock[]
  readonly thinkingSeconds: number | null
  readonly thinkingOnly: boolean
  readonly sources: ExtractedTurnSources
  readonly stepCount: number
  readonly errorCount: number
  readonly tallyLabel: string | null
  readonly visuals: readonly ActivityVisualItem[]
}

type TallyEntry = {
  count: number
  label: (count: number) => string
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

const totalThinkingSeconds = (blocks: readonly TurnThinkingBlock[], now: number): number | null => {
  let total = 0
  let hasDuration = false
  for (const block of blocks) {
    if (block.startedAt !== undefined) {
      total += Math.max(0, ((block.endedAt ?? now) - block.startedAt) / 1000)
      hasDuration = true
    } else if (block.elapsedSeconds !== undefined) {
      total += Math.max(0, block.elapsedSeconds)
      hasDuration = true
    }
  }
  return hasDuration ? Math.max(1, Math.round(total)) : null
}

const formatTallies = (tallies: readonly TallyEntry[], maxItems = 3): string | null => {
  const labels = tallies.slice(0, maxItems).map((entry) => entry.label(entry.count))
  if (labels.length === 0) {
    return null
  }
  if (labels.length === 1) {
    return labels[0] ?? null
  }
  if (labels.length === 2) {
    return `${labels[0]}${activityInspectorMessages.translate('listPairSeparator')}${labels[1]}`
  }
  return `${labels.slice(0, -1).join(activityInspectorMessages.translate('listSeparator'))}${activityInspectorMessages.translate('listLastSeparator')}${labels.at(-1)}`
}

const collectStepVisuals = (
  label: string,
  summary: ToolStepSummary | null,
  result: TurnToolResultBlock | undefined
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
 * unified step records (using the model's plain-prose `summary` first), natural tallies, and
 * extracted visual artifacts.
 */
export const buildActivityTimeline = (
  turn: TurnSnapshot,
  getPresenter: (capabilityId: string | undefined, toolName: string) => ToolStepPresenter | null,
  now: number
): ActivityTimeline => {
  const toolResults = new Map<string, TurnToolResultBlock>()
  for (const block of turn.blocks) {
    if (block.type === 'tool_result') {
      toolResults.set(block.tool_use_id, block)
    }
  }

  const phases: ActivityTimelinePhase[] = []
  const thinkingBlocks: TurnThinkingBlock[] = []
  const tallies = new Map<string, TallyEntry>()
  const visuals: ActivityVisualItem[] = []
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

  const flushPreamble = (keyIndex: number) => {
    const joined = pendingText.join('').trim()
    pendingText = []
    if (joined) {
      phases.push({ type: 'preamble', key: `preamble-${keyIndex}`, markdown: joined })
    }
  }

  turn.blocks.forEach((block, index) => {
    if (block.type === 'text') {
      if (!block.isTemplate) {
        pendingText.push(block.text)
      }
      return
    }
    if (block.type === 'thinking') {
      if (block.thinking) {
        flushPreamble(index)
        thinkingBlocks.push(block)
      }
      return
    }
    if (block.type === 'server_tool_use') {
      flushPreamble(index)
      const prev = phases.at(-1)
      const phase: ActivityServerSearchPhase =
        prev?.type === 'server_search'
          ? prev
          : { type: 'server_search', key: block.id, queries: [], pages: [] }
      if (prev !== phase) {
        phases.push(phase)
        stepCount += 1
      }
      if (block.input.action === 'search') {
        let added = 0
        for (const q of block.input.queries) {
          const trimmed = q.trim()
          if (trimmed && !phase.queries.includes(trimmed)) {
            phase.queries.push(trimmed)
            added += 1
          }
        }
        if (added > 0) {
          addTally('server-search', added, (count) =>
            activityInspectorMessages.translate(
              count === 1 ? 'serverSearchCountOne' : 'serverSearchCountMany',
              { count }
            )
          )
        }
      } else if (block.input.action === 'open_page' || block.input.action === 'read_link') {
        const url = block.input.url
        if (url && !phase.pages.some((p) => p.url === url)) {
          phase.pages.push({ url, title: url })
          addTally('server-page', 1, (count) =>
            activityInspectorMessages.translate(
              count === 1 ? 'serverPageCountOne' : 'serverPageCountMany',
              { count }
            )
          )
        }
      }
      return
    }
    if (block.type === 'tool_use') {
      flushPreamble(index)
      const result = toolResults.get(block.id)
      const capabilityId = result?.capability
      const presenter = getPresenter(capabilityId, block.name)
      const capState = capabilityId ? turn.capabilityState?.[capabilityId] : undefined
      const summary =
        presenter?.summarize(block, result, {
          streaming: turn.streaming,
          capabilityState: capState,
        }) ?? null
      if (summary?.hiddenInTimeline) {
        return
      }
      const lane = summary?.lane ?? capabilityId ?? block.name
      const rawSummary = readCallSummary(block.input, block.inputJson)
      const label = rawSummary || summary?.detail || summary?.liveVerb || block.name
      const running = summary
        ? Boolean(summary.stillRunning)
        : !result || result.status === 'running'
      const failed = summary
        ? Boolean(summary.failed)
        : Boolean(result && result.status !== 'ok' && result.status !== 'running')
      const status: ActivityStepRecord['status'] = running ? 'running' : failed ? 'error' : 'ok'
      const stepVisuals = collectStepVisuals(label, summary, result)
      const hasFallbackContent = Boolean(
        block.inputJson ||
        (block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0) ||
        result?.content?.trim() ||
        stepVisuals.length > 0
      )
      const hasDetail = presenter?.renderStepDetail
        ? (summary?.hasDetail ??
          Boolean(stepVisuals.length > 0 || result?.content?.trim() || failed))
        : hasFallbackContent

      stepCount += 1
      if (failed) {
        errorCount += 1
      }
      if (summary?.tally) {
        addTally(summary.tally.key, summary.tally.count, summary.tally.label)
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
  const thinkingSeconds =
    thinkingBlocks.length > 0 ? totalThinkingSeconds(thinkingBlocks, now) : null
  const tallyLabel = formatTallies([...tallies.values()], 3)

  return {
    phases,
    thinkingBlocks,
    thinkingSeconds,
    thinkingOnly: phases.length === 0 && thinkingBlocks.length > 0,
    sources,
    stepCount,
    errorCount,
    tallyLabel,
    visuals,
  }
}
