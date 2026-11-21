import {
  IconDarkOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  Select,
  SettingRow,
  settingStyles,
} from '@deepseek-chat/spine/design'
import { useLocale } from '@deepseek-chat/spine/i18n'
import clsx from 'clsx'
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

  /** 主题项：标题下方浅色 / 深色 / 跟随系统三个选块，与下方语言选项连续排列。 */
  const ThemeSetting = () => {
    const t = preferencesMessages.useTranslate()
    const themePreference = useThemePreference()
    const label = t('themeLabel')
    return (
      <div className={styles.theme}>
        {label}
        <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
          {themeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={themePreference === option.value}
              className={clsx(
                styles.themeOption,
                themePreference === option.value && styles.themeOptionSelected
              )}
              onClick={() => preferences.setThemePreference(option.value)}
            >
              {option.icon}
              {t(option.label)}
            </button>
          ))}
        </div>
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

  /** 中文浏览器按省市选择，其他按国家或地区选择 */
  const LocationSetting = () => {
    const t = preferencesMessages.useTranslate()
    const locale = useLocale()
    const location = useLocation()
    const province =
      location?.region === 'CN'
        ? provinces.find((item) => item.code === location.province)
        : undefined

    return (
      <div className={clsx(settingStyles.cell, settingStyles.row, styles.locationCell)}>
        <div className={clsx(settingStyles.text, styles.locationText)}>
          <div className={settingStyles.label}>{t('locationLabel')}</div>
        </div>
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
                    preferences.setLocation({ region: 'CN', province: province.code, city: value })
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
      </div>
    )
  }

  return { useThemePreference, useLocation, ThemeSetting, LocaleSetting, LocationSetting }
}
