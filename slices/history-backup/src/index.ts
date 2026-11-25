import { noopNoticePort } from '@deepseek-chat/spine/ports'
import { createDataSettingsViews, type DataSettingsController } from './DataSettings.js'
import { BackupError } from './errors.js'
import { exportArchive } from './exportArchive.js'
import { checkArchiveFormat, importArchive } from './importArchive.js'
import { historyBackupMessages } from './messages.js'
import type {
  BackupAssistantMessage,
  BackupFileAttachment,
  BackupMessage,
  BackupReplyBlock,
  BackupReplyStatus,
  BackupSession,
  BackupSessionSummary,
  BackupToolCallPart,
  BackupToolResultPart,
  BackupUserMessage,
  HistoryBackupDeps,
  HistorySessionsPort,
  ToolBlockSerializer,
} from './types.js'

export { BackupError } from './errors.js'
export { readSessionFile } from './schema.js'
export { toSessionFile, type ExportImage, type ToSessionFileOptions } from './toArchive.js'
export { toLocalSession, type LocalSession } from './toLocal.js'
export { ArchiveError, readArchive, readEntry } from './zipReader.js'
export { writeArchive } from './zipWriter.js'
export type {
  BackupAssistantMessage,
  BackupFileAttachment,
  BackupMessage,
  BackupReplyBlock,
  BackupReplyStatus,
  BackupSession,
  BackupSessionSummary,
  BackupToolCallPart,
  BackupToolResultPart,
  BackupUserMessage,
  DataSettingsController,
  HistoryBackupDeps,
  HistorySessionsPort,
  ToolBlockSerializer,
}

const formatDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

export const createHistoryBackupSlice = (deps: HistoryBackupDeps) => {
  const notify = deps.notify ?? noopNoticePort
  const now = deps.now ?? (() => new Date())
  let backupQueue: Promise<unknown> = Promise.resolve()

  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const task = backupQueue.then(run)
    backupQueue = task.catch(() => {})
    return task
  }

  const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
    enqueue(async () => {
      const { summaries, loadSession } = deps.sessions.snapshotForExport()
      async function* readSessions(): AsyncGenerator<BackupSession> {
        for (const summary of summaries) {
          const session = await loadSession(summary.id)
          if (!session) {
            throw new Error(`History session disappeared during export: ${summary.id}`)
          }
          yield { ...session, ...summary }
        }
      }
      const blob = await exportArchive(readSessions(), (id) => deps.blobs.get(id), {
        serializeToolBlock: deps.serializeToolBlock,
        describeReplyNotice: deps.sessions.describeReplyNotice,
      })
      return { name: backupFileName(now()), blob }
    })

  const importHistory = (file: File): Promise<number> =>
    enqueue(async () => {
      await checkArchiveFormat(file)
      return deps.sessions.replaceHistory(() => importArchive(file))
    })

  const clearHistory = (): Promise<void> =>
    enqueue(async () => {
      await deps.sessions.replaceHistory(async () => ({ sessions: [], blobs: [] }))
    })

  const historyErrorText = (error: unknown): (() => string) | null =>
    error instanceof BackupError ? () => historyBackupMessages.translate(error.key) : null

  const views = createDataSettingsViews({
    exportHistory,
    importHistory,
    clearHistory,
    useSessionState: deps.sessions.useState,
    notify,
    saveFile: deps.saveFile,
  })

  return {
    exportHistory,
    importHistory,
    clearHistory,
    historyErrorText,
    ...views,
    dispose: () => {
      // Queue is scoped to this instance; no external subscriptions to detach.
    },
  }
}

export type HistoryBackupSlice = ReturnType<typeof createHistoryBackupSlice>
