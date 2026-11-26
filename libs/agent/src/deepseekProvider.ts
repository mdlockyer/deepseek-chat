import type { HttpFetch } from '@deepseek-chat/spine/ports'
import {
  ApiError,
  DEFAULT_REST_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  readMessagesEventStream,
  request,
} from './client.js'
import { classifyApiError } from './errors.js'
import {
  DEEPSEEK_MODELS,
  DEFAULT_DEEPSEEK_MODEL,
  resolveModelSpec,
  type ModelSpec,
} from './models.js'
import type {
  AttachmentUpload,
  ModelProvider,
  ProviderAttachmentPort,
  UploadQuotaInfo,
} from './provider.js'
import type { CreateMessageRequest, FileObject, MessageParam } from './types.js'

const FILES_BETA = 'files-api-2025-04-14'
const DELETE_FILE_DOCS_URL = 'https://api-docs.deepseek.com/api/delete-file'
const MAX_LAYOUT_SIZE_MB = 64
const MAX_USER_DATA_SIZE_MB = 32
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

type DeepSeekFilePurpose = 'rich_layout_recognition' | 'user_data'

const FILE_ERROR_PATTERNS: readonly RegExp[] = [
  /file_ids do not exist or are not created under your account/i,
  /file data not found for file_id/i,
  /\.source\.file_id: invalid file_id/i,
]

const PARSE_FAILED_PATTERNS: readonly RegExp[] = [
  /You have uploaded an (unsupported|invalid) (file|image)/i,
  /The image is too large to process/i,
  /password-protected/i,
  /Failed to recognize the file/i,
]

const fileExtOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const getDeepSeekUploadPurpose = (name: string, isImage: boolean): DeepSeekFilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(fileExtOf(name)) ? 'rich_layout_recognition' : 'user_data'
}

const parseDeepSeekInvalidatedFileIds = (error: unknown): string[] | null => {
  if (!(error instanceof ApiError) || error.status !== 400) {
    return null
  }
  if (!FILE_ERROR_PATTERNS.some((pattern) => pattern.test(error.message))) {
    return null
  }
  return [...new Set(error.message.match(/file-api-[\w-]+/g) ?? [])]
}

const classifyDeepSeekUploadError = (error: unknown): UploadQuotaInfo | null => {
  if (!(error instanceof ApiError) || error.status !== 400) {
    return null
  }
  const { message } = error
  const count = /User file count limit exceeded.*?limit (\d+)/i.exec(message)
  if (count) {
    return { code: 'fileCountLimit', limit: count[1] }
  }
  const storage = /User storage quota exceeded.*?limit ([\d.]+) GB/i.exec(message)
  if (storage) {
    return { code: 'storageLimit', limit: storage[1] }
  }
  if (PARSE_FAILED_PATTERNS.some((pattern) => pattern.test(message))) {
    return { code: 'parseFailed' }
  }
  return null
}

const usesRemoteFileRef = (messages: readonly MessageParam[]) =>
  messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some(
        (block) =>
          (block.type === 'image' || block.type === 'document') && block.source.type === 'file'
      )
  )

/**
 * Ensures replayed `thinking` blocks always carry a string `signature` (empty string when absent),
 * matching DeepSeek's Anthropic-compatible validator without leaking that requirement into callers.
 */
const serializeDeepSeekMessages = (messages: readonly MessageParam[]): MessageParam[] =>
  messages.map((message) => {
    if (message.role !== 'assistant') {
      return message
    }
    return {
      role: 'assistant',
      content: message.content.map((block) =>
        block.type === 'thinking'
          ? { type: 'thinking', thinking: block.thinking, signature: block.signature ?? '' }
          : block
      ),
    }
  })

export type DeepSeekProviderDeps = {
  readonly fetch: HttpFetch
  readonly apiOrigin: string
  readonly getApiKey: () => string | null
  readonly models?: readonly ModelSpec[]
  /**
   * Optional DeepSeek-only safety check payload. Omitted by default to stay on standard Messages
   * fields; set only if a DeepSeek endpoint requires it.
   */
  readonly safetyCheck?: { readonly level: 'high' }
}

/**
 * Creates a `ModelProvider` backed by DeepSeek's `/anthropic/v1/messages` and Files API endpoints.
 * Keeps all DeepSeek-specific headers, file purposes, and error regexes isolated here.
 */
export const createDeepSeekProvider = (deps: DeepSeekProviderDeps): ModelProvider => {
  const models = deps.models ?? DEEPSEEK_MODELS
  const baseUrl = `${deps.apiOrigin}/anthropic/v1`

  const headers = (beta: boolean): Record<string, string> => ({
    'x-api-key': deps.getApiKey() ?? '',
    ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
  })

  const attachments: ProviderAttachmentPort = {
    upload: async (file: AttachmentUpload, signal?: AbortSignal): Promise<string> => {
      const form = new FormData()
      const purpose = getDeepSeekUploadPurpose(file.name, file.isImage)
      if (purpose) {
        form.append('purpose', purpose)
      }
      const bodyFile =
        file.blob instanceof File
          ? file.blob
          : new File([file.blob], file.name, { type: file.mimeType || file.blob.type })
      form.append('file', bodyFile)
      const response = await request(
        deps.fetch,
        `${baseUrl}/files`,
        {
          method: 'POST',
          headers: headers(true),
          body: form,
          signal,
        },
        UPLOAD_TIMEOUT_MS
      )
      return ((await response.json()) as FileObject).id
    },

    delete: async (remoteId: string): Promise<void> => {
      await request(
        deps.fetch,
        `${baseUrl}/files/${encodeURIComponent(remoteId)}`,
        {
          method: 'DELETE',
          headers: headers(true),
        },
        DEFAULT_REST_TIMEOUT_MS
      )
    },

    invalidatedFileIds: parseDeepSeekInvalidatedFileIds,
    classifyUploadError: classifyDeepSeekUploadError,
    manageFilesDocsUrl: DELETE_FILE_DOCS_URL,
    maxFileSizeMB: (name, isImage) =>
      getDeepSeekUploadPurpose(name, isImage) === 'user_data'
        ? MAX_USER_DATA_SIZE_MB
        : MAX_LAYOUT_SIZE_MB,
  }

  const modelSpec = (modelId: string): ModelSpec => resolveModelSpec(models, 'deepseek', modelId)

  return {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: models[0]?.id ?? DEFAULT_DEEPSEEK_MODEL,
    models,
    isConfigured: () => Boolean(deps.getApiKey()?.trim()),
    modelSpec,
    classifyError: classifyApiError,
    attachments,
    streamMessage: async function* (body: CreateMessageRequest, signal: AbortSignal) {
      const wireBody = {
        ...body,
        messages: serializeDeepSeekMessages(body.messages),
        ...(deps.safetyCheck ? { safety_check: deps.safetyCheck } : {}),
        stream: true,
      }
      const json = JSON.stringify(wireBody)
      const response = await request(deps.fetch, `${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          ...headers(usesRemoteFileRef(body.messages)),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: json,
        signal,
      })
      yield* readMessagesEventStream(response, signal)
    },
  }
}
