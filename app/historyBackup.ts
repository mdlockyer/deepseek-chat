/** The history-backup slice instance wired to conversations, BlobStore, and app notifications. */
import { createHistoryBackupSlice, type BackupSession } from '@deepseek-chat/slice-history-backup'
import type { AssistantMessage, Session } from '@deepseek-chat/slice-conversations'
import { askUser, notices } from './composition.js'
import { conversations } from './conversations.js'
import { saveFile } from './saveFile.js'

export const historyBackup = createHistoryBackupSlice({
  blobs: {
    get: conversations.loadFile,
    put: async () => undefined,
    delete: async () => undefined,
    clear: async () => undefined,
    replaceAll: async () => undefined,
  },
  sessions: {
    snapshotForExport: () => {
      const snap = conversations.snapshotForExport()
      return {
        summaries: snap.summaries,
        loadSession: (id) => snap.loadSession(id) as Promise<BackupSession | undefined>,
      }
    },
    replaceHistory: (prepare) =>
      conversations.replaceSessions(async () => {
        const next = await prepare()
        return {
          sessions: next.sessions as unknown as readonly Session[],
          blobs: next.blobs,
        }
      }),
    useState: conversations.useHistoryState,
    describeReplyNotice: (message) =>
      conversations.describeReplyNotice(message as unknown as AssistantMessage),
  },
  serializeToolBlock: (call, result) => {
    if (askUser.capability.handles(call.name)) {
      return askUser.capability.serializeForArchive?.(call, result) ?? null
    }
    return null
  },
  notify: notices,
  saveFile,
})
