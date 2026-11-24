import type { HttpFetch } from '@deepseek-chat/spine/ports'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

const FILES_BETA = 'files-api-2025-04-14'
export const MAX_REQUEST_BYTES = 3_000_000
export const DEFAULT_REST_TIMEOUT_MS = 15_000
export const UPLOAD_TIMEOUT_MS = 60_000

export type AgentIO = {
  readonly fetch: HttpFetch
  readonly apiOrigin: string
  readonly apiKey: () => string | null
}

export type ApiErrorKind = 'http' | 'stream' | 'network' | 'interrupted' | 'protocol'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly timedOut?: boolean

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
    options?: { timedOut?: boolean }
  ) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.timedOut = options?.timedOut
  }
}

const extractErrorMessage = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return null
  }
  const { error } = value as { error?: unknown }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message?: unknown }
    if (typeof message === 'string') {
      return message
    }
  }
  return null
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    const extracted = extractErrorMessage(body)
    if (extracted) {
      message = extracted
    }
  } catch {
    // Non-JSON response body: surface raw text.
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (
  fetchFn: HttpFetch,
  url: string,
  init: RequestInit,
  timeoutMs?: number
): Promise<Response> => {
  let controller: AbortController | undefined
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onExternalAbort: (() => void) | undefined

  if (timeoutMs !== undefined && timeoutMs > 0) {
    controller = new AbortController()
    const external = init.signal
    if (external) {
      if (external.aborted) {
        controller.abort(external.reason)
      } else {
        onExternalAbort = () => controller?.abort(external.reason)
        external.addEventListener('abort', onExternalAbort, { once: true })
      }
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => {
        timedOut = true
        controller?.abort()
      }, timeoutMs)
    }
  }

  const requestInit: RequestInit = controller ? { ...init, signal: controller.signal } : init

  let response: Response
  try {
    response = await fetchFn(url, requestInit)
  } catch (error) {
    if (timedOut) {
      throw new ApiError('network', 'Request timed out.', undefined, { timedOut: true })
    }
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    if (onExternalAbort && init.signal) {
      init.signal.removeEventListener('abort', onExternalAbort)
    }
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicBaseUrl = (apiOrigin: string) => `${apiOrigin}/anthropic/v1`

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  'x-api-key': apiKey,
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

export const uploadFile = async (
  io: AgentIO,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const apiKey = io.apiKey() ?? ''
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(
    io.fetch,
    `${anthropicBaseUrl(io.apiOrigin)}/files`,
    {
      method: 'POST',
      headers: anthropicHeaders(apiKey, true),
      body: form,
      signal,
    },
    UPLOAD_TIMEOUT_MS
  )
  return (await response.json()) as FileObject
}

export const deleteFile = async (io: AgentIO, fileId: string): Promise<void> => {
  const apiKey = io.apiKey() ?? ''
  await request(
    io.fetch,
    `${anthropicBaseUrl(io.apiOrigin)}/files/${encodeURIComponent(fileId)}`,
    {
      method: 'DELETE',
      headers: anthropicHeaders(apiKey, true),
    },
    DEFAULT_REST_TIMEOUT_MS
  )
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages (stream: true). Yields validated MessageStreamEvents and ends on
 * `message_stop`. Throws ApiError on HTTP, protocol, stream, network, or premature-EOF errors,
 * and propagates the caller's AbortError on abort.
 */
export async function* streamMessage(
  io: AgentIO,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const json = JSON.stringify({ ...body, stream: true })
  const bytes = new TextEncoder().encode(json).length
  if (bytes > MAX_REQUEST_BYTES) {
    throw new ApiError(
      'protocol',
      `This request is ${(bytes / 1e6).toFixed(1)} MB, above the API's limit of about 3 MB. Start a new chat or edit an earlier message to shorten the conversation.`
    )
  }
  const apiKey = io.apiKey() ?? ''
  const response = await request(io.fetch, `${anthropicBaseUrl(io.apiOrigin)}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: json,
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  throw new ApiError('interrupted', '')
}
