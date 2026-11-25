import { IconActivityOutline16, IconButton } from '@deepseek-chat/lib-ui'
import { createElement, type ComponentType } from 'react'
import { createActivityPanel } from './ActivityPanel.js'
import headerToggleStyles from './HeaderToggle.module.css'
import { activityInspectorMessages } from './messages.js'
import { SiteLogo } from './SiteLogo.js'
import { SourceCard } from './SourceCard.js'
import { extractTurnSources, type ExtractedTurnSources } from './sources.js'
import { createActivityPanelState } from './state.js'
import {
  buildActivityTimeline,
  type ActivityLanePhase,
  type ActivityPreamblePhase,
  type ActivityServerSearchPhase,
  type ActivityStepRecord,
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
  ActivityInspectorDeps,
  ActivityLanePhase,
  ActivityPreamblePhase,
  ActivitySelection,
  ActivityServerSearchPhase,
  ActivitySource,
  ActivityStepRecord,
  ActivityTab,
  ActivityTarget,
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

  return {
    ActivityPanel,
    HeaderToggle,
    togglePanel: state.togglePanel,
    selectTurn: state.selectTurn,
    followLatest: state.followLatest,
    useActiveTarget: (): ActivityTarget | null => {
      const selection = state.useStore((s) => s.selection)
      const panelOpen = state.useStore((s) => s.panelOpen)
      if (!panelOpen || selection?.kind !== 'pinned') {
        return null
      }
      return {
        sessionId: selection.sessionId,
        messageId: selection.messageId,
        tab: selection.tab,
      }
    },
    getSelection: (): ActivitySelection | null => state.useStore.getState().selection,
    getTarget: state.getActiveTarget,
    close: state.close,
    dispose: state.dispose,
  }
}

export type ActivityInspectorSlice = ReturnType<typeof createActivityInspectorSlice>
