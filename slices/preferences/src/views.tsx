import {
  IconDarkOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  RadioCardGroup,
  Select,
  SettingRow,
} from '@deepseek-chat/lib-ui'
import { useLocale } from '@deepseek-chat/spine/i18n'
import { useSyncExternalStore, type ReactNode } from 'react'
import { getRegionName, provinces, regionCodes } from './location.js'
import { preferencesMessages } from './messages.js'
import type { Preferences, ThemePreference } from './preferences.js'
import styles from './preferences.module.css'

type MessageKey = Parameters<typeof preferencesMessages.translate>[0]

const themeOptions: { value: ThemePreference; label: MessageKey; icon: ReactNode }[] = [
  { value: 'light', label: 'themeLight', icon: <IconLightOutline16 /> },
  { value: 'dark', label: 'themeDark', icon: <IconDarkOutline16 /> },
  { value: 'system', label: 'themeSystem', icon: <IconFollowsystemOutline16 /> },
]

export const createViews = (preferences: Preferences) => {
  const useThemePreference = () =>
    useSyncExternalStore(
      preferences.subscribe,
      preferences.getThemePreference,
      preferences.getThemePreference
    )
  const useLocation = () =>
    useSyncExternalStore(preferences.subscribe, preferences.getLocation, preferences.getLocation)

  const ThemeSetting = () => {
    const t = preferencesMessages.useTranslate()
    const themePreference = useThemePreference()
    const label = t('themeLabel')
    return (
      <div className={styles.theme}>
        <div className={styles.themeLabel}>{label}</div>
        <RadioCardGroup
          ariaLabel={label}
          className={styles.themeOptions}
          value={themePreference}
          options={themeOptions.map((option) => ({
            value: option.value,
            label: t(option.label),
            icon: option.icon,
          }))}
          onChange={preferences.setThemePreference}
        />
      </div>
    )
  }

  const LocaleSetting = () => {
    const t = preferencesMessages.useTranslate()
    const locale = useLocale()
    return (
      <SettingRow
        label={t('localeLabel')}
        action={
          <Select
            ariaLabel={t('localeLabel')}
            value={locale}
            options={[
              { value: 'zh-CN', label: t('localeZhCN'), lang: 'zh-CN' },
              { value: 'en-US', label: t('localeEnUS'), lang: 'en' },
            ]}
            onChange={preferences.setLocale}
          />
        }
      />
    )
  }

  const LocationSetting = () => {
    const t = preferencesMessages.useTranslate()
    const locale = useLocale()
    const location = useLocation()
    const province =
      location?.region === 'CN'
        ? provinces.find((item) => item.code === location.province)
        : undefined

    return (
      <SettingRow
        label={t('locationLabel')}
        className={styles.locationCell}
        action={
          <div className={styles.locationSelectors}>
            {preferences.usesProvinceLocation ? (
              <>
                <Select
                  ariaLabel={t('locationProvince')}
                  className={styles.provinceSelect}
                  value={province?.code ?? ''}
                  placeholder={t('locationProvince')}
                  options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                  onChange={(value) => {
                    if (value !== province?.code) {
                      preferences.setLocation({ region: 'CN', province: value })
                    }
                  }}
                />
                <Select
                  ariaLabel={t('locationCity')}
                  className={styles.citySelect}
                  value={province ? (location?.city ?? '') : ''}
                  disabled={!province?.cities.length}
                  placeholder={t('locationCity')}
                  options={
                    province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                  }
                  onChange={(value) => {
                    if (province) {
                      preferences.setLocation({
                        region: 'CN',
                        province: province.code,
                        city: value,
                      })
                    }
                  }}
                />
              </>
            ) : (
              <Select
                ariaLabel={t('locationRegion')}
                className={styles.regionSelect}
                value={location?.region ?? ''}
                placeholder={t('locationRegion')}
                options={regionCodes
                  .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                  .sort((a, b) => a.label.localeCompare(b.label, locale))}
                onChange={(value) => preferences.setLocation({ region: value })}
              />
            )}
          </div>
        }
      />
    )
  }

  return { useThemePreference, useLocation, ThemeSetting, LocaleSetting, LocationSetting }
}
