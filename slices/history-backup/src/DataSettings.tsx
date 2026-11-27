import {
  Button,
  Dialog,
  IconDownloadOutline16,
  IconUploadOutline14,
  SettingRow,
} from '@deepseek-chat/lib-ui'
import { useLocale, type Locale } from '@deepseek-chat/spine/i18n'
import type { NoticePort } from '@deepseek-chat/spine/ports'
import { useRef, useState } from 'react'
import { BackupError } from './errors.js'
import {
  historyBackupMessages,
  type HistoryBackupMessageKey,
  type HistoryBackupTranslationMessage,
} from './messages.js'
import styles from './DataSettings.module.css'

type Status =
  | (HistoryBackupTranslationMessage & { error?: boolean; reason?: (locale?: Locale) => string })
  | null

export type DataSettingsActions = {
  readonly exportHistory: () => Promise<{ name: string; blob: Blob }>
  readonly importHistory: (file: File) => Promise<number>
  readonly clearHistory: () => Promise<void>
  readonly useSessionState: () => { readonly replacing: boolean; readonly empty: boolean }
  readonly notify: NoticePort
  readonly saveFile?: (name: string, blob: Blob) => Promise<void>
}

export type DataSettingsController = {
  readonly busy: boolean
  readonly deletingBusy: boolean
  readonly importState: {
    readonly file: File | null
    readonly busy: boolean
    readonly status: Status
    readonly select: (file: File) => void
    readonly cancel: () => void
    readonly confirm: () => Promise<void>
  }
  readonly deleteState: {
    readonly opened: boolean
    readonly busy: boolean
    readonly open: () => void
    readonly cancel: () => void
    readonly confirm: () => Promise<void>
  }
}

const errorStatus = (key: HistoryBackupMessageKey, error: unknown): Status => {
  const reason = error instanceof BackupError ? historyBackupMessages.lazy(error.key) : null
  return {
    key,
    ...(reason
      ? { reason }
      : { params: { message: error instanceof Error ? error.message : String(error) } }),
    error: true,
  }
}

