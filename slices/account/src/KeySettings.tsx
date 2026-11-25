import {
  Badge,
  Button,
  IconCheckOutline16,
  IconKeyOutline16,
  IconRightUpOutline14,
  IconToastError16,
  LinkButton,
  PasswordField,
  SettingInlineConfirm,
  SettingRow,
  useIsMobile,
} from '@deepseek-chat/lib-ui'
import { useState, useSyncExternalStore } from 'react'
import type { Account, KeyCheck } from './account.js'
import { accountMessages } from './messages.js'
import styles from './KeySettings.module.css'

const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys'

type KeyFailure =
  | { readonly kind: 'empty' }
  | { readonly kind: 'check'; readonly check: Exclude<KeyCheck, { kind: 'valid' }> }

type KeyEditorPhase =
  | { readonly kind: 'viewing'; readonly verified: boolean; readonly error: KeyFailure | null }
  | { readonly kind: 'testing' }
  | { readonly kind: 'confirmingRemove'; readonly error: KeyFailure | null }
  | { readonly kind: 'clearing' }
  | { readonly kind: 'editing'; readonly draft: string; readonly error: KeyFailure | null }
  | { readonly kind: 'verifying'; readonly draft: string }

const maskDeepSeekKey = (key: string): string => {
  if (key.length <= 8) {
    return '•'.repeat(Math.max(4, key.length))
  }
  const prefix = key.startsWith('sk-') ? key.slice(0, 3) : key.slice(0, 2)
  return `${prefix}${'•'.repeat(10)}${key.slice(-4)}`
}

const failedCheck = (error: unknown): KeyFailure => ({
  kind: 'check',
  check: { kind: 'failed', message: error instanceof Error ? error.message : String(error) },
})

const describeFailure = (
  failure: KeyFailure | null,
  tr: ReturnType<typeof accountMessages.useTranslate>
): string | null => {
  if (!failure) {
    return null
  }
  if (failure.kind === 'empty') {
    return tr('apiKeyPlaceholder')
  }
  const { check } = failure
  return check.kind === 'invalid'
    ? tr('apiKeyInvalid')
    : check.kind === 'unreachable'
      ? tr('networkError')
      : tr('apiKeyVerificationFailed', { message: check.message })
}

/** Editor state for the key view; held by the settings dialog so typed input survives tab switches. */
export const createUseKeyEditor = (account: Account) => () => {
  const state = useSyncExternalStore(account.subscribe, account.getState, account.getState)
  const apiKey = state.status === 'ready' ? state.apiKey : null
  const [phase, setPhase] = useState<KeyEditorPhase>({
    kind: 'viewing',
    verified: false,
    error: null,
  })

  const setDraft = (draft: string) => {
    setPhase((prev) => {
      if (prev.kind === 'editing') {
        const clearError =
          prev.error?.kind === 'empty' ? Boolean(draft.trim()) : prev.error !== null
        return { kind: 'editing', draft, error: clearError ? null : prev.error }
      }
      return { kind: 'editing', draft, error: null }
    })
  }

  const startEdit = () => setPhase({ kind: 'editing', draft: '', error: null })
  const cancelEdit = () => setPhase({ kind: 'viewing', verified: false, error: null })
  const openRemoveConfirm = () => setPhase({ kind: 'confirmingRemove', error: null })
  const cancelRemoveConfirm = () => setPhase({ kind: 'viewing', verified: false, error: null })

  const submit = async () => {
    const rawDraft = phase.kind === 'editing' ? phase.draft : ''
    const trimmed = rawDraft.trim()
    if (!trimmed) {
      setPhase({ kind: 'editing', draft: rawDraft, error: { kind: 'empty' } })
      return
    }
    if (phase.kind === 'verifying') {
      return
    }
    setPhase({ kind: 'verifying', draft: rawDraft })
    try {
      const result = await account.verifyKey(trimmed)
      if (result.kind !== 'valid') {
        setPhase({ kind: 'editing', draft: rawDraft, error: { kind: 'check', check: result } })
        return
      }
      await account.setApiKey(trimmed)
      setPhase({ kind: 'viewing', verified: true, error: null })
    } catch (error) {
      setPhase({ kind: 'editing', draft: rawDraft, error: failedCheck(error) })
    }
  }

  const testExisting = async () => {
    if (!apiKey || phase.kind === 'testing' || phase.kind === 'clearing') {
      return
    }
    setPhase({ kind: 'testing' })
    try {
      const result = await account.verifyKey(apiKey)
      if (result.kind === 'valid') {
        setPhase({ kind: 'viewing', verified: true, error: null })
      } else {
        setPhase({ kind: 'viewing', verified: false, error: { kind: 'check', check: result } })
      }
    } catch (error) {
      setPhase({ kind: 'viewing', verified: false, error: failedCheck(error) })
    }
  }

  const clear = async () => {
    if (phase.kind === 'clearing') {
      return
    }
    setPhase({ kind: 'clearing' })
    try {
      await account.setApiKey(null)
      setPhase({ kind: 'viewing', verified: false, error: null })
    } catch (error) {
      setPhase({ kind: 'viewing', verified: false, error: failedCheck(error) })
    }
  }

  return {
    apiKey,
    phase,
    setDraft,
    startEdit,
    cancelEdit,
    openRemoveConfirm,
    cancelRemoveConfirm,
    submit,
    testExisting,
    clear,
  }
}

