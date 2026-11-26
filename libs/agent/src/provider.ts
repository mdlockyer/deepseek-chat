import type { ApiErrorCondition } from './errors.js'
import type { ModelId, ModelSpec, ProviderId } from './models.js'
import type { CreateMessageRequest, MessageStreamEvent } from './types.js'

export type AttachmentUpload = {
  readonly id: string
  readonly blob: Blob
  readonly name: string
  readonly mimeType: string
  readonly isImage: boolean
}

export type UploadQuotaInfo = {
  readonly code: 'fileCountLimit' | 'storageLimit' | 'parseFailed'
  readonly limit?: string
}

/** Optional server-side file upload capability for providers that reference attachments by remote ID. */
export type ProviderAttachmentPort = {
  /** Uploads a local file/image and returns an opaque provider-side file reference ID. */
  upload(file: AttachmentUpload, signal?: AbortSignal): Promise<string>
  /** Deletes a previously uploaded provider-side file reference (best-effort). */
  delete?(remoteId: string): Promise<void>
  /**
   * When a request fails because provider-side file references expired or went missing, returns
   * the invalid remote IDs (`[]` means all files in the request; `null` means not a file error).
   */
  invalidatedFileIds(error: unknown): string[] | null
  /** Classifies provider upload 400 errors (quota / unsupported parse). */
  classifyUploadError(error: unknown): UploadQuotaInfo | null
  /** Optional provider-specific help URL for managing uploaded files when quota is reached. */
  readonly manageFilesDocsUrl?: string
  /** Optional per-file size limit in MB enforced before upload. */
  maxFileSizeMB?(name: string, isImage: boolean): number
}

/**
 * Provider-neutral streaming model transport contract.
 * Slices depend only on this boundary; provider-specific endpoints, auth headers, file upload
 * protocols, and payload quirks live inside each adapter implementation.
 */
export type ModelProvider = {
  readonly id: ProviderId
  readonly label: string
  readonly defaultModel: ModelId
  readonly models: readonly ModelSpec[]
  /** Whether the provider is configured and ready to send requests (e.g. API key present). */
  isConfigured(): boolean
  /** Resolves context limits and capabilities for a model ID (with a safe fallback for custom IDs). */
  modelSpec(modelId: ModelId): ModelSpec
  /** Streams canonical MessageStreamEvents for a canonical CreateMessageRequest. */
  streamMessage(body: CreateMessageRequest, signal: AbortSignal): AsyncGenerator<MessageStreamEvent>
  /** Classifies transport/API errors into normalized conditions (including contextOverflow). */
  classifyError(error: unknown): ApiErrorCondition
  /** Optional server-side file upload support; absent for providers that inline base64 attachments. */
  readonly attachments?: ProviderAttachmentPort
}
