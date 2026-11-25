import type { ComponentType, MouseEvent, ReactNode } from 'react'

/** Model-visible client tool definition (structurally compatible with Anthropic/DeepSeek ClientTool). */
export type ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

/** Side-effect class governing how the host schedules concurrent vs. serial tool calls. */
export type ToolEffect = 'read' | 'spawn' | 'session' | 'artifact' | 'interactive'

/** Who invoked a tool call: the lead reply turn or a child subagent run. */
export type ToolCaller =
  | { readonly kind: 'reply' }
  | { readonly kind: 'agent'; readonly profile: string; readonly runId: string }

/** File delivered by a tool call, stored in BlobStore by `id`. */
export type DeliveredFileRef = {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly mimeType: string
  /** Logical path used to group versions of the same artifact across turns. */
  readonly path?: string
  readonly title?: string
  /** 1-based version number within the visible branch. */
  readonly version?: number
  /** Capability ID that produced this file. */
  readonly producer?: string
}

/** Citable source returned by any tool call. */
export type CitedSourceMeta = {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly siteName: string | null
  readonly publishedAt: string | null
}

/** Compact Front Stage summary note rendered inline above or alongside a reply. */
export type FrontStageNoteItem = {
  readonly id: string
  readonly label: string
  readonly question?: string
  readonly value?: string | string[]
}

export type FrontStageNote = {
  readonly status: 'done' | 'skipped' | 'waiting'
  readonly items: readonly FrontStageNoteItem[]
}

/** Generic live execution phase emitted by a running tool call. */
export type ToolProgress = {
  readonly phase: string
  readonly detail?: string
}

/** Minimal tool-call snapshot passed to presenters and archive serializers. */
export type ToolCallRecord = {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly inputJson?: string
}

/** Minimal tool-result snapshot passed to presenters and archive serializers. */
export type ToolResultRecord = {
  readonly tool_use_id: string
  readonly capability?: string
  readonly content: string
  readonly status: 'running' | 'ok' | 'error' | 'aborted'
  readonly progress?: ToolProgress
  readonly startedAt?: number
  readonly durationMs?: number
  readonly images?: readonly string[]
  readonly previewImages?: readonly string[]
  readonly files?: readonly DeliveredFileRef[]
  readonly sources?: readonly CitedSourceMeta[]
  readonly frontStageNote?: FrontStageNote
  readonly payload?: unknown
}

/** Runtime context supplied by the host when invoking one tool call. */
export type ToolRunContext = {
  readonly sessionId: string
  readonly replyId: string
  readonly signal: AbortSignal
  readonly caller: ToolCaller
  readonly inputJson?: string
  /** Reply-wide citation map already assigned before this batch. */
  readonly citedUrls: ReadonlyMap<string, number>
  /** Whether the owning session is currently active on screen. */
  readonly isActive: () => boolean
  /** Reports live progress while this call is running. */
  readonly onProgress: (progress: ToolProgress) => void
  /** Reads this capability's persisted JSON state on the current reply. */
  readonly readReplyState: <T = unknown>() => T | undefined
  /** Updates this capability's state on the current reply (`persist` defaults to true). */
  readonly writeReplyState: (next: unknown, options?: { readonly persist?: boolean }) => void
  /** Current turn's dynamic environment snapshot, when available. */
  readonly latestReminder?: string
  /** Optional lazy accessor for lead messages up to this call (used by `'fork'` subagents). */
  readonly forkMessages?: () => readonly unknown[]
}

/** Outcome returned by a capability's `run` method. */
export type ToolRunResult = {
  readonly content: string
  readonly status: 'ok' | 'error' | 'aborted'
  readonly durationMs?: number
  readonly images?: string[]
  readonly previewImages?: string[]
  readonly files?: DeliveredFileRef[]
  readonly sources?: CitedSourceMeta[]
  readonly frontStageNote?: FrontStageNote
  readonly payload?: unknown
  /**
   * Optional pure formatter invoked in call order once reply-wide citation indexes have been
   * assigned for a concurrent batch, allowing race-free citation numbering without host coupling.
   */
  readonly formatContentWithCitations?: (urlToIndex: ReadonlyMap<string, number>) => string
}

/** Composer menu toggle contributed by a capability slice. */
export type ComposerToggleDescriptor = {
  readonly id: string
  readonly label: () => string
  readonly icon: ReactNode
  readonly isEnabled: () => boolean
  readonly setEnabled: (enabled: boolean) => void
  readonly subscribe: (listener: () => void) => () => void
}

/** Source returned by a subagent profile upon completion. */
export type AgentSourceSpec = {
  readonly n: number
  readonly url: string
  readonly title: string
  readonly verification: 'verified' | 'unverified'
}

