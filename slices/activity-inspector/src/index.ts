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
  type ActivityServerSearchPhase,
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
  ActivityServerSearchPhase,
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
  TurnSnapshotSource,
  TurnTextBlock,
  TurnThinkingBlock,
  TurnToolResultBlock,
  TurnToolUseBlock,
}

const resolveLatestMessageId = (
  turnSource: TurnSnapshotSource,
  sessionId: string
): string | null => {
  const turns = turnSource.listTurns?.(sessionId)
  if (!turns || turns.length === 0) {
    return null
  }
  const activeTurns = turns.filter((item) => item.hasActivity || item.streaming)
  const streamingTurn = [...activeTurns].reverse().find((item) => item.streaming)
  return streamingTurn?.messageId ?? activeTurns.at(-1)?.messageId ?? null
}

const resolveDisplayedTarget = (
  selection: ActivitySelection | null,
  panelOpen: boolean,
  turnSource: TurnSnapshotSource
): ActivityTarget | null => {
  if (!panelOpen || !selection) {
    return null
  }
  if (selection.kind === 'pinned') {
    return {
      sessionId: selection.sessionId,
      messageId: selection.messageId,
      tab: selection.tab,
    }
  }
  const messageId = resolveLatestMessageId(turnSource, selection.sessionId)
  if (!messageId) {
    return null
  }
  return {
    sessionId: selection.sessionId,
    messageId,
    tab: selection.tab,
  }
}

export const createActivityInspectorSlice = (deps: ActivityInspectorDeps) => {
  const state = createActivityPanelState(deps.panel, deps.log)
  const ActivityPanel = createActivityPanel(state, deps)

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
    return resolveDisplayedTarget(selection, panelOpen, deps.turnSource)
  }

  const useActiveTarget = (): ActivityTarget | null => {
    const selection = state.useStore((s) => s.selection)
    const panelOpen = state.useStore((s) => s.panelOpen)
    const cachedRef = useRef<ActivityTarget | null>(null)

    const getSnapshot = useCallback((): ActivityTarget | null => {
      const next = resolveDisplayedTarget(selection, panelOpen, deps.turnSource)
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

    return useSyncExternalStore(deps.turnSource.subscribe, getSnapshot, getSnapshot)
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
