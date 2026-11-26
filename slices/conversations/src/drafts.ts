import { create } from 'zustand'
import {
  isImage,
  resolveMimeType,
  validateFiles,
  type UploadsController,
  type UploadTask,
} from './attachments.js'
import { createId } from './id.js'
import type { TranslationMessage } from './messages.js'
import type { FileAttachment } from './types.js'

export type DraftAttachment = {
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
}

export type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** Ready to send when there is text or attachments and every attachment upload/prep has finished. */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done') {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      serverProvider: task.providerId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  return { text, files }
}

export const createDraftsController = (
  uploads: Pick<UploadsController, 'uploadAttachment' | 'cancelUpload' | 'validate'>,
  newId: () => string = createId
) => {
  const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
    drafts: new Map(),
  }))

  const getDraft = (sessionId: string | null): Draft =>
    useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

  const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
    useDrafts.setState((state) => {
      const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
      const drafts = new Map(state.drafts)
      if (draft.text || draft.attachments.length > 0) {
        drafts.set(sessionId, draft)
      } else {
        drafts.delete(sessionId)
      }
      return { drafts }
    })

  const setDraftText = (sessionId: string | null, text: string) =>
    updateDraft(sessionId, (draft) => ({ ...draft, text }))

  const upload = (attachment: DraftAttachment) => {
    void uploads
      .uploadAttachment(
        attachment.id,
        attachment.file,
        attachment.file.name,
        resolveMimeType(attachment.file),
        attachment.isImage
      )
      .catch(() => {})
  }

  const addDraftFiles = (sessionId: string | null, files: File[]): TranslationMessage | null => {
    if (files.length === 0) {
      return null
    }
    const validate = uploads.validate ?? validateFiles
    const error = validate(files, getDraft(sessionId).attachments.length)
    if (error) {
      return error
    }
    const added = files.map((file): DraftAttachment => {
      const image = isImage(resolveMimeType(file))
      return {
        id: newId(),
        file,
        isImage: image,
        previewUrl: image ? URL.createObjectURL(file) : null,
      }
    })
    updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
    added.forEach(upload)
    return null
  }

  const retryDraftAttachment = (sessionId: string | null, attachmentId: string) => {
    const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
    if (attachment) {
      upload(attachment)
    }
  }

  const releaseAttachment = (attachment: DraftAttachment, cancel: boolean) => {
    if (cancel) {
      uploads.cancelUpload(attachment.id)
    }
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl)
    }
  }

  const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
    const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
    if (!attachment) {
      return
    }
    releaseAttachment(attachment, true)
    updateDraft(sessionId, (draft) => ({
      ...draft,
      attachments: draft.attachments.filter((item) => item.id !== attachmentId),
    }))
  }

  const clearSentDraft = (sessionId: string | null) => {
    getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, false))
    updateDraft(sessionId, () => EMPTY_DRAFT)
  }

  const clearDraft = (sessionId: string | null) => {
    getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, true))
    updateDraft(sessionId, () => EMPTY_DRAFT)
  }

  const clearAllDrafts = () => {
    for (const draft of useDrafts.getState().drafts.values()) {
      draft.attachments.forEach((attachment) => releaseAttachment(attachment, true))
    }
    useDrafts.setState({ drafts: new Map() })
  }

  return {
    useDrafts,
    getDraft,
    setDraftText,
    addDraftFiles,
    retryDraftAttachment,
    removeDraftAttachment,
    clearSentDraft,
    clearDraft,
    clearAllDrafts,
  }
}

export type DraftsController = ReturnType<typeof createDraftsController>
