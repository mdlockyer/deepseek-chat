import {
  Badge,
  Button,
  IconCheckOutline16,
  IconKeyOutline16,
  IconToastError16,
  LinkButton,
  PasswordField,
  SettingInlineConfirm,
  SettingRow,
  useIsMobile,
} from '@deepseek-chat/lib-ui'
import { useState, useSyncExternalStore } from 'react'
import type { KeyVerification } from './firecrawl.js'
import type { KeyStore } from './key.js'
import { webResearchMessages } from './messages.js'
import styles from './KeySettings.module.css'

const FIRECRAWL_KEYS_URL = 'https://www.firecrawl.dev/app/api-keys'

type KeyFailure =
  | { readonly kind: 'empty' }
  | { readonly kind: 'check'; readonly check: Exclude<KeyVerification, { kind: 'valid' }> }

type KeyEditorPhase =
  | { readonly kind: 'viewing'; readonly verified: boolean; readonly error: KeyFailure | null }
  | { readonly kind: 'testing' }
  | { readonly kind: 'confirmingRemove'; readonly error: KeyFailure | null }
  | { readonly kind: 'clearing' }
  | { readonly kind: 'editing'; readonly draft: string; readonly error: KeyFailure | null }
  | { readonly kind: 'verifying'; readonly draft: string }

const maskFirecrawlKey = (key: string): string => {
  if (key.length <= 8) {
    return '•'.repeat(Math.max(4, key.length))
  }
  const prefix = key.startsWith('fc-') ? key.slice(0, 3) : key.slice(0, 2)
  return `${prefix}${'•'.repeat(10)}${key.slice(-4)}`
}

const failedCheck = (error: unknown): KeyFailure => ({
  kind: 'check',
  check: { kind: 'failed', message: error instanceof Error ? error.message : String(error) },
})

const describeFailure = (
  failure: KeyFailure | null,
  tr: ReturnType<typeof webResearchMessages.useTranslate>
): string | null => {
  if (!failure) {
    return null
  }
  if (failure.kind === 'empty') {
    return tr('firecrawlKeyPlaceholder')
  }
  const { check } = failure
  return check.kind === 'invalid'
    ? tr('firecrawlKeyInvalid')
    : check.kind === 'unreachable'
      ? tr('networkError')
      : tr('keyVerificationFailed', { message: check.message })
}

/** Editor state for the Firecrawl key view; held by the settings dialog across tab switches. */
export const createUseKeyEditor =
  (keys: KeyStore, verifyKey: (key: string) => Promise<KeyVerification>) => () => {
    const state = useSyncExternalStore(keys.subscribe, keys.getState, keys.getState)
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
        const result = await verifyKey(trimmed)
        if (result.kind !== 'valid') {
          setPhase({ kind: 'editing', draft: rawDraft, error: { kind: 'check', check: result } })
          return
        }
        await keys.setApiKey(trimmed)
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
        const result = await verifyKey(apiKey)
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
        await keys.setApiKey(null)
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

export const KeySettings = ({
  editor,
  localScrape = false,
}: {
  editor: KeyEditor
  localScrape?: boolean
}) => {
  const tr = webResearchMessages.useTranslate()
  const isMobile = useIsMobile()
  const { apiKey, phase } = editor
  const editing = phase.kind === 'editing' || phase.kind === 'verifying'
  const draft = editing ? phase.draft : ''
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
            <div className={styles.title}>{tr('firecrawlKeyLabel')}</div>
            {!editing && apiKey && verified ? (
              <Badge tone="success" icon={<IconCheckOutline16 />}>
                {tr('keyVerified')}
              </Badge>
            ) : null}
          </div>
          <div className={styles.description}>
            {tr(localScrape ? 'firecrawlKeyDescriptionDesktop' : 'firecrawlKeyDescription')}
          </div>

          {editing ? (
            <>
              <PasswordField
                placeholder={tr('firecrawlKeyPlaceholder')}
                showLabel={tr('keyShow')}
                hideLabel={tr('keyHide')}
                error={errorMessage}
                autoFocus={!isMobile}
                value={draft}
                onChange={(event) => editor.setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    void editor.submit()
                  } else if (event.key === 'Escape') {
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
                  {verifying ? tr('keyVerifying') : tr('save')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={verifying}
                  onClick={editor.cancelEdit}
                >
                  {tr('cancel')}
                </Button>
              </div>
            </>
          ) : apiKey ? (
            <>
              <div className={styles.savedBox}>
                <span className={styles.savedIcon}>
                  <IconKeyOutline16 />
                </span>
                <span className={styles.savedMask}>{maskFirecrawlKey(apiKey)}</span>
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
                  {tr('keyChange')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  loading={testing}
                  disabled={testing || clearing}
                  onClick={() => void editor.testExisting()}
                >
                  {testing ? tr('keyVerifying') : tr('keyTest')}
                </Button>
                <SettingInlineConfirm
                  confirming={phase.kind === 'confirmingRemove' || clearing}
                  triggerLabel={tr('keyRemove')}
                  confirmLabel={tr('keyRemoveConfirm')}
                  cancelLabel={tr('cancel')}
                  disabled={testing}
                  busy={clearing}
                  onOpen={editor.openRemoveConfirm}
                  onCancel={editor.cancelRemoveConfirm}
                  onConfirm={() => void editor.clear()}
                />
              </div>
            </>
          ) : (
            <div className={styles.actions}>
              <Button variant="outlined" size="m" onClick={editor.startEdit}>
                {tr('firecrawlKeyAdd')}
              </Button>
              <span className={styles.description}>{tr('firecrawlKeyKeylessStatus')}</span>
            </div>
          )}
        </div>
      </SettingRow>

      <SettingRow
        label={tr('firecrawlConsoleLabel')}
        description={tr('firecrawlConsoleDescription')}
        action={
          <LinkButton
            href={FIRECRAWL_KEYS_URL}
            target="_blank"
            rel="noreferrer"
            data-external-browser="true"
          >
            <span>{tr('consoleAction')}</span>
          </LinkButton>
        }
      />
    </>
  )
}
