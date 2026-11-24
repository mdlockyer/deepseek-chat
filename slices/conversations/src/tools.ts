import type { ChatModel, ClientTool } from '@deepseek-chat/lib-agent'
import type { AgentSource, Message, ReplyBlock, ToolCallPart, ToolResultPart } from './types.js'

export type { AgentSource }

/**
 * What a client tool is, as far as the chat cares: how its steps are shown and archived. The names
 * themselves belong to the slices that run the tools; the app maps them.
 */
export type ToolKind =
  | 'web_search'
  | 'web_scrape'
  | 'browser'
  | 'present_file'
  | 'edit_file'
  | 'read_file'
  | 'python'
  | 'ask_user'
  | 'subagent'

/** What a call does outside its own result. Decides how it runs (SPEC invariant 2). */
export type ToolEffect = 'read' | 'spawn' | 'session' | 'artifact' | 'interactive'

/** Who made the call. Tool slices may refuse callers or word results for them. */
export type ToolCaller = { kind: 'reply' } | { kind: 'agent'; profile: string; runId: string }

/** Subagent profile owned by a feature slice and registered in the app's ToolGateway. */
export type AgentProfile = {
  readonly model: ChatModel
  readonly thinking: boolean
  /** Static per profile for prompt-cache reuse. */
  readonly system: string
  /** Allow-list of tool names; each must have effect `read` and never kind `subagent`. */
  readonly tools: readonly string[]
  /** `'clean'` isolates the child; `'fork'` prepends lead messages up to the spawn call. */
  readonly context: 'clean' | 'fork'
  /** Client tool the child calls to finish and return structured output. */
  readonly finish: ClientTool
  readonly limits: { readonly maxRounds: number; readonly maxToolCalls: number }
  /** Optional display label for timeline rows; defaults to the profile's tool name. */
  readonly label?: string
  /** Builds the child's first user message from the lead's input, or rejects it. */
  readonly task: (
    input: unknown
  ) => { kind: 'ok'; message: string } | { kind: 'invalid'; reason: string }
  /** Turns the child's output into an answer with numbered sources. */
  readonly complete: (
    output: unknown,
    run: { runId: string; outcome: 'finished' | 'exhausted' }
  ) => Promise<{ content: string; sources: AgentSource[] }>
}

/** Everything a tool run may need from the chat. */
export type ToolRunContext = {
  readonly sessionId: string
  readonly signal: AbortSignal
  /** Who invoked this tool call: the lead reply or a child subagent. */
  readonly caller: ToolCaller
  /** Raw JSON of the call's input, when the model's input did not parse. */
  readonly inputJson?: string
  /** The reply's blocks so far, this call's running result included. */
  readonly replyBlocks: readonly ReplyBlock[]
  /** Numbered citation URLs already assigned in this reply (empty for child callers). */
  readonly citedUrls: ReadonlyMap<string, number>
  /** The chat's visible branch, with the reply in progress last. */
  readonly messages: readonly Message[]
  /** Whether that chat is the one on screen. */
  readonly isActive: () => boolean
  /** Updates the running call's phase (Python environment setup, kernel start, run). */
  readonly onPhase: (phase: NonNullable<ToolResultPart['phase']>) => void
  /** Stores file contents in the chat's file store. */
  readonly saveFiles: (files: readonly { id: string; blob: Blob }[]) => Promise<void>
  readonly loadFile: (id: string) => Promise<Blob | undefined>
}

/** The finished call's result, written into its tool_result block. */
export type ToolResult = Pick<ToolResultPart, 'content' | 'status'> &
  Partial<
    Pick<
      ToolResultPart,
      | 'durationMs'
      | 'images'
      | 'previewImages'
      | 'files'
      | 'searchResults'
      | 'scrapedPage'
      | 'browserAction'
      | 'fileAction'
      | 'askAction'
    >
  >

/** The tools a turn may use, supplied by the app from the slices that run them. */
export type ToolGateway = {
  /** Tools to offer for a turn with these composer options. */
  declare(options: {
    search: boolean
    python: boolean
    browser: boolean
    questionText: string
  }): ClientTool[]
  /** System-prompt sections for the declared tools, worded for the given audience, in order. */
  instructions(declaredNames: ReadonlySet<string>, audience: ToolCaller['kind']): string[]
  /** One tool's definition, with `summary` injected and worded for the audience. */
  describe(name: string, audience: ToolCaller['kind']): ClientTool | null
  kindOf(name: string): ToolKind | null
  effectOf(name: string): ToolEffect
  /** Non-null exactly when `kindOf(name) === 'subagent'`. */
  agentProfile(name: string): AgentProfile | null
  /** Markdown fence language for a presented file's path ('' or 'text' for none). */
  fenceLanguage(path: string): string
  /** Runs one call. Always resolves; an unknown tool resolves as an error. */
  run(call: ToolCallPart, context: ToolRunContext): Promise<ToolResult>
}
