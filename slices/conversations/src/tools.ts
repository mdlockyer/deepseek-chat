import type { ClientTool } from './api/types.js'
import type { Message, ReplyBlock, ToolCallPart, ToolResultPart } from './types.js'

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

/** Everything a tool run may need from the chat. */
export type ToolRunContext = {
  readonly sessionId: string
  readonly signal: AbortSignal
  /** Raw JSON of the call's input, when the model's input did not parse. */
  readonly inputJson?: string
  /** The reply's blocks so far, this call's running result included. */
  readonly replyBlocks: readonly ReplyBlock[]
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
      | 'files'
      | 'searchResults'
      | 'scrapedPage'
      | 'browserAction'
      | 'fileAction'
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
  /** System-prompt sections for the declared tools, in order. */
  instructions(declaredNames: ReadonlySet<string>): string[]
  kindOf(name: string): ToolKind | null
  /** Markdown fence language for a presented file's path ('' or 'text' for none). */
  fenceLanguage(path: string): string
  /** Runs one call. Always resolves; an unknown tool resolves as an error. */
  run(call: ToolCallPart, context: ToolRunContext): Promise<ToolResult>
}
