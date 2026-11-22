import { Select, SettingRow } from '@deepseek-chat/spine/design'
import { useSyncExternalStore } from 'react'
import { browserMessages } from './messages.js'
import type { LocalhostPreference } from './prefs.js'

/** 内置浏览器是否允许模型访问 localhost / 内网地址 */
export const createLocalhostSetting = (preference: LocalhostPreference) => {
  const LocalhostSetting = () => {
    const t = browserMessages.useTranslate()
    const allow = useSyncExternalStore(preference.subscribe, preference.get, preference.get)
    return (
      <SettingRow
        label={t('browserAllowLocalhostLabel')}
        description={t('browserAllowLocalhostDescription')}
        action={
          <Select
            ariaLabel={t('browserAllowLocalhostLabel')}
            value={allow ? 'allow' : 'public'}
            options={[
              { value: 'public', label: t('browserAllowLocalhostOff') },
              { value: 'allow', label: t('browserAllowLocalhostOn') },
            ]}
            onChange={(value) => preference.set(value === 'allow')}
          />
        }
      />
    )
  }
  return LocalhostSetting
}
