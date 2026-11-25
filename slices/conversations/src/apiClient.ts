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
import type { HttpFetch } from '@deepseek-chat/spine/ports'
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

export type ApiClient = {
  request(url: string, init: RequestInit, timeoutMs?: number): Promise<Response>
  uploadFile(
    apiKey: string,
    file: File,
    purpose: FilePurpose | null,
    signal?: AbortSignal
  ): Promise<FileObject>
  deleteFile(apiKey: string, fileId: string): Promise<void>
  streamMessage(
    apiKey: string,
    body: CreateMessageRequest,
    signal: AbortSignal
  ): AsyncGenerator<MessageStreamEvent>
}

export const requestWith = async (
  fetchFn: HttpFetch,
  url: string,
  init: RequestInit,
  timeoutMs?: number
): Promise<Response> => {
  try {
    return await libRequest(fetchFn, url, init, timeoutMs)
  } catch (error) {
    return wrapApiError(error)
  }
}

export const createApiClient = (deps: {
  readonly fetch: HttpFetch
  readonly apiOrigin: string
  readonly getApiKey: () => string | null
}): ApiClient => {
  const ioFor = (apiKeyOverride?: string): AgentIO => ({
    fetch: deps.fetch,
    apiOrigin: deps.apiOrigin,
    apiKey: () => apiKeyOverride ?? deps.getApiKey(),
  })

  return {
    request: (url, init, timeoutMs) => requestWith(deps.fetch, url, init, timeoutMs),

    uploadFile: async (apiKey, file, purpose, signal) => {
      try {
        return await libUploadFile(ioFor(apiKey), file, purpose, signal)
      } catch (error) {
        return wrapApiError(error)
      }
    },

    deleteFile: async (apiKey, fileId) => {
      try {
        await libDeleteFile(ioFor(apiKey), fileId)
      } catch (error) {
        wrapApiError(error)
      }
    },

    streamMessage: async function* (apiKey, body, signal) {
      try {
        yield* libStreamMessage(ioFor(apiKey), body, signal)
      } catch (error) {
        wrapApiError(error)
      }
    },
  }
}
