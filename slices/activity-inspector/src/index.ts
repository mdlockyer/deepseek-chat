import { IconActivityOutline16, IconButton } from '@deepseek-chat/lib-ui'
import { createElement, useCallback, useRef, useSyncExternalStore, type ComponentType } from 'react'
import { createActivityPanel } from './ActivityPanel.js'
import headerToggleStyles from './HeaderToggle.module.css'
import { activityInspectorMessages } from './messages.js'
import { SiteLogo } from './SiteLogo.js'
import { SourceCard } from './SourceCard.js'
import { extractTurnSources, type ExtractedTurnSources } from './sources.js'
import { createActivityPanelState } from './state.js'
import {
  buildActivityTimeline,
  type ActivityFailedStep,
  type ActivityFileItem,
  type ActivityLanePhase,
  type ActivityStepRecord,
  type ActivityThinkingRound,
  type ActivityTimeline,
  type ActivityTimelinePhase,
  type ActivityVisualItem,
} from './timeline.js'
import type {
  ActivityInspectorDeps,
  ActivitySelection,
  ActivitySource,
  ActivityTab,
  ActivityTarget,
  SessionTurnSummary,
  TurnBlock,
  TurnSnapshot,
  TranscriptPort,
  TranscriptReadingPosition,
  TurnSnapshotSource,
  TurnTextBlock,
  TurnThinkingBlock,
  TurnToolResultBlock,
  TurnToolUseBlock,
} from './types.js'

export { SiteLogo, SourceCard, buildActivityTimeline, extractTurnSources }
export type {
  ActivityFailedStep,
  ActivityFileItem,
  ActivityInspectorDeps,
  ActivityLanePhase,
  ActivitySelection,
  ActivitySource,
  ActivityStepRecord,
  ActivityTab,
  ActivityTarget,
  ActivityThinkingRound,
  ActivityTimeline,
  ActivityTimelinePhase,
  ActivityVisualItem,
  ExtractedTurnSources,
  SessionTurnSummary,
  TurnBlock,
  TurnSnapshot,
  TranscriptPort,
  TranscriptReadingPosition,
  TurnSnapshotSource,
  TurnTextBlock,
  TurnThinkingBlock,
  TurnToolResultBlock,
  TurnToolUseBlock,
}

/** The turn a selection shows: the pinned turn, or the reader's turn (falling back to the latest). */
const resolveSelectionMessageId = (
  selection: ActivitySelection,
  turnSource: TurnSnapshotSource,
  transcript: TranscriptPort | undefined
): string | null => {
  if (selection.kind === 'pinned') {
    return selection.messageId
  }
  const turns = turnSource.listTurns?.(selection.sessionId) ?? null
  const reading = transcript?.getReadingPosition(selection.sessionId) ?? null
  if (reading && (!turns || turns.some((turn) => turn.messageId === reading.messageId))) {
    return reading.messageId
  }
  if (!turns || turns.length === 0) {
    return null
  }
  return ([...turns].reverse().find((turn) => turn.streaming) ?? turns.at(-1))?.messageId ?? null
}

export const createActivityInspectorSlice = (deps: ActivityInspectorDeps) => {
  const resolveMessageId = (selection: ActivitySelection) =>
    resolveSelectionMessageId(selection, deps.turnSource, deps.transcript)
  const resolveDisplayedTarget = (
    selection: ActivitySelection | null,
    panelOpen: boolean
  ): ActivityTarget | null => {
    if (!panelOpen || !selection) {
      return null
    }
    const messageId = resolveMessageId(selection)
    return messageId ? { sessionId: selection.sessionId, messageId, tab: selection.tab } : null
  }
  const subscribeSources = (listener: () => void) => {
    const unsubTurns = deps.turnSource.subscribe(listener)
    const unsubReading = deps.transcript?.subscribeToReading(listener)
    return () => {
      unsubTurns()
      unsubReading?.()
    }
  }
  const state = createActivityPanelState(deps.panel, deps.log, {
    ...(deps.transcript ? { transcript: deps.transcript } : {}),
    resolveMessageId,
  })
  const ActivityPanel = createActivityPanel(state, deps, resolveMessageId)

  const HeaderToggle: ComponentType<{ readonly sessionId: string }> = ({ sessionId }) => {
    const t = activityInspectorMessages.useTranslate()
    const open = deps.panel.useLayout(() => deps.panel.isOpen(sessionId))
    return createElement(IconButton, {
      size: 'm',
      tone: 'primary',
      className: open ? headerToggleStyles.active : undefined,
      icon: createElement(IconActivityOutline16),
      tooltip: t(open ? 'closeActivity' : 'openActivity'),
      tooltipPlacement: 'bottom',
      'aria-pressed': open,
      onClick: () => state.togglePanel(sessionId),
    })
  }

  const getTarget = (): ActivityTarget | null => {
    const { selection, panelOpen } = state.useStore.getState()
    return resolveDisplayedTarget(selection, panelOpen)
  }

  const useActiveTarget = (): ActivityTarget | null => {
    const selection = state.useStore((s) => s.selection)
    const panelOpen = state.useStore((s) => s.panelOpen)
    const cachedRef = useRef<ActivityTarget | null>(null)

    const getSnapshot = useCallback((): ActivityTarget | null => {
      const next = resolveDisplayedTarget(selection, panelOpen)
      const prev = cachedRef.current
      if (
        prev &&
        next &&
        prev.sessionId === next.sessionId &&
        prev.messageId === next.messageId &&
        prev.tab === next.tab
      ) {
        return prev
      }
      cachedRef.current = next
      return next
    }, [panelOpen, selection])

    return useSyncExternalStore(subscribeSources, getSnapshot, getSnapshot)
  }

  return {
    ActivityPanel,
    HeaderToggle,
    togglePanel: state.togglePanel,
    selectTurn: state.selectTurn,
    followLatest: state.followLatest,
    useActiveTarget,
    getSelection: (): ActivitySelection | null => state.useStore.getState().selection,
    getTarget,
    close: state.close,
    dispose: state.dispose,
  }
}

export type ActivityInspectorSlice = ReturnType<typeof createActivityInspectorSlice>
