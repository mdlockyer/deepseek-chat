import type { ActivityStepEntry, ToolStepPresenter } from '@deepseek-chat/lib-tools'
import { extractTurnSources, type ExtractedTurnSources } from './sources.js'
import type { TurnSnapshot, TurnThinkingBlock, TurnToolResultBlock } from './types.js'

export type ActivityLanePhase = {
  readonly type: 'lane'
  readonly key: string
  readonly lane: string
  readonly capabilityId: string | undefined
  readonly presenter: ToolStepPresenter | null
  readonly entries: ActivityStepEntry[]
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

export type ActivityTimeline = {
  readonly phases: ActivityTimelinePhase[]
  readonly thinkingBlocks: TurnThinkingBlock[]
  readonly thinkingSeconds: number | null
  readonly thinkingOnly: boolean
  readonly sources: ExtractedTurnSources
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

/**
 * Pure reducer turning a turn snapshot into coalesced, capability-agnostic Activity phases.
 * Consecutive steps sharing `(capabilityId, lane)` merge even across hidden thinking blocks.
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
  let pendingText: string[] = []

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
      }
      if (block.input.action === 'search') {
        for (const q of block.input.queries) {
          if (q.trim() && !phase.queries.includes(q.trim())) {
            phase.queries.push(q.trim())
          }
        }
      } else if (block.input.action === 'open_page' || block.input.action === 'read_link') {
        const url = block.input.url
        if (url && !phase.pages.some((p) => p.url === url)) {
          phase.pages.push({ url, title: url })
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
      const summary = presenter?.summarize(block, result, {
        streaming: turn.streaming,
        capabilityState: capState,
      })
      if (summary?.hiddenInTimeline) {
        return
      }
      const lane = summary?.lane ?? capabilityId ?? block.name
      const prev = phases.at(-1)
      if (prev?.type === 'lane' && prev.lane === lane && prev.capabilityId === capabilityId) {
        prev.entries.push({ call: block, result })
      } else {
        phases.push({
          type: 'lane',
          key: block.id,
          lane,
          capabilityId,
          presenter,
          entries: [{ call: block, result }],
        })
      }
    }
  })

  const sources = extractTurnSources(turn.blocks)
  const thinkingSeconds =
    thinkingBlocks.length > 0 ? totalThinkingSeconds(thinkingBlocks, now) : null
  return {
    phases,
    thinkingBlocks,
    thinkingSeconds,
    thinkingOnly: phases.length === 0 && thinkingBlocks.length > 0,
    sources,
  }
}
