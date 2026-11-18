import { translate, type TranslationMessage } from '../../i18n/index.js'
import { desktopFetch, isDesktopApp } from '../../platform/desktop.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'
/** 请求体上限（字节）：超过约 3–4 MB 时接口网关直接断开，浏览器只能看到网络错误 */
const MAX_REQUEST_BYTES = 3_000_000
/** 普通 REST 接口默认超时（毫秒）；流式对话不设总时长上限 */
export const DEFAULT_REST_TIMEOUT_MS = 15_000
/** 文件上传与解析接口默认超时（毫秒） */
export const UPLOAD_TIMEOUT_MS = 60_000

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly localMessage?: TranslationMessage

  constructor(kind: ApiErrorKind, message: string | TranslationMessage, status?: number) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.localMessage = typeof message === 'string' ? undefined : message
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
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (
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
    response = await (isDesktopApp ? desktopFetch(url, requestInit) : fetch(url, requestInit))
  } catch (error) {
    if (timedOut) {
      throw new ApiError('network', { key: 'requestTimedOut' })
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

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(
    `${API_ORIGIN}/models`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    },
    DEFAULT_REST_TIMEOUT_MS
  )
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(
    `${ANTHROPIC_BASE_URL}/files`,
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

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(
    `${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`,
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
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const json = JSON.stringify({ ...body, stream: true })
  const bytes = new TextEncoder().encode(json).length
  // 实测 3 MB 的请求体正常到达接口，4 MB 的在网关被拒且没有 CORS 头，浏览器只报网络错误。
  if (bytes > MAX_REQUEST_BYTES) {
    throw new ApiError(
      'protocol',
      `This request is ${(bytes / 1e6).toFixed(1)} MB, above the API's limit of about 3 MB. Start a new chat or edit an earlier message to shorten the conversation.`
    )
  }
  const response = await request(`${ANTHROPIC_BASE_URL}/messages`, {
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
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
