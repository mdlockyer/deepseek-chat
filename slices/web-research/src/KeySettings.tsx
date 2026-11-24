import {
  Button,
  IconButton,
  IconCheckOutline16,
  IconEyeOffOutline16,
  IconEyeOutline16,
  IconKeyOutline16,
  IconRightUpOutline14,
  IconToastError16,
  maskSecret,
  settingStyles as styles,
  useIsMobile,
  useSecretKeyForm,
  type KeyCheck,
} from '@deepseek-chat/spine/design'
import clsx from 'clsx'
import { useState, useSyncExternalStore } from 'react'
import type { KeyStore } from './key.js'
import { webResearchMessages } from './messages.js'

const FIRECRAWL_KEYS_URL = 'https://www.firecrawl.dev/app/api-keys'

const t = webResearchMessages.translate

/** Editor state for the key view; held by the settings dialog so typed input survives tab switches. */
export const createUseKeyEditor =
  (keys: KeyStore, verifyKey: (key: string) => Promise<KeyCheck>) => () => {
    const state = useSyncExternalStore(keys.subscribe, keys.getState, keys.getState)
    const apiKey = state.status === 'ready' ? state.apiKey : null
    const [editing, setEditing] = useState(false)
    const form = useSecretKeyForm({
      verify: verifyKey,
      save: keys.setApiKey,
      onSaved: () => setEditing(false),
      messages: {
        empty: () => t('firecrawlKeyPlaceholder'),
        invalid: () => t('firecrawlKeyInvalid'),
        unreachable: () => t('networkError'),
        failed: (message) => t('keyVerificationFailed', { message }),
      },
    })
    return { apiKey, editing, setEditing, form }
  }

export type KeyEditor = ReturnType<ReturnType<typeof createUseKeyEditor>>

/** Firecrawl 密钥设置：可选；未设置时使用无密钥免费额度 */
export const KeySettings = ({
  editor,
  localScrape = false,
}: {
  editor: KeyEditor
  localScrape?: boolean
}) => {
  const tr = webResearchMessages.useTranslate()
  const isMobile = useIsMobile()
  const { apiKey, editing, setEditing, form } = editor
  const [revealed, setRevealed] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const startEdit = () => {
    form.clearFeedback()
    form.resetForm()
    setRevealed(false)
    setConfirmRemove(false)
    setEditing(true)
  }

  const cancelEdit = () => {
    form.resetForm()
    setRevealed(false)
    setEditing(false)
  }

  return (
    <>
      <div className={styles.cell}>
        <div className={styles.secret}>
          <div className={styles.secretHeader}>
            <div className={styles.label}>{tr('firecrawlKeyLabel')}</div>
            {!editing && apiKey && form.verified ? (
              <span className={styles.secretStatus} role="status">
                <IconCheckOutline16 />
                {tr('keyVerified')}
              </span>
            ) : null}
          </div>
          <div className={styles.description}>
            {tr(localScrape ? 'firecrawlKeyDescriptionDesktop' : 'firecrawlKeyDescription')}
          </div>

          {editing ? (
            <>
              <div className={clsx(styles.secretInput, form.error && styles.secretInputError)}>
                <input
                  type={revealed ? 'text' : 'password'}
                  placeholder={tr('firecrawlKeyPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={!isMobile}
                  value={form.value}
                  onChange={(event) => form.setValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      void form.submit()
                    } else if (event.key === 'Escape') {
                      event.stopPropagation()
                      cancelEdit()
                    }
                  }}
                />
                <IconButton
                  size="m"
                  icon={revealed ? <IconEyeOffOutline16 /> : <IconEyeOutline16 />}
                  tooltip={tr(revealed ? 'keyHide' : 'keyShow')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setRevealed((value) => !value)}
                />
              </div>
              {form.error ? (
                <div className={styles.errorRow} role="alert">
                  <IconToastError16 />
                  <span>{form.error}</span>
                </div>
              ) : null}
              <div className={styles.secretActions}>
                <Button
                  variant="primary"
                  size="m"
                  disabled={form.verifying}
                  onClick={() => void form.submit()}
                >
                  {form.verifying ? tr('keyVerifying') : tr('save')}
                </Button>
                <Button variant="outlined" size="m" disabled={form.verifying} onClick={cancelEdit}>
                  {tr('cancel')}
                </Button>
              </div>
            </>
          ) : apiKey ? (
            <>
              <div className={styles.secretSaved}>
                <span className={styles.secretSavedIcon}>
                  <IconKeyOutline16 />
                </span>
                <span className={styles.secretMask}>{maskSecret(apiKey)}</span>
              </div>
              {form.error ? (
                <div className={styles.errorRow} role="alert">
                  <IconToastError16 />
                  <span>{form.error}</span>
                </div>
              ) : null}
              <div className={styles.secretActions}>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={form.testing || form.clearing}
                  onClick={startEdit}
                >
                  {tr('keyChange')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={form.testing || form.clearing}
                  onClick={() => void form.testExisting(apiKey)}
                >
                  {form.testing ? tr('keyVerifying') : tr('keyTest')}
                </Button>
                {confirmRemove ? (
                  <>
                    <Button
                      variant="outlined"
                      size="m"
                      disabled={form.clearing}
                      onClick={() => setConfirmRemove(false)}
                    >
                      {tr('cancel')}
                    </Button>
                    <Button
                      variant="danger"
                      size="m"
                      disabled={form.clearing}
                      onClick={async () => {
                        await form.clear()
                        setConfirmRemove(false)
                      }}
                    >
                      {tr('keyRemoveConfirm')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    disabled={form.testing || form.clearing}
                    onClick={() => setConfirmRemove(true)}
                  >
                    {tr('keyRemove')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className={styles.secretActions}>
              <Button
                variant="outlined"
                size="m"
                onClick={() => {
                  form.clearFeedback()
                  form.resetForm()
                  setRevealed(false)
                  setEditing(true)
                }}
              >
                {tr('firecrawlKeyAdd')}
              </Button>
              <span className={styles.description}>{tr('firecrawlKeyKeylessStatus')}</span>
            </div>
          )}
        </div>
      </div>

      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{tr('firecrawlConsoleLabel')}</div>
          <div className={styles.description}>{tr('firecrawlConsoleDescription')}</div>
        </div>
        <a
          className={styles.linkButton}
          href={FIRECRAWL_KEYS_URL}
          target="_blank"
          rel="noreferrer"
          data-external-browser="true"
        >
          <span>{tr('consoleAction')}</span>
          <IconRightUpOutline14 />
        </a>
      </div>
    </>
  )
}
