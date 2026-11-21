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
} from '@deepseek-chat/spine/design'
import clsx from 'clsx'
import { useState, useSyncExternalStore } from 'react'
import type { Account } from './account.js'
import { accountMessages } from './messages.js'

const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys'

const t = accountMessages.translate

/** Editor state for the key view; held by the settings dialog so typed input survives tab switches. */
export const createUseKeyEditor = (account: Account) => () => {
  const state = useSyncExternalStore(account.subscribe, account.getState, account.getState)
  const apiKey = state.status === 'ready' ? state.apiKey : null
  const [editing, setEditing] = useState(false)
  const form = useSecretKeyForm({
    verify: (key) => account.verifyKey(key),
    save: account.setApiKey,
    onSaved: () => setEditing(false),
    messages: {
      empty: () => t('apiKeyPlaceholder'),
      invalid: () => t('apiKeyInvalid'),
      unreachable: () => t('networkError'),
      failed: (message) => t('apiKeyVerificationFailed', { message }),
    },
  })
  return { apiKey, editing, setEditing, form, showInput: !apiKey || editing }
}

export type KeyEditor = ReturnType<ReturnType<typeof createUseKeyEditor>>

/** API Key 设置：掩码摘要、在线测试、明暗切换、控制台入口与清除确认 */
export const createKeySettings = (account: Account) => {
  const KeySettings = ({ editor }: { editor: KeyEditor }) => {
    const tr = accountMessages.useTranslate()
    const isMobile = useIsMobile()
    const { apiKey, editing, setEditing, form, showInput } = editor
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

    const confirmClear = async () => {
      await form.clear()
      setConfirmRemove(false)
      setEditing(false)
    }

    return (
      <>
        <div className={styles.cell}>
          <div className={styles.secret}>
            <div className={styles.secretHeader}>
              <div className={styles.label}>{tr('apiKeyLabel')}</div>
              {!showInput && form.verified ? (
                <span className={styles.secretStatus} role="status">
                  <IconCheckOutline16 />
                  {tr('apiKeyVerified')}
                </span>
              ) : null}
            </div>

            {showInput ? (
              <>
                <div className={styles.description}>{tr('apiKeyStart')}</div>
                <div className={clsx(styles.secretInput, form.error && styles.secretInputError)}>
                  <input
                    type={revealed ? 'text' : 'password'}
                    placeholder={tr('apiKeyPlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                    // 移动端打开设置时不弹键盘，点编辑后才聚焦
                    autoFocus={!isMobile || editing}
                    value={form.value}
                    onChange={(event) => form.setValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        void form.submit()
                      } else if (event.key === 'Escape' && editing) {
                        event.stopPropagation()
                        cancelEdit()
                      }
                    }}
                  />
                  <IconButton
                    size="m"
                    icon={revealed ? <IconEyeOffOutline16 /> : <IconEyeOutline16 />}
                    tooltip={tr(revealed ? 'apiKeyHide' : 'apiKeyShow')}
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
                    {form.verifying ? tr('apiKeyVerifying') : tr('save')}
                  </Button>
                  {editing ? (
                    <Button
                      variant="outlined"
                      size="m"
                      disabled={form.verifying}
                      onClick={cancelEdit}
                    >
                      {tr('cancel')}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className={styles.secretSaved}>
                  <span className={styles.secretSavedIcon}>
                    <IconKeyOutline16 />
                  </span>
                  <span className={styles.secretMask}>{maskSecret(apiKey ?? '')}</span>
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
                    {tr('apiKeyChange')}
                  </Button>
                  <Button
                    variant="outlined"
                    size="m"
                    disabled={form.testing || form.clearing}
                    onClick={() => void form.testExisting(apiKey ?? '')}
                  >
                    {form.testing ? tr('apiKeyVerifying') : tr('apiKeyTest')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className={clsx(styles.cell, styles.row)}>
          <div className={styles.text}>
            <div className={styles.label}>{tr('apiKeyConsoleLabel')}</div>
            <div className={styles.description}>{tr('apiKeyConsoleDescription')}</div>
          </div>
          <a
            className={styles.linkButton}
            href={DEEPSEEK_KEYS_URL}
            target="_blank"
            rel="noreferrer"
            data-external-browser="true"
          >
            <span>{tr('apiKeyConsoleAction')}</span>
            <IconRightUpOutline14 />
          </a>
        </div>

        {!showInput ? (
          <div className={clsx(styles.cell, styles.row)}>
            <div className={styles.text}>
              <div className={styles.label}>{tr('apiKeyRemoveLabel')}</div>
              <div className={styles.description}>
                {tr(
                  account.storage === 'device'
                    ? 'apiKeyRemoveDescriptionDesktop'
                    : 'apiKeyRemoveDescriptionWeb'
                )}
              </div>
            </div>
            {confirmRemove ? (
              <div className={styles.inlineConfirm}>
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
                  onClick={() => void confirmClear()}
                >
                  {tr('apiKeyRemoveConfirm')}
                </Button>
              </div>
            ) : (
              <Button
                variant="dangerOutlined"
                size="m"
                className={styles.cellButton}
                disabled={form.testing || form.clearing}
                onClick={() => setConfirmRemove(true)}
              >
                {tr('apiKeyRemove')}
              </Button>
            )}
          </div>
        ) : null}
      </>
    )
  }
  return KeySettings
}
