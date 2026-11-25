import {
  Dialog,
  IconDataOutline16,
  IconKeyOutline16,
  IconSettingsOutline16,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  useIsMobile,
} from '@deepseek-chat/lib-ui'
import type { SettingsSection } from '@deepseek-chat/slice-conversations'
import type {
  DataSettingsController,
  HistoryBackupSlice,
} from '@deepseek-chat/slice-history-backup'
import type { WebResearchSlice } from '@deepseek-chat/slice-web-research'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../i18n/index.js'
import { useAppRuntime } from '../RuntimeContext.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗壳层：分「通用设置」、「API 密钥」与「数据管理」，每个分组的行与弹窗完全由各自 slice 拥有。
 * 未挂载的切片自动省略其行或分组。
 */
export const SettingsDialog = () => {
  const { slices } = useAppRuntime()
  if (slices.historyBackup) {
    return <SettingsDialogWithBackup historyBackup={slices.historyBackup} />
  }
  return <SettingsDialogFrame dataSettings={null} historyBackup={null} />
}

const SettingsDialogWithBackup = ({ historyBackup }: { historyBackup: HistoryBackupSlice }) => {
  const dataSettings = historyBackup.useDataSettings()
  return (
    <>
      <SettingsDialogFrame dataSettings={dataSettings} historyBackup={historyBackup} />
      <historyBackup.DataModals controller={dataSettings} />
    </>
  )
}

const SettingsDialogFrame = ({
  dataSettings,
  historyBackup,
}: {
  dataSettings: DataSettingsController | null
  historyBackup: HistoryBackupSlice | null
}) => {
  const t = useTranslate()
  const { settingsDialog } = useAppRuntime()
  const open = settingsDialog.useStore((state) => state.open)
  const initialSection = settingsDialog.useStore((state) => state.section)
  const busy = dataSettings?.deletingBusy ?? false

  return (
    <Dialog
      open={open}
      title={t('settings')}
      closable
      dismissible={!busy}
      sheetOnMobile
      size="lg"
      className={styles.dialog}
      mainClassName={styles.dialogMain}
      onClose={() => {
        if (!busy) {
          settingsDialog.close()
        }
      }}
    >
      <SettingsContent
        initialSection={initialSection}
        dataSettings={dataSettings}
        historyBackup={historyBackup}
      />
    </Dialog>
  )
}

const WebResearchKeyPanel = ({ webResearch }: { webResearch: WebResearchSlice }) => {
  const editor = webResearch.useKeyEditor()
  return <webResearch.KeySettings editor={editor} />
}

const SettingsContent = ({
  initialSection,
  dataSettings,
  historyBackup,
}: {
  initialSection: SettingsSection
  dataSettings: DataSettingsController | null
  historyBackup: HistoryBackupSlice | null
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { platform, slices } = useAppRuntime()
  const { account, browser, preferences, python, voice, webResearch } = slices

  const hasGeneral = Boolean(
    preferences || voice || (platform === 'desktop' && (browser || python))
  )
  const availableSections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
    ...(hasGeneral
      ? [
          {
            value: 'general' as const,
            label: 'settingDialogAsideGeneralOptionLabel' as const,
            icon: <IconSettingsOutline16 />,
          },
        ]
      : []),
    {
      value: 'apiKey',
      label: 'settingDialogAsideApiKeyOptionLabel',
      icon: <IconKeyOutline16 />,
    },
    ...(historyBackup && dataSettings
      ? [
          {
            value: 'data' as const,
            label: 'settingDialogAsideDataOptionLabel' as const,
            icon: <IconDataOutline16 />,
          },
        ]
      : []),
  ]

  const hasData = Boolean(historyBackup && dataSettings)
  const resolveSection = (wanted: SettingsSection): SettingsSection => {
    if (wanted === 'general' && hasGeneral) {
      return 'general'
    }
    if (wanted === 'data' && hasData) {
      return 'data'
    }
    if (wanted === 'apiKey') {
      return 'apiKey'
    }
    return hasGeneral ? 'general' : 'apiKey'
  }

  const [section, setSection] = useState<SettingsSection>(() => resolveSection(initialSection))

  useEffect(() => {
    setSection(
      initialSection === 'general' && hasGeneral
        ? 'general'
        : initialSection === 'data' && hasData
          ? 'data'
          : initialSection === 'apiKey'
            ? 'apiKey'
            : hasGeneral
              ? 'general'
              : 'apiKey'
    )
  }, [hasData, hasGeneral, initialSection])

  const accountEditor = account.useKeyEditor()

  return (
    <Tabs
      value={section}
      onChange={setSection}
      orientation={isMobile ? 'horizontal' : 'vertical'}
      className={styles.tabs}
    >
      <TabList ariaLabel={t('settings')} className={styles.navigation}>
        {availableSections.map((item) => (
          <Tab key={item.value} value={item.value} icon={item.icon} className={styles.navItem}>
            {t(item.label)}
          </Tab>
        ))}
      </TabList>
      {hasGeneral ? (
        <TabPanel value="general" className={styles.content}>
          {preferences ? (
            <>
              <preferences.ThemeSetting />
              <preferences.LocaleSetting />
            </>
          ) : null}
          {voice ? <voice.VoiceSetting /> : null}
          {preferences ? <preferences.LocationSetting /> : null}
          {platform === 'desktop' ? (
            <>
              {browser ? <browser.LocalhostSetting /> : null}
              {python ? <python.RuntimeSetting /> : null}
            </>
          ) : null}
        </TabPanel>
      ) : null}
      <TabPanel value="apiKey" className={styles.content}>
        <account.KeySettings editor={accountEditor} />
        {webResearch ? <WebResearchKeyPanel webResearch={webResearch} /> : null}
      </TabPanel>
      {historyBackup && dataSettings ? (
        <TabPanel value="data" className={styles.content}>
          <historyBackup.DataSettings controller={dataSettings} />
        </TabPanel>
      ) : null}
    </Tabs>
  )
}
