import { Button, SettingRow } from '@deepseek-chat/lib-ui'
import { useEffect, useState } from 'react'
import type { NativeRuntimeStatus } from './kernel.js'
import { pythonMessages } from './messages.js'

type MessageKey = Parameters<typeof pythonMessages.translate>[0]

/** Kept as a key so the status re-translates when the language changes. */
type Status = { key: MessageKey; params?: Record<string, string>; error?: boolean } | null

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type ManagedRuntime = {
  status(): Promise<NativeRuntimeStatus>
  reset(): Promise<void>
}

/** 桌面端托管 Python 运行环境状态查看与重置 */
export const createRuntimeSetting = (managed: ManagedRuntime | null) => {
  const RuntimeSetting = () => {
    const t = pythonMessages.useTranslate()
    const [runtime, setRuntime] = useState<NativeRuntimeStatus | null>(null)
    const [loading, setLoading] = useState(managed !== null)
    const [resetting, setResetting] = useState(false)
    const [status, setStatus] = useState<Status>(null)

    useEffect(() => {
      if (!managed) {
        return
      }
      let active = true
      void managed
        .status()
        .then((info) => {
          if (active) {
            setRuntime(info)
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setStatus({
              key: 'settingsPythonRuntimeLoadFailed',
              params: { message: messageOf(error) },
              error: true,
            })
          }
        })
        .finally(() => {
          if (active) {
            setLoading(false)
          }
        })
      return () => {
        active = false
      }
    }, [])

    if (!managed) {
      return null
    }

    const onReset = async () => {
      setResetting(true)
      setStatus(null)
      try {
        await managed.reset()
        setRuntime(await managed.status())
        setStatus({ key: 'settingsPythonRuntimeResetDone' })
      } catch (error) {
        setStatus({
          key: 'settingsPythonRuntimeResetFailed',
          params: { message: messageOf(error) },
          error: true,
        })
      } finally {
        setResetting(false)
      }
    }

    const description = loading
      ? t('settingsPythonRuntimeChecking')
      : runtime?.ready
        ? t('settingsPythonRuntimeReady', {
            version: runtime.version,
            packages: runtime.packages.join(', '),
          })
        : runtime
          ? t('settingsPythonRuntimeNotInstalled', { version: runtime.version })
          : undefined

    return (
      <SettingRow
        label={t('settingsPythonRuntime')}
        description={description}
        status={
          status ? { text: t(status.key, status.params), error: status.error ?? false } : null
        }
        action={
          <Button
            variant="outlined"
            size="m"
            loading={resetting}
            disabled={loading || resetting || !runtime?.ready}
            onClick={() => void onReset()}
          >
            {t(resetting ? 'settingsPythonRuntimeResetting' : 'settingsPythonRuntimeReset')}
          </Button>
        }
      />
    )
  }
  return RuntimeSetting
}
