import type { ApiErrorKind, MessageUsage, ModelProvider } from '@deepseek-chat/lib-agent'
import type {
  AgentProfileSpec,
  AgentSourceSpec,
  CitedSourceMeta,
  ToolCallRecord,
  ToolCaller,
  ToolDefinition,
  ToolEffect,
  ToolResultRecord,
  ToolRunContext,
  ToolRunResult,
} from '@deepseek-chat/lib-tools'
import type { EventLog } from '@deepseek-chat/spine/runtime'

export type SubagentsParams = {
  readonly maxParallelReadCalls: number
  readonly maxRunningChildren: number
  readonly maxChildrenPerReply: number
  readonly waitDefaultTimeoutS: number
  readonly autoWaitTimeoutS: number
  readonly maxPostsPerChild: number
  readonly maxPostChars: number
  readonly childToolResultDisplayChars: number
  readonly networkRetryLimit: number
  readonly retryBaseDelayMs: number
}

export const DEFAULT_SUBAGENTS_PARAMS: SubagentsParams = {
  maxParallelReadCalls: 6,
  maxRunningChildren: 5,
  maxChildrenPerReply: 12,
  waitDefaultTimeoutS: 60,
  autoWaitTimeoutS: 600,
  maxPostsPerChild: 6,
  maxPostChars: 400,
  childToolResultDisplayChars: 2000,
  networkRetryLimit: 2,
  retryBaseDelayMs: 1000,
}

export type ChildThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
  startedAt?: number
  endedAt?: number
  elapsedSeconds?: number
}

export type ChildTextBlock = {
  type: 'text'
  text: string
}

export type ChildToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  inputJson?: string
}

export type ChildToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  status: 'running' | 'ok' | 'error' | 'aborted'
  sources?: readonly CitedSourceMeta[]
  payload?: unknown
}

export type ChildBlock =
  | ChildThinkingBlock
  | ChildTextBlock
  | ChildToolUseBlock
  | ChildToolResultBlock

export type AgentRunResult = {
  readonly content: string
  readonly sources: readonly AgentSourceSpec[]
}

export type AgentRunState =
  | { readonly status: 'running'; readonly round: number }
  | { readonly status: 'finished'; readonly result: AgentRunResult }
  | {
      readonly status: 'exhausted'
      readonly limit: 'rounds' | 'toolCalls' | 'noFinishCall'
      readonly result: AgentRunResult
    }
  | {
      readonly status: 'failed'
      readonly error: { readonly kind: ApiErrorKind; readonly message: string }
    }
  | { readonly status: 'stopped'; readonly reason: 'user' | 'interrupted' | 'roundLimit' }

export type AgentRun = {
  readonly runId: string
  readonly profile: string
  readonly label?: string
  readonly startedBy: string
  readonly summary?: string
  readonly state: AgentRunState
  readonly blocks: ChildBlock[]
  readonly usage?: MessageUsage
}

export type PostAuthor =
  | { readonly kind: 'lead' }
  | { readonly kind: 'agent'; readonly runId: string }
export type PostAudience =
  | { readonly kind: 'all' }
  | { readonly kind: 'agent'; readonly runId: string }

export type BoardPost =
  | {
      readonly kind: 'finding'
      readonly id: string
      readonly author: PostAuthor
      readonly text: string
      readonly url: string
    }
  | {
      readonly kind: 'question'
      readonly id: string
      readonly author: PostAuthor
      readonly question: string
      readonly assumption: string
    }
  | {
      readonly kind: 'direction'
      readonly id: string
      readonly author: { readonly kind: 'lead' }
      readonly to: PostAudience
      readonly text: string
    }

/** Persisted per-reply snapshot stored in `AssistantMessage.capabilityState['subagents']`. */
export type SubagentsReplyState = {
  readonly agents: AgentRun[]
  readonly board: BoardPost[]
}

/** Narrow tool-host view consumed by subagents to discover profiles and run child read tools. */
export type SubagentsToolHost = {
  describe(name: string, audience: ToolCaller['kind']): ToolDefinition | null
  instructions(declaredNames: ReadonlySet<string>, audience: ToolCaller['kind']): string[]
  effectOf(name: string): ToolEffect
  agentProfile(name: string): AgentProfileSpec | null
  run(call: ToolCallRecord, ctx: ToolRunContext): Promise<ToolRunResult>
}

export type SubagentsSliceDeps = {
  readonly log: EventLog
  readonly provider: ModelProvider
  /** Read-only host of non-subagent capabilities (makes recursive subagent spawning impossible). */
  readonly toolHost: SubagentsToolHost
  readonly params?: Partial<SubagentsParams>
  readonly newId?: () => string
}

export const isSubagentsReplyState = (value: unknown): value is SubagentsReplyState =>
  Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { agents?: unknown }).agents) &&
    Array.isArray((value as { board?: unknown }).board)
  )

export type ToolResultWithSources = ToolResultRecord
