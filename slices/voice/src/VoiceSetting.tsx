import { Select, SettingRow } from '@deepseek-chat/spine/design'
import { useSyncExternalStore } from 'react'
import { voiceMessages } from './messages.js'
import type { VoicePreference } from './voicePreference.js'

/** 朗读音色设置：stella（海星，女声）/ tide（暗潮，男声） */
export const createVoiceSetting = (preference: VoicePreference) => {
  const VoiceSetting = () => {
    const t = voiceMessages.useTranslate()
    const voice = useSyncExternalStore(preference.subscribe, preference.get, preference.get)
    return (
      <SettingRow
        label={t('settingsTtsVoice')}
        action={
          <Select
            ariaLabel={t('settingsTtsVoice')}
            value={voice}
            options={[
              { value: 'stella', label: t('settingsTtsVoiceStella') },
              { value: 'tide', label: t('settingsTtsVoiceTide') },
            ]}
            onChange={preference.set}
          />
        }
      />
    )
  }
  return VoiceSetting
}
