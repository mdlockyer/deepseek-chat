import { ApiError } from './client.js'

export type ApiErrorCondition =
  | 'unauthorized'
  | 'insufficientBalance'
  | 'contextOverflow'
  | 'payloadTooLarge'
  | 'rateLimited'
  | 'serverBusy'
  | 'network'
  | 'other'

const CONTEXT_OVERFLOW_PATTERN =
  /maximum context length|context_length_exceeded|prompt is too long|too many tokens|exceeds? (?:the )?(?:model'?s? )?context (?:window|length|limit)|input (?:is )?too long/i

const PAYLOAD_TOO_LARGE_PATTERN =
  /above the API's limit|request (?:entity|body|payload) (?:is )?too large|payload too large/i

export const isContextOverflowMessage = (message: string): boolean =>
  CONTEXT_OVERFLOW_PATTERN.test(message)

export const classifyStatus = (status: number | undefined): ApiErrorCondition => {
  if (status === 401) {
    return 'unauthorized'
  }
  if (status === 402) {
    return 'insufficientBalance'
  }
  if (status === 413) {
    return 'payloadTooLarge'
  }
  if (status === 429) {
    return 'rateLimited'
  }
  if ((status ?? 0) >= 500) {
    return 'serverBusy'
  }
  return 'other'
}

export const classifyApiError = (error: unknown): ApiErrorCondition => {
  if (!(error instanceof ApiError)) {
    return 'other'
  }
  if (
    error.status === 413 ||
    (error.kind === 'protocol' && PAYLOAD_TOO_LARGE_PATTERN.test(error.message))
  ) {
    return 'payloadTooLarge'
  }
  if (
    (error.status === 400 || error.kind === 'stream') &&
    isContextOverflowMessage(error.message)
  ) {
    return 'contextOverflow'
  }
  if (error.status === undefined) {
    return error.kind === 'network' ? 'network' : 'other'
  }
  return classifyStatus(error.status)
}

export const isRetryableApiError = (error: unknown): boolean => {
  const condition = classifyApiError(error)
  return (
    !(error instanceof ApiError) ||
    condition === 'network' ||
    condition === 'rateLimited' ||
    condition === 'serverBusy'
  )
}
