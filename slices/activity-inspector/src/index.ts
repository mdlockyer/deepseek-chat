import { createActivityPanel } from './ActivityPanel.js'
import { SourceCard } from './SourceCard.js'
import { SiteLogo } from './SiteLogo.js'
import { extractTurnSources, type ExtractedTurnSources } from './sources.js'
import { createActivityPanelState } from './state.js'
import {
  buildActivityTimeline,
  type ActivityLanePhase,
  type ActivityPreamblePhase,
  type ActivityServerSearchPhase,
  type ActivityTimeline,
  type ActivityTimelinePhase,
} from './timeline.js'
import type {
  ActivityInspectorDeps,
  ActivitySource,
  ActivityTab,
  ActivityTarget,
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
  ActivityServerSearchPhase,
  ActivitySource,
  ActivityTab,
  ActivityTarget,
  ActivityTimeline,
  ActivityTimelinePhase,
  ExtractedTurnSources,
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

  return {
    ActivityPanel,
    useActiveTarget: (): ActivityTarget | null => state.useStore((s) => s.target),
    useHasLastActivity: (): boolean => state.useStore((s) => s.lastTarget !== null),
    getTarget: (): ActivityTarget | null => state.useStore.getState().target,
    getLastTarget: (): ActivityTarget | null => state.useStore.getState().lastTarget,
    restoreLastActivity: state.restoreLast,
    close: state.close,
    dispose: state.dispose,
  }
}

export type ActivityInspectorSlice = ReturnType<typeof createActivityInspectorSlice>
