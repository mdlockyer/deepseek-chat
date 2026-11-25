import {
  Button,
  Dialog,
  IconDataOutline16,
  IconDownloadOutline16,
  IconKeyOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
  SettingRow,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  useIsMobile,
} from '@deepseek-chat/lib-ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  account,
  browser,
  notices,
  preferences,
  python,
  voice,
  webResearch,
} from '../composition.js'
import { conversations } from '../conversations.js'
import {
  translate,
  useTranslate,
  type TranslationKey,
  type TranslationMessage,
} from '../i18n/index.js'
import { isDesktopApp } from '../platform/desktop.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  {
    value: 'apiKey',
    label: 'settingDialogAsideApiKeyOptionLabel',
    icon: <IconKeyOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）、「API 密钥」与「数据管理」（导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const t = useTranslate()
  const open = useSettingsDialog((state) => state.open)
  const initialSection = useSettingsDialog((state) => state.section)
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()

  return (
    <>
      <Dialog
        open={open}
        title={t('settings')}
        closable
        dismissible={!historyDelete.busy}
        sheetOnMobile
        size="lg"
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <SettingsContent
          initialSection={initialSection}
          historyImport={historyImport}
          historyDelete={historyDelete}
        />
      </Dialog>
      <ImportConfirm historyImport={historyImport} />
      <DeleteAllConfirm historyDelete={historyDelete} />
    </>
  )
}

const SettingsContent = ({
  initialSection,
  historyImport,
  historyDelete,
}: {
  initialSection: SettingsSection
  historyImport: ReturnType<typeof useHistoryImport>
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const [section, setSection] = useState<SettingsSection>(initialSection)

  useEffect(() => {
    setSection(initialSection)
  }, [initialSection])

  // 切换分组不丢失正在输入的密钥与导入状态
  const accountEditor = account.useKeyEditor()
  const firecrawlEditor = webResearch.useKeyEditor()
  const replacingHistory = conversations.useHistoryState().replacing
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory

  return (
    <Tabs
      value={section}
      onChange={setSection}
      orientation={isMobile ? 'horizontal' : 'vertical'}
      className={styles.tabs}
    >
      <TabList ariaLabel={t('settings')} className={styles.navigation}>
        {sections.map((item) => (
          <Tab key={item.value} value={item.value} icon={item.icon} className={styles.navItem}>
            {t(item.label)}
          </Tab>
        ))}
      </TabList>
      <TabPanel value="general" className={styles.content}>
        <preferences.ThemeSetting />
        <preferences.LocaleSetting />
        <voice.VoiceSetting />
        <preferences.LocationSetting />
        {isDesktopApp ? (
          <>
            <browser.LocalhostSetting />
            <python.RuntimeSetting />
          </>
        ) : null}
      </TabPanel>
      <TabPanel value="apiKey" className={styles.content}>
        <account.KeySettings editor={accountEditor} />
        <webResearch.KeySettings editor={firecrawlEditor} />
      </TabPanel>
      <TabPanel value="data" className={styles.content}>
        <ImportHistory historyImport={historyImport} disabled={historyBusy} />
        <ExportHistory disabled={historyBusy} />
        <SettingRow
          label={t('deleteAllSessions')}
          action={
            <Button
              variant="dangerOutlined"
              size="m"
              disabled={historyBusy}
              onClick={historyDelete.open}
            >
              {t('delete')}
            </Button>
          }
        />
      </TabPanel>
    </Tabs>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Dialog
      open={historyDelete.opened}
      title={t('deleteAllSessionsModalTitle')}
      dismissible={!historyDelete.busy}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            loading={historyDelete.busy}
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Dialog>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await conversations.clearHistory()
      setOpened(false)
      notices.show({ text: () => translate('historyDeleted') })
    } catch {
      notices.show({ text: () => translate('historyDeleteFailed'), tone: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Dialog
      open={historyImport.file !== null}
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Dialog>
  )
}

/** `reason` 给出失败原因的文案，展示时按当前语言生成后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: () => string }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => {
  const reason = conversations.historyErrorText(error)
  return {
    key,
    ...(reason
      ? { reason }
      : { params: { message: error instanceof Error ? error.message : String(error) } }),
    error: true,
  }
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const count = await conversations.importHistory(file)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const status = historyImport.status

  return (
    <SettingRow
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={
        status
          ? {
              text: t(status.key, status.reason ? { message: status.reason() } : status.params),
              error: status.error,
            }
          : null
      }
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={styles.uploadButton}
            disabled={disabled}
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
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = conversations.useHistoryState().empty
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await conversations.exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingRow
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={
        status
          ? {
              text: t(status.key, status.reason ? { message: status.reason() } : status.params),
              error: status.error,
            }
          : null
      }
      action={
        <Button
          variant="outlined"
          size="m"
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
