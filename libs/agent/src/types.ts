import type { ModelId } from './models.js'

/**
 * Provider-neutral canonical Messages protocol types (Anthropic Messages block shape).
 * All provider adapters translate to/from these canonical types.
 */

export type ChatModel = ModelId

// ---------- Response: content blocks ----------

export type TextBlock = { type: 'text'; text: string }

export type ThinkingBlock = { type: 'thinking'; thinking: string; signature?: string }

export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }

// ---------- Request ----------

export type TextBlockParam = { type: 'text'; text: string }

export type FileSourceParam =
  | { type: 'file'; file_id: string }
  | { type: 'base64'; media_type: string; data: string }

export type FileBlockParam = {
  type: 'image' | 'document'
  source: FileSourceParam
}

export type ToolUseBlockParam = ToolUseBlock

export type ToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export type AssistantBlockParam = TextBlockParam | ThinkingBlock | ToolUseBlockParam

export type MessageParam =
  | {
      role: 'user'
      content: string | (FileBlockParam | TextBlockParam | ToolResultBlockParam)[]
    }
  | { role: 'assistant'; content: AssistantBlockParam[] }

export type ClientTool = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string }

export type CreateMessageRequest = {
  model: ModelId
  system: string
  messages: MessageParam[]
  max_tokens?: number
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number }
  tools: ClientTool[]
  tool_choice?: ToolChoice
}

// ---------- Response: stream events ----------

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal'

export type StopDetails = { type: 'refusal'; category: null; explanation: null }

export type MessageUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

export type MessageUsageDelta = Partial<MessageUsage>

export type OutputBlockStart = TextBlock | ThinkingBlock | ToolUseBlock

export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'input_json_delta'; partial_json: string }

export type MessageStreamEvent =
  | {
      type: 'message_start'
      message: { id: string; model: string; usage?: MessageUsage }
    }
  | { type: 'content_block_start'; index: number; content_block: OutputBlockStart }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta: {
        stop_reason: StopReason
        stop_sequence: null
        stop_details?: StopDetails
      }
      usage?: MessageUsageDelta
    }
  | { type: 'message_stop' }
  | { type: 'ping' }

export type FileObject = {
  id: string
  type: 'file'
  size_bytes: number
  created_at: string
  filename: string
  mime_type: string
}

export type ApiErrorBody = {
  error: {
    message: string
    type?: string
    param?: string | null
    code?: string | null
  }
}
