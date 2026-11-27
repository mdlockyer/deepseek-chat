import { create } from 'zustand'
import {
  createId,
  EMPTY_DRAFT,
  isImage,
  resolveMimeType,
  validateFiles,
  type Draft,
  type DraftAttachment,
  type DraftsPort,
  type DraftsState,
  type TranslationMessage,
  type UploadsPort,
} from '../../kernel/index.js'

export const createDraftsController = (
  uploads: Pick<UploadsPort, 'uploadAttachment' | 'cancelUpload' | 'validate'>,
  newId: () => string = createId
): DraftsPort => {
  const useDrafts = create<DraftsState>(() => ({
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

export type DraftsController = DraftsPort