export const createDataSettingsViews = (actions: DataSettingsActions) => {
  const useDataSettings = (): DataSettingsController => {
    const [importFile, setImportFile] = useState<File | null>(null)
    const [importBusy, setImportBusy] = useState(false)
    const [importStatus, setImportStatus] = useState<Status>(null)
    const importingRef = useRef(false)

    const [deleteOpened, setDeleteOpened] = useState(false)
    const [deleteBusy, setDeleteBusy] = useState(false)
    const deletingRef = useRef(false)

    const { replacing } = actions.useSessionState()

    const confirmImport = async () => {
      if (!importFile || importingRef.current) {
        return
      }
      importingRef.current = true
      setImportFile(null)
      setImportBusy(true)
      setImportStatus(null)
      try {
        const count = await actions.importHistory(importFile)
        setImportStatus({
          key: count === 1 ? 'historyImportedOne' : 'historyImported',
          params: { count },
        })
      } catch {
        setImportStatus({ key: 'historyImportFailed', error: true })
      } finally {
        importingRef.current = false
        setImportBusy(false)
      }
    }

    const confirmDelete = async () => {
      if (deletingRef.current) {
        return
      }
      deletingRef.current = true
      setDeleteBusy(true)
      try {
        await actions.clearHistory()
        setDeleteOpened(false)
        actions.notify.show({ text: historyBackupMessages.lazy('historyDeleted') })
      } catch {
        actions.notify.show({
          text: historyBackupMessages.lazy('historyDeleteFailed'),
          tone: 'error',
        })
      } finally {
        deletingRef.current = false
        setDeleteBusy(false)
      }
    }

    return {
      busy: importBusy || deleteBusy || replacing,
      deletingBusy: deleteBusy,
      importState: {
        file: importFile,
        busy: importBusy,
        status: importStatus,
        select: setImportFile,
        cancel: () => setImportFile(null),
        confirm: confirmImport,
      },
      deleteState: {
        opened: deleteOpened,
        busy: deleteBusy,
        open: () => setDeleteOpened(true),
        cancel: () => {
          if (!deletingRef.current) {
            setDeleteOpened(false)
          }
        },
        confirm: confirmDelete,
      },
    }
  }

  const DataSettings = ({ controller }: { controller: DataSettingsController }) => {
    const locale = useLocale()
    const t = historyBackupMessages.useTranslate()
    const { empty } = actions.useSessionState()
    const inputRef = useRef<HTMLInputElement>(null)
    const [exportBusy, setExportBusy] = useState(false)
    const [exportStatus, setExportStatus] = useState<Status>(null)
    const { importState, deleteState, busy } = controller

    const onExport = async () => {
      setExportBusy(true)
      setExportStatus(null)
      try {
        const { name, blob } = await actions.exportHistory()
        if (actions.saveFile) {
          await actions.saveFile(name, blob)
        } else {
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = name
          link.click()
          setTimeout(() => URL.revokeObjectURL(url), 10_000)
        }
      } catch (error) {
        setExportStatus(errorStatus('historyExportFailed', error))
      } finally {
        setExportBusy(false)
      }
    }

    return (
      <>
        <SettingRow
          label={t('historyImport')}
          description={t('historyImportDescription')}
          status={
            importState.status
              ? {
                  text: t(
                    importState.status.key,
                    importState.status.reason
                      ? { message: importState.status.reason(locale) }
                      : importState.status.params
                  ),
                  error: importState.status.error,
                }
              : null
          }
          action={
            <>
              <Button
                variant="outlined"
                size="m"
                className={styles.uploadButton}
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                <IconUploadOutline14 />
                {t('upload')}
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) {
                    importState.select(file)
                  }
                }}
              />
            </>
          }
        />
        <SettingRow
          label={t('exportAllLabel')}
          description={t('historyExportDescription')}
          status={
            exportStatus
              ? {
                  text: t(
                    exportStatus.key,
                    exportStatus.reason
                      ? { message: exportStatus.reason(locale) }
                      : exportStatus.params
                  ),
                  error: exportStatus.error,
                }
              : null
          }
          action={
            <Button
              variant="outlined"
              size="m"
              disabled={busy || exportBusy || empty}
              onClick={() => void onExport()}
            >
              <IconDownloadOutline16 />
              {t('exportAllDownload')}
            </Button>
          }
        />
        <SettingRow
          label={t('deleteAllSessions')}
          action={
            <Button variant="dangerOutlined" size="m" disabled={busy} onClick={deleteState.open}>
              {t('delete')}
            </Button>
          }
        />
      </>
    )
  }

  const DataModals = ({ controller }: { controller: DataSettingsController }) => {
    const t = historyBackupMessages.useTranslate()
    const { importState, deleteState } = controller
    return (
      <>
        <Dialog
          open={importState.file !== null}
          title={t('historyImportConfirmTitle')}
          className={styles.importConfirm}
          onClose={importState.cancel}
          footer={
            <>
              <Button variant="outlined" size="m" autoFocus onClick={importState.cancel}>
                {t('cancel')}
              </Button>
              <Button variant="dangerOutlined" size="m" onClick={() => void importState.confirm()}>
                {t('historyImportConfirm')}
              </Button>
            </>
          }
        >
          <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
        </Dialog>
        <Dialog
          open={deleteState.opened}
          title={t('deleteAllSessionsModalTitle')}
          dismissible={!deleteState.busy}
          className={styles.deleteConfirm}
          onClose={deleteState.cancel}
          footer={
            <div className={styles.deleteActions} aria-busy={deleteState.busy}>
              <Button
                variant="outlined"
                autoFocus
                disabled={deleteState.busy}
                onClick={deleteState.cancel}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                loading={deleteState.busy}
                disabled={deleteState.busy}
                onClick={() => void deleteState.confirm()}
              >
                {t(deleteState.busy ? 'historyDeleting' : 'deleteAllSessions')}
              </Button>
            </div>
          }
        >
          {t('deleteAllSessionsModalDescription')}
        </Dialog>
      </>
    )
  }

  return { useDataSettings, DataSettings, DataModals }
}