/** Declarative subagent profile owned by a capability slice and executed by the subagents slice. */
export type AgentProfileSpec = {
  readonly model: 'deepseek-flash' | 'deepseek-v4-pro'
  readonly thinking: boolean
  readonly label?: string
  /** Static system prompt for prompt-cache reuse. */
  readonly system: string
  /** Allow-list of read-only tool names. */
  readonly tools: readonly string[]
  readonly context: 'clean' | 'fork'
  readonly finish: ToolDefinition
  readonly limits: { readonly maxRounds: number; readonly maxToolCalls: number }
  readonly task: (
    input: unknown
  ) =>
    | { readonly kind: 'ok'; readonly message: string }
    | { readonly kind: 'invalid'; readonly reason: string }
  readonly complete: (
    output: unknown,
    run: { readonly runId: string; readonly outcome: 'finished' | 'exhausted' }
  ) => Promise<{ readonly content: string; readonly sources: readonly AgentSourceSpec[] }>
}

/** Compact live track shown in the Front Stage Work Strip for parallel work (e.g. subagents). */
export type LiveTrack = {
  readonly id: string
  readonly label: string
  readonly detail: string | null
  readonly status: 'running' | 'finished' | 'exhausted' | 'failed' | 'stopped'
}

/** Tally unit aggregated across steps in the Front Stage Work Strip. */
export type ToolStepTally = {
  readonly key: string
  readonly count: number
  readonly label: (count: number) => string
}

/** Domain-blind visual artifact captured by a tool step (e.g. a screenshot or generated figure). */
export type ToolStepVisualArtifact = {
  readonly src: string
  readonly alt: string
  readonly caption?: string
  readonly href?: string
}

/** Domain-blind summary of one tool step for the live Work Strip and Activity Inspector. */
export type ToolStepSummary = {
  /** Grouping lane in the Activity Inspector; consecutive steps sharing a lane coalesce. */
  readonly lane: string
  /** Short active verb shown while running (e.g. "Running code", "Searching the web"). */
  readonly liveVerb: string
  /** Optional compact 14px outline icon representing this step in inline traces and Activity rows. */
  readonly icon?: ReactNode
  /** Optional single-line fallback detail when the call has no `summary` argument. */
  readonly detail?: string
  /** Optional compact right-side metadata label on collapsed Activity rows (e.g. duration or version). */
  readonly meta?: string
  /** Optional visual artifacts captured by this step for row badges and visual storyboard filtering. */
  readonly visuals?: readonly ToolStepVisualArtifact[]
  /** True when the step has expandable details in Activity (omit to let the inspector infer). */
  readonly hasDetail?: boolean
  /** Optional tally count contributed to the Work Strip summary. */
  readonly tally?: ToolStepTally
  /** Optional compact parallel live tracks (e.g. concurrent child agents). */
  readonly liveTracks?: readonly LiveTrack[]
  /** True when the step is paused waiting for user input (renders paused mark instead of active loader). */
  readonly waitingForUser?: boolean
  /** True for plumbing steps that should be folded out of the Activity timeline. */
  readonly hiddenInTimeline?: boolean
  /** True when this step visibly reports ongoing activity (suppresses duplicate stall indicator). */
  readonly stillRunning?: boolean
  /** True when this step ended in an error state. */
  readonly failed?: boolean
}

export type ActivityStepEntry = {
  readonly call: ToolCallRecord
  readonly result?: ToolResultRecord
}

export type ActivityStepDetailProps = {
  readonly sessionId: string | null
  readonly entry: ActivityStepEntry
  readonly streaming: boolean
  readonly now: number
  readonly capabilityState?: unknown
  readonly openLink: (event: MouseEvent, url: string) => void
  readonly openFile?: (sessionId: string, file: DeliveredFileRef) => void
  readonly openVisual?: (visual: ToolStepVisualArtifact) => void
  readonly renderMarkdown: (props: {
    readonly content: string
    readonly cacheKey: string
  }) => ReactNode
}

export type ActivityStepRenderProps = {
  readonly sessionId: string | null
  readonly lane: string
  readonly entries: readonly ActivityStepEntry[]
  readonly streaming: boolean
  readonly now: number
  readonly capabilityState?: unknown
  /** Tool call ID explicitly targeted by the user (e.g. clicking an inline trace row). */
  readonly focusedCallId?: string | null
  /** Monotonic counter bumped on each explicit focus request so repeat clicks re-expand/scroll. */
  readonly focusNonce?: number
  readonly openLink: (event: MouseEvent, url: string) => void
  readonly openFile?: (sessionId: string, file: DeliveredFileRef) => void
  readonly renderMarkdown: (props: {
    readonly content: string
    readonly cacheKey: string
  }) => ReactNode
}

/** Presentation contract implemented by a capability slice to render its own steps. */
export type ToolStepPresenter = {
  summarize(
    call: ToolCallRecord,
    result: ToolResultRecord | undefined,
    ctx: { readonly streaming: boolean; readonly capabilityState?: unknown }
  ): ToolStepSummary
  /**
   * Unified detail renderer: renders only the expanded body for a single step inside the Activity
   * panel's shared row chrome (icon, human summary, status/meta badges, hover glide, focus ring).
   */
  readonly renderStepDetail?: ComponentType<ActivityStepDetailProps>
  /**
   * Optional custom lane renderer for capabilities that manage their own grouped chrome
   * (used only when `renderStepDetail` is omitted).
   */
  readonly renderActivity?: ComponentType<ActivityStepRenderProps>
}

