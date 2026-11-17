import { useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setApiKey } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

/** 输入 API Key 后先用 GET /models 校验，通过才保存 */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [testing, setTesting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [verified, setVerified] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const [emptySubmitted, setEmptySubmitted] = useState(false)

  const formatCause = (cause: unknown) =>
    classifyApiError(cause) === 'unauthorized'
      ? t('apiKeyInvalid')
      : classifyApiError(cause) === 'network'
        ? t('commonNetworkErrorToast')
        : t('apiKeyVerificationFailed', {
            message:
              cause instanceof ApiError && cause.localMessage
                ? t(cause.localMessage.key, cause.localMessage.params)
                : cause instanceof Error
                  ? cause.message
                  : String(cause),
          })

  const error = emptySubmitted
    ? t('apiKeyPlaceholder')
    : failure === null
      ? null
      : formatCause(failure.cause)

  const updateValue = (next: string) => {
    setValue(next)
    if (emptySubmitted && next.trim()) {
      setEmptySubmitted(false)
    }
    if (failure) {
      setFailure(null)
    }
  }

  const resetForm = () => {
    setValue('')
    setFailure(null)
    setEmptySubmitted(false)
  }

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey) {
      setEmptySubmitted(true)
      return
    }
    if (verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    setEmptySubmitted(false)
    try {
      await verifyApiKey(apiKey)
      await setApiKey(apiKey)
      setValue('')
      setVerified(true)
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  const testExisting = async (apiKey: string) => {
    if (!apiKey || testing) {
      return
    }
    setTesting(true)
    setVerified(false)
    setFailure(null)
    try {
      await verifyApiKey(apiKey)
      setVerified(true)
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setTesting(false)
    }
  }

  const clear = async () => {
    if (clearing) {
      return
    }
    setClearing(true)
    setFailure(null)
    setVerified(false)
    try {
      await setApiKey(null)
      resetForm()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setClearing(false)
    }
  }

  return {
    value,
    setValue: updateValue,
    verifying,
    testing,
    clearing,
    verified,
    error,
    submit,
    testExisting,
    clear,
    resetForm,
    clearFeedback: () => {
      setFailure(null)
      setVerified(false)
      setEmptySubmitted(false)
    },
  }
}
