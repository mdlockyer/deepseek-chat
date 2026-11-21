import { useState } from 'react'

/** Outcome of checking a secret key against its service. */
export type KeyCheck =
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'failed'; readonly message: string }

/** Masks a key for display: a short prefix, ten dots, the last four characters. */
export const maskSecret = (key: string) => {
  if (key.length <= 8) {
    return '•'.repeat(Math.max(4, key.length))
  }
  const prefix = key.startsWith('sk-') || key.startsWith('fc-') ? key.slice(0, 3) : key.slice(0, 2)
  return `${prefix}${'•'.repeat(10)}${key.slice(-4)}`
}

export type SecretKeyFormOptions = {
  verify: (key: string) => Promise<KeyCheck>
  save: (key: string | null) => Promise<void>
  onSaved?: () => void
  /** User-facing wording; called at render time so it follows the current locale. */
  messages: {
    empty: () => string
    invalid: () => string
    unreachable: () => string
    failed: (message: string) => string
  }
}

type Failure =
  | { readonly kind: 'empty' }
  | { readonly kind: 'check'; readonly check: Exclude<KeyCheck, { kind: 'valid' }> }

const failedCheck = (error: unknown): Failure => ({
  kind: 'check',
  check: { kind: 'failed', message: error instanceof Error ? error.message : String(error) },
})

/** Form state for entering, testing and removing a secret key: verify first, save only if valid. */
export const useSecretKeyForm = ({ verify, save, onSaved, messages }: SecretKeyFormOptions) => {
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [testing, setTesting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [verified, setVerified] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  const describe = (current: Failure): string => {
    if (current.kind === 'empty') {
      return messages.empty()
    }
    const { check } = current
    return check.kind === 'invalid'
      ? messages.invalid()
      : check.kind === 'unreachable'
        ? messages.unreachable()
        : messages.failed(check.message)
  }

  const updateValue = (next: string) => {
    setValue(next)
    if (failure?.kind === 'empty' ? next.trim() : failure) {
      setFailure(null)
    }
  }

  const resetForm = () => {
    setValue('')
    setFailure(null)
  }

  /** Runs `verify`; returns true when valid, otherwise records why not. */
  const check = async (key: string) => {
    try {
      const result = await verify(key)
      if (result.kind === 'valid') {
        return true
      }
      setFailure({ kind: 'check', check: result })
    } catch (error) {
      setFailure(failedCheck(error))
    }
    return false
  }

  const submit = async () => {
    const key = value.trim()
    if (!key) {
      setFailure({ kind: 'empty' })
      return
    }
    if (verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      if (await check(key)) {
        await save(key)
        setValue('')
        setVerified(true)
        onSaved?.()
      }
    } catch (error) {
      setFailure(failedCheck(error))
    } finally {
      setVerifying(false)
    }
  }

  const testExisting = async (key: string) => {
    if (!key || testing) {
      return
    }
    setTesting(true)
    setVerified(false)
    setFailure(null)
    try {
      setVerified(await check(key))
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
      await save(null)
      resetForm()
    } catch (error) {
      setFailure(failedCheck(error))
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
    error: failure === null ? null : describe(failure),
    submit,
    testExisting,
    clear,
    resetForm,
    clearFeedback: () => {
      setFailure(null)
      setVerified(false)
    },
  }
}

export type SecretKeyForm = ReturnType<typeof useSecretKeyForm>