/** Portable v3 archive fragment emitted by a capability's `serializeForArchive`. */
export type ArchiveFragment =
  | {
      readonly type: 'TOOL_SEARCH'
      readonly queries: string[]
      readonly status: 'WIP' | 'FINISHED' | 'FAILED'
      readonly results: readonly {
        readonly url: string
        readonly title: string
        readonly snippet: string
        readonly published_at: string | null
        readonly site_name: string | null
        readonly site_icon: string | null
      }[]
    }
  | {
      readonly type: 'TOOL_OPEN'
      readonly status: 'WIP' | 'FINISHED' | 'FAILED'
      readonly url: string | null
      readonly title: string | null
      readonly snippet: string | null
      readonly site_name: string | null
      readonly published_at: string | null
    }
  | {
      readonly type: 'MARKDOWN'
      readonly content: string
      readonly separate?: boolean
    }

/** Optional lifecycle hooks allowing a capability to coordinate with the turn loop cleanly. */
export type TurnLifecycleHooks = {
  /**
   * Called when the model finishes a round with zero tool calls; returning a synthetic call
   * continues the tool loop (e.g., waiting for still-running background subagents).
   */
  onTurnEndWithoutToolCalls?(ctx: {
    readonly sessionId: string
    readonly replyId: string
    readonly readReplyState: () => unknown
    readonly writeReplyState: (next: unknown, options?: { readonly persist?: boolean }) => void
  }): { readonly syntheticCall: ToolCallRecord } | null
  /** Called when a reply turn settles (done, user stop, API error, or round limit). */
  onTurnSettled?(ctx: {
    readonly sessionId: string
    readonly replyId: string
    readonly reason: 'done' | 'user' | 'interrupted' | 'roundLimit'
    readonly readReplyState: () => unknown
    readonly writeReplyState: (next: unknown, options?: { readonly persist?: boolean }) => void
  }): void
  /** Pure normalizer applied to persisted `capabilityState[id]` when loading a reply from storage. */
  onReplyHydrated?(state: unknown): unknown
}

export type DeclareToolsContext = {
  readonly questionText: string
  readonly enabledCapabilities: Readonly<Record<string, boolean>>
  readonly declaredToolsSoFar: readonly ToolDefinition[]
}

/** Open capability plugin exported by any tool-bearing slice. */
export type ToolCapability = {
  readonly id: string
  readonly toggle?: ComposerToggleDescriptor
  /** Optional initial running progress emitted as soon as a call starts. */
  readonly initialProgress?: (toolName: string) => ToolProgress | undefined
  declareTools(turn: DeclareToolsContext): readonly ToolDefinition[]
  instructions(declaredNames: ReadonlySet<string>, audience: ToolCaller['kind']): string | null
  describe?(name: string, audience: ToolCaller['kind']): ToolDefinition | null
  handles(name: string): boolean
  effectOf(name: string): ToolEffect
  agentProfile?(name: string): AgentProfileSpec | null
  run(call: ToolCallRecord, ctx: ToolRunContext): Promise<ToolRunResult>
  readonly presenter?: ToolStepPresenter
  serializeForArchive?(
    call: ToolCallRecord,
    result: ToolResultRecord | undefined
  ): readonly ArchiveFragment[]
  readonly turnHooks?: TurnLifecycleHooks
}

/** Static cross-capability prompt guidance emitted only when all named capabilities are active. */
export type CompositionPromptNote = {
  readonly requires: readonly string[]
  readonly audience?: ToolCaller['kind'] | 'both'
  readonly text: string
}

/** Aggregated capability registry injected into conversations, subagents, activity-inspector, and history-backup. */
export type ToolRegistry = {
  readonly capabilities: readonly ToolCapability[]
  readonly toggles: readonly ComposerToggleDescriptor[]
  /** Snapshot of current composer toggle states keyed by capability ID. */
  snapshotEnabled(): Record<string, boolean>
  declare(turn: {
    readonly questionText: string
    readonly enabledCapabilities: Readonly<Record<string, boolean>>
  }): ToolDefinition[]
  instructions(declaredNames: ReadonlySet<string>, audience: ToolCaller['kind']): string[]
  describe(name: string, audience: ToolCaller['kind']): ToolDefinition | null
  capabilityIdOf(name: string): string | null
  initialProgressOf(name: string): ToolProgress | undefined
  effectOf(name: string): ToolEffect
  agentProfile(name: string): AgentProfileSpec | null
  run(
    call: ToolCallRecord,
    ctx: ToolRunContext
  ): Promise<ToolRunResult & { readonly capabilityId?: string }>
  presenterFor(capabilityId: string | undefined, toolName: string): ToolStepPresenter | null
  serializeForArchive(
    call: ToolCallRecord,
    result: ToolResultRecord | undefined
  ): readonly ArchiveFragment[] | null
  readonly turnHooks: readonly {
    readonly capabilityId: string
    readonly hooks: TurnLifecycleHooks
  }[]
}
