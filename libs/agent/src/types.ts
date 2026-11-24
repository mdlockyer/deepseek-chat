/**
 * Messages API (Anthropic-compatible format) protocol types used by DeepSeek clients.
 * Docs: https://api-docs.deepseek.com/zh-cn/api/create-message
 */

export type ChatModel = 'deepseek-flash' | 'deepseek-v4-pro'

// ---------- Response: content blocks ----------

/** Inline citation attached to a text block by the server. */
export type TextCitation = {
  type: 'web_search_result_location'
  url: string
  /** Null when the title could not be resolved. */
  title: string | null
  /** Text of the block up to this citation, trimmed. */
  cited_text: string
  /** Always empty string. */
  encrypted_index: string
}

export type TextBlock = { type: 'text'; text: string; citations?: TextCitation[] }

export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }

export type ServerToolKind =
  | 'search'
  | 'deep_search'
  | 'read_link'
  | 'image_search'
  | 'deep_image_search'

export type ServerToolInput =
  | { action: 'search'; query?: string; queries: string[] }
  | { action: 'open_page'; url: string }
  | { action: 'find_in_page'; url: string; pattern: string }
  | { action: 'read_link'; url: string }

export type ServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'deepseek_web_search' | 'deepseek_read_url'
  input: ServerToolInput
  caller: { type: 'direct' }
  kind: ServerToolKind
}

export type WebSearchResult = {
  type: 'web_search_result'
  title: string
  url: string
  image_url?: string
  snippet: string
  site_icon: string | null
  site_name: string | null
  encrypted_content: string
  page_age: string | null
}

export type WebSearchToolResultError = {
  type: 'web_search_tool_result_error'
  error_code: 'unavailable'
}

export type WebSearchToolResultBlock = {
  type: 'web_search_tool_result'
  tool_use_id: string
  content: (WebSearchResult | WebSearchToolResultError)[]
  kind: 'search' | 'deep_search' | 'image_search' | 'deep_image_search'
}

export type WebFetchResult = {
  type: 'web_fetch_result'
  url: string
  content: {
    type: 'document'
    source: { type: 'text'; media_type: 'text/plain'; data: string }
    title: string | null
  }
  published_at: string | null
}

export type WebFetchToolResultError = {
  type: 'web_fetch_tool_result_error'
  error_code: 'url_not_accessible' | 'url_not_allowed' | 'unavailable'
}

export type WebFetchToolResultBlock = {
  type: 'web_fetch_tool_result'
  tool_use_id: string
  content: WebFetchResult | WebFetchToolResultError
  kind: 'read_link' | 'deep_search'
  signature?: string
}

export type ServerToolBlock =
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | WebFetchToolResultBlock

export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }

// ---------- Request ----------

export type TextBlockParam = { type: 'text'; text: string }

export type FileBlockParam = {
  type: 'image' | 'document'
  source: { type: 'file'; file_id: string }
}

export type ServerToolUseBlockParam = Pick<
  ServerToolUseBlock,
  'type' | 'id' | 'name' | 'input' | 'kind'
>

export type WebSearchToolResultBlockParam = WebSearchToolResultBlock

export type WebFetchToolResultBlockParam = WebFetchToolResultBlock

export type ToolUseBlockParam = ToolUseBlock

export type ToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export type AssistantBlockParam =
  | TextBlockParam
  | ThinkingBlock
  | ToolUseBlockParam
  | ServerToolUseBlockParam
  | WebSearchToolResultBlockParam
  | WebFetchToolResultBlockParam

export type MessageParam =
  | { role: 'latest_reminder'; content: string }
  | {
      role: 'user'
      content: string | (FileBlockParam | TextBlockParam | ToolResultBlockParam)[]
    }
  | { role: 'assistant'; content: AssistantBlockParam[] }

export type DeepseekWebSearchTool = {
  type: 'deepseek_web_search'
  name: 'deepseek_web_search'
}

export type DeepseekReadUrlTool = {
  type: 'deepseek_read_url'
  name: 'deepseek_read_url'
}

export type ClientTool = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string }

export type CreateMessageRequest = {
  model: ChatModel
  system: string
  messages: MessageParam[]
  thinking: { type: 'enabled' | 'disabled' }
  tools: (DeepseekWebSearchTool | DeepseekReadUrlTool | ClientTool)[]
  tool_choice?: ToolChoice
  safety_check?: { level: 'high' }
  title?: { enabled: boolean }
}

// ---------- Response: stream events ----------

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal'

export type StopDetails = { type: 'refusal'; category: null; explanation: null }

export type MessageUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  server_tool_use?: { web_search_requests: number; tool_search: number }
}

export type OutputBlockStart = TextBlock | ThinkingBlock | ServerToolBlock | ToolUseBlock

export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'citations_delta'; citation: TextCitation }
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
        title?: string
      }
      usage?: MessageUsage
    }
  | { type: 'message_stop' }
  | { type: 'ping' }

export type FilePurpose = 'rich_layout_recognition' | 'user_data'

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