export type KeyEditor = ReturnType<ReturnType<typeof createUseKeyEditor>>

export const createKeySettings = (account: Account) => {
  const KeySettings = ({ editor }: { editor: KeyEditor }) => {
    const tr = accountMessages.useTranslate()
    const isMobile = useIsMobile()
    const { apiKey, phase } = editor
    const editingExisting = phase.kind === 'editing' || phase.kind === 'verifying'
    const showInput = !apiKey || editingExisting
    const draft = phase.kind === 'editing' || phase.kind === 'verifying' ? phase.draft : ''
    const verifying = phase.kind === 'verifying'
    const testing = phase.kind === 'testing'
    const clearing = phase.kind === 'clearing'
    const verified = phase.kind === 'viewing' && phase.verified
    const errorMessage = describeFailure(
      phase.kind === 'editing' || phase.kind === 'viewing' || phase.kind === 'confirmingRemove'
        ? phase.error
        : null,
      tr
    )

    return (
      <>
        <SettingRow stack>
          <div className={styles.secret}>
            <div className={styles.header}>
              <div className={styles.title}>{tr('apiKeyLabel')}</div>
              {!showInput && verified ? (
                <Badge tone="success" icon={<IconCheckOutline16 />}>
                  {tr('apiKeyVerified')}
                </Badge>
              ) : null}
            </div>

            {showInput ? (
              <>
                <PasswordField
                  hint={tr('apiKeyStart')}
                  placeholder={tr('apiKeyPlaceholder')}
                  showLabel={tr('apiKeyShow')}
                  hideLabel={tr('apiKeyHide')}
                  error={errorMessage}
                  autoFocus={!isMobile || editingExisting}
                  value={draft}
                  onChange={(event) => editor.setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      void editor.submit()
                    } else if (event.key === 'Escape' && editingExisting && apiKey) {
                      event.stopPropagation()
                      editor.cancelEdit()
                    }
                  }}
                />
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    size="m"
                    loading={verifying}
                    disabled={verifying}
                    onClick={() => void editor.submit()}
                  >
                    {verifying ? tr('apiKeyVerifying') : tr('save')}
                  </Button>
                  {editingExisting && apiKey ? (
                    <Button
                      variant="outlined"
                      size="m"
                      disabled={verifying}
                      onClick={editor.cancelEdit}
                    >
                      {tr('cancel')}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className={styles.savedBox}>
                  <span className={styles.savedIcon}>
                    <IconKeyOutline16 />
                  </span>
                  <span className={styles.savedMask}>{maskDeepSeekKey(apiKey ?? '')}</span>
                </div>
                {errorMessage ? (
                  <div className={styles.errorRow} role="alert">
                    <IconToastError16 />
                    <span>{errorMessage}</span>
                  </div>
                ) : null}
                <div className={styles.actions}>
                  <Button
                    variant="outlined"
                    size="m"
                    disabled={testing || clearing}
                    onClick={editor.startEdit}
                  >
                    {tr('apiKeyChange')}
                  </Button>
                  <Button
                    variant="outlined"
                    size="m"
                    loading={testing}
                    disabled={testing || clearing}
                    onClick={() => void editor.testExisting()}
                  >
                    {testing ? tr('apiKeyVerifying') : tr('apiKeyTest')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </SettingRow>

        <SettingRow
          label={tr('apiKeyConsoleLabel')}
          description={tr('apiKeyConsoleDescription')}
          action={
            <LinkButton
              href={DEEPSEEK_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              data-external-browser="true"
            >
              <span>{tr('apiKeyConsoleAction')}</span>
              <IconRightUpOutline14 />
            </LinkButton>
          }
        />

        {!showInput ? (
          <SettingRow
            label={tr('apiKeyRemoveLabel')}
            description={tr(
              account.storage === 'device'
                ? 'apiKeyRemoveDescriptionDesktop'
                : 'apiKeyRemoveDescriptionWeb'
            )}
            action={
              <SettingInlineConfirm
                confirming={phase.kind === 'confirmingRemove' || clearing}
                triggerLabel={tr('apiKeyRemove')}
                confirmLabel={tr('apiKeyRemoveConfirm')}
                cancelLabel={tr('cancel')}
                disabled={testing}
                busy={clearing}
                onOpen={editor.openRemoveConfirm}
                onCancel={editor.cancelRemoveConfirm}
                onConfirm={() => void editor.clear()}
              />
            }
          />
        ) : null}
      </>
    )
  }
  return KeySettings
}
