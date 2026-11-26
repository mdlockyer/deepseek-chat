import {
  ApiError as LibApiError,
  DEFAULT_REST_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  request as libRequest,
  type ApiErrorKind,
  type ModelProvider,
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

export const wrapApiError = (error: unknown): never => {
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

/** Wraps a `ModelProvider` so low-level timeout errors surface localized `ApiError` messages. */
export const localizeProvider = (provider: ModelProvider): ModelProvider => {
  const attachments = provider.attachments
  const deleteRemote = attachments?.delete
  return {
    ...provider,
    ...(attachments
      ? {
          attachments: {
            ...attachments,
            upload: async (file, signal) => {
              try {
                return await attachments.upload(file, signal)
              } catch (error) {
                return wrapApiError(error)
              }
            },
            ...(deleteRemote
              ? {
                  delete: async (remoteId) => {
                    try {
                      await deleteRemote(remoteId)
                    } catch (error) {
                      wrapApiError(error)
                    }
                  },
                }
              : {}),
          },
        }
      : {}),
    streamMessage: async function* (body, signal) {
      try {
        yield* provider.streamMessage(body, signal)
      } catch (error) {
        wrapApiError(error)
      }
    },
  }
}
