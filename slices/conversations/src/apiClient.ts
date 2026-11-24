import {
  ApiError as LibApiError,
  DEFAULT_REST_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  deleteFile as libDeleteFile,
  request as libRequest,
  streamMessage as libStreamMessage,
  uploadFile as libUploadFile,
  type AgentIO,
  type ApiErrorKind,
  type CreateMessageRequest,
  type FileObject,
  type FilePurpose,
  type MessageStreamEvent,
} from '@deepseek-chat/lib-agent'
import { deps } from './env.js'
import { translate, type TranslationMessage } from './messages.js'

export { DEFAULT_REST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, type ApiErrorKind }

export class ApiError extends LibApiError {
  readonly localMessage?: TranslationMessage

  constructor(kind: ApiErrorKind, message: string | TranslationMessage, status?: number) {
    super(
      kind,
      typeof message === 'string' ? message : translate(message.key, message.params),
      status
    )
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const wrapApiError = (error: unknown): never => {
  if (error instanceof ApiError) {
    throw error
  }
  if (error instanceof LibApiError) {
    if (error.timedOut) {
      throw new ApiError('network', { key: 'requestTimedOut' })
    }
    throw new ApiError(error.kind, error.message, error.status)
  }
  throw error
}

export const createAgentIO = (apiKeyOverride?: string): AgentIO => ({
  fetch: deps().fetch,
  apiOrigin: deps().apiOrigin,
  apiKey: () => apiKeyOverride ?? deps().getApiKey(),
})

export const request = async (
  url: string,
  init: RequestInit,
  timeoutMs?: number
): Promise<Response> => {
  try {
    return await libRequest(deps().fetch, url, init, timeoutMs)
  } catch (error) {
    return wrapApiError(error)
  }
}

export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  try {
    return await libUploadFile(createAgentIO(apiKey), file, purpose, signal)
  } catch (error) {
    return wrapApiError(error)
  }
}

export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  try {
    await libDeleteFile(createAgentIO(apiKey), fileId)
  } catch (error) {
    wrapApiError(error)
  }
}

export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  try {
    yield* libStreamMessage(createAgentIO(apiKey), body, signal)
  } catch (error) {
    wrapApiError(error)
  }
}
