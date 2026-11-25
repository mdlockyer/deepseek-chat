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
import { useEffect, useState, type ReactNode } from 'react'
import { account, browser, preferences, python, voice, webResearch } from '../composition.js'
import { historyBackup } from '../historyBackup.js'
import { useTranslate, type TranslationKey } from '../i18n/index.js'
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
 * 设置弹窗壳层：分「通用设置」、「API 密钥」与「数据管理」，每个分组的行与弹窗完全由各自 slice 拥有。
 */
export const SettingsDialog = () => {
  const t = useTranslate()
  const open = useSettingsDialog((state) => state.open)
  const initialSection = useSettingsDialog((state) => state.section)
  const dataSettings = historyBackup.useDataSettings()

  return (
    <>
      <Dialog
        open={open}
        title={t('settings')}
        closable
        dismissible={!dataSettings.deletingBusy}
        sheetOnMobile
        size="lg"
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!dataSettings.deletingBusy) {
            closeSettings()
          }
        }}
      >
        <SettingsContent initialSection={initialSection} dataSettings={dataSettings} />
      </Dialog>
      <historyBackup.DataModals controller={dataSettings} />
    </>
  )
}

const SettingsContent = ({
  initialSection,
  dataSettings,
}: {
  initialSection: SettingsSection
  dataSettings: ReturnType<typeof historyBackup.useDataSettings>
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const [section, setSection] = useState<SettingsSection>(initialSection)

  useEffect(() => {
    setSection(initialSection)
  }, [initialSection])

  // 切换分组不丢失正在输入的密钥
  const accountEditor = account.useKeyEditor()
  const firecrawlEditor = webResearch.useKeyEditor()

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
        <historyBackup.DataSettings controller={dataSettings} />
      </TabPanel>
    </Tabs>
  )
}
