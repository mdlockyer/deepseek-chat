export {
  ApiError,
  DEFAULT_REST_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  readErrorResponse,
  readMessagesEventStream,
  request,
  type ApiErrorKind,
} from './client.js'
export { createDeepSeekProvider, type DeepSeekProviderDeps } from './deepseekProvider.js'
export {
  classifyApiError,
  classifyStatus,
  isContextOverflowMessage,
  isRetryableApiError,
  type ApiErrorCondition,
} from './errors.js'
export {
  DEEPSEEK_MODELS,
  DEFAULT_DEEPSEEK_MODEL,
  resolveModelSpec,
  type ModelCapabilities,
  type ModelId,
  type ModelSpec,
  type ProviderId,
} from './models.js'
export { readMessageEvent } from './parseEvent.js'
export type {
  AttachmentUpload,
  ModelProvider,
  ProviderAttachmentPort,
  UploadQuotaInfo,
} from './provider.js'
export {
  applyEvent,
  emptyTranscript,
  type Block,
  type Transcript,
  type TranscriptTextBlock,
  type TranscriptThinkingBlock,
  type TranscriptToolUseBlock,
} from './reducer.js'
export { ServerSentEventDecoder, readServerSentEvents, type ServerSentEvent } from './sse.js'
export type {
  ApiErrorBody,
  AssistantBlockParam,
  ChatModel,
  ClientTool,
  ContentBlockDelta,
  CreateMessageRequest,
  FileBlockParam,
  FileObject,
  FileSourceParam,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  MessageUsageDelta,
  OutputBlockStart,
  StopDetails,
  StopReason,
  TextBlock,
  TextBlockParam,
  ThinkingBlock,
  ToolChoice,
  ToolResultBlockParam,
  ToolUseBlock,
  ToolUseBlockParam,
} from './types.js'
