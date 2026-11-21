import clsx from 'clsx'
import { useState } from 'react'
import {
  IconCheckOutline16,
  IconEyeOffOutline16,
  IconEyeOutline16,
  IconKeyOutline16,
  IconRightUpOutline14,
  IconToastError16,
} from '../base/icons.js'
import { setFirecrawlApiKey, useSettings } from '../../services/settings.js'
import { verifyFirecrawlApiKey } from '../../services/api/firecrawl.js'
import { isDesktopApp } from '../../platform/desktop.js'
import { useIsMobile } from '../../app/viewport.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys'
const FIRECRAWL_KEYS_URL = 'https://www.firecrawl.dev/app/api-keys'

const maskApiKey = (apiKey: string) => {
  if (apiKey.length <= 8) {
    return '•'.repeat(Math.max(4, apiKey.length))
  }
  const prefix =
    apiKey.startsWith('sk-') || apiKey.startsWith('fc-') ? apiKey.slice(0, 3) : apiKey.slice(0, 2)
  return `${prefix}${'•'.repeat(10)}${apiKey.slice(-4)}`
}

/** API Key 的编辑状态 */
export const useApiKeyEditor = () => {
  const apiKey = useSettings((state) => state.apiKey)
  const firecrawlApiKey = useSettings((state) => state.firecrawlApiKey)
  const [editing, setEditing] = useState(false)
  const [editingFirecrawl, setEditingFirecrawl] = useState(false)
  const form = useApiKeyForm(() => setEditing(false))
  const firecrawlForm = useApiKeyForm(() => setEditingFirecrawl(false), {
    verify: verifyFirecrawlApiKey,
    save: setFirecrawlApiKey,
    invalidKey: 'firecrawlKeyInvalid',
    emptyKey: 'firecrawlKeyPlaceholder',
  })
  return {
    apiKey,
    editing,
    setEditing,
    form,
    showInput: !apiKey || editing,
    firecrawlApiKey,
    editingFirecrawl,
    setEditingFirecrawl,
    firecrawlForm,
  }
}

type ApiKeyEditor = ReturnType<typeof useApiKeyEditor>

/** API Key 设置页：掩码摘要、在线测试、明暗切换、控制台入口与清除确认 */
export const ApiKeyField = ({ editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const {
    apiKey,
    editing,
    setEditing,
    form,
    showInput,
    firecrawlApiKey,
    editingFirecrawl,
    setEditingFirecrawl,
    firecrawlForm,
  } = editor
  const [revealed, setRevealed] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [firecrawlRevealed, setFirecrawlRevealed] = useState(false)
  const [confirmRemoveFirecrawl, setConfirmRemoveFirecrawl] = useState(false)

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
        <div className={styles.apiKey}>
          <div className={styles.apiKeyHeader}>
            <div className={styles.label}>{t('apiKeyLabel')}</div>
            {!showInput && form.verified ? (
              <span className={styles.apiKeyStatus} role="status">
                <IconCheckOutline16 />
                {t('apiKeyVerified')}
              </span>
            ) : null}
          </div>

          {showInput ? (
            <>
              <div className={styles.description}>{t('apiKeyStart')}</div>
              <div className={clsx(styles.apiKeyInput, form.error && styles.apiKeyInputError)}>
                <input
                  type={revealed ? 'text' : 'password'}
                  placeholder={t('apiKeyPlaceholder')}
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
                  tooltip={t(revealed ? 'apiKeyHide' : 'apiKeyShow')}
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
              <div className={styles.apiKeyActions}>
                <Button
                  variant="primary"
                  size="m"
                  disabled={form.verifying}
                  onClick={() => void form.submit()}
                >
                  {form.verifying ? t('apiKeyVerifying') : t('save')}
                </Button>
                {editing ? (
                  <Button
                    variant="outlined"
                    size="m"
                    disabled={form.verifying}
                    onClick={cancelEdit}
                  >
                    {t('cancel')}
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className={styles.apiKeySaved}>
                <span className={styles.apiKeySavedIcon}>
                  <IconKeyOutline16 />
                </span>
                <span className={styles.apiKeyMask}>{maskApiKey(apiKey ?? '')}</span>
              </div>
              {form.error ? (
                <div className={styles.errorRow} role="alert">
                  <IconToastError16 />
                  <span>{form.error}</span>
                </div>
              ) : null}
              <div className={styles.apiKeyActions}>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={form.testing || form.clearing}
                  onClick={startEdit}
                >
                  {t('apiKeyChange')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={form.testing || form.clearing}
                  onClick={() => void form.testExisting(apiKey ?? '')}
                >
                  {form.testing ? t('apiKeyVerifying') : t('apiKeyTest')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('apiKeyConsoleLabel')}</div>
          <div className={styles.description}>{t('apiKeyConsoleDescription')}</div>
        </div>
        <a
          className={styles.linkButton}
          href={DEEPSEEK_KEYS_URL}
          target="_blank"
          rel="noreferrer"
          data-external-browser="true"
        >
          <span>{t('apiKeyConsoleAction')}</span>
          <IconRightUpOutline14 />
        </a>
      </div>

      {!showInput ? (
        <div className={clsx(styles.cell, styles.row)}>
          <div className={styles.text}>
            <div className={styles.label}>{t('apiKeyRemoveLabel')}</div>
            <div className={styles.description}>
              {t(isDesktopApp ? 'apiKeyRemoveDescriptionDesktop' : 'apiKeyRemoveDescriptionWeb')}
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
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                size="m"
                disabled={form.clearing}
                onClick={() => void confirmClear()}
              >
                {t('apiKeyRemoveConfirm')}
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
              {t('apiKeyRemove')}
            </Button>
          )}
        </div>
      ) : null}

      <div className={styles.cell}>
        <div className={styles.apiKey}>
          <div className={styles.apiKeyHeader}>
            <div className={styles.label}>{t('firecrawlKeyLabel')}</div>
            {!editingFirecrawl && firecrawlApiKey && firecrawlForm.verified ? (
              <span className={styles.apiKeyStatus} role="status">
                <IconCheckOutline16 />
                {t('apiKeyVerified')}
              </span>
            ) : null}
          </div>
          <div className={styles.description}>{t('firecrawlKeyDescription')}</div>

          {editingFirecrawl ? (
            <>
              <div
                className={clsx(styles.apiKeyInput, firecrawlForm.error && styles.apiKeyInputError)}
              >
                <input
                  type={firecrawlRevealed ? 'text' : 'password'}
                  placeholder={t('firecrawlKeyPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={!isMobile}
                  value={firecrawlForm.value}
                  onChange={(event) => firecrawlForm.setValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      void firecrawlForm.submit()
                    } else if (event.key === 'Escape') {
                      event.stopPropagation()
                      firecrawlForm.resetForm()
                      setFirecrawlRevealed(false)
                      setEditingFirecrawl(false)
                    }
                  }}
                />
                <IconButton
                  size="m"
                  icon={firecrawlRevealed ? <IconEyeOffOutline16 /> : <IconEyeOutline16 />}
                  tooltip={t(firecrawlRevealed ? 'apiKeyHide' : 'apiKeyShow')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setFirecrawlRevealed((value) => !value)}
                />
              </div>
              {firecrawlForm.error ? (
                <div className={styles.errorRow} role="alert">
                  <IconToastError16 />
                  <span>{firecrawlForm.error}</span>
                </div>
              ) : null}
              <div className={styles.apiKeyActions}>
                <Button
                  variant="primary"
                  size="m"
                  disabled={firecrawlForm.verifying}
                  onClick={() => void firecrawlForm.submit()}
                >
                  {firecrawlForm.verifying ? t('apiKeyVerifying') : t('save')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={firecrawlForm.verifying}
                  onClick={() => {
                    firecrawlForm.resetForm()
                    setFirecrawlRevealed(false)
                    setEditingFirecrawl(false)
                  }}
                >
                  {t('cancel')}
                </Button>
              </div>
            </>
          ) : firecrawlApiKey ? (
            <>
              <div className={styles.apiKeySaved}>
                <span className={styles.apiKeySavedIcon}>
                  <IconKeyOutline16 />
                </span>
                <span className={styles.apiKeyMask}>{maskApiKey(firecrawlApiKey)}</span>
              </div>
              {firecrawlForm.error ? (
                <div className={styles.errorRow} role="alert">
                  <IconToastError16 />
                  <span>{firecrawlForm.error}</span>
                </div>
              ) : null}
              <div className={styles.apiKeyActions}>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={firecrawlForm.testing || firecrawlForm.clearing}
                  onClick={() => {
                    firecrawlForm.clearFeedback()
                    firecrawlForm.resetForm()
                    setFirecrawlRevealed(false)
                    setConfirmRemoveFirecrawl(false)
                    setEditingFirecrawl(true)
                  }}
                >
                  {t('apiKeyChange')}
                </Button>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={firecrawlForm.testing || firecrawlForm.clearing}
                  onClick={() => void firecrawlForm.testExisting(firecrawlApiKey)}
                >
                  {firecrawlForm.testing ? t('apiKeyVerifying') : t('apiKeyTest')}
                </Button>
                {confirmRemoveFirecrawl ? (
                  <>
                    <Button
                      variant="outlined"
                      size="m"
                      disabled={firecrawlForm.clearing}
                      onClick={() => setConfirmRemoveFirecrawl(false)}
                    >
                      {t('cancel')}
                    </Button>
                    <Button
                      variant="danger"
                      size="m"
                      disabled={firecrawlForm.clearing}
                      onClick={async () => {
                        await firecrawlForm.clear()
                        setConfirmRemoveFirecrawl(false)
                      }}
                    >
                      {t('apiKeyRemoveConfirm')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    disabled={firecrawlForm.testing || firecrawlForm.clearing}
                    onClick={() => setConfirmRemoveFirecrawl(true)}
                  >
                    {t('apiKeyRemove')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className={styles.apiKeyActions}>
              <Button
                variant="outlined"
                size="m"
                onClick={() => {
                  firecrawlForm.clearFeedback()
                  firecrawlForm.resetForm()
                  setFirecrawlRevealed(false)
                  setEditingFirecrawl(true)
                }}
              >
                {t('firecrawlKeyAdd')}
              </Button>
              <span className={styles.description}>{t('firecrawlKeyKeylessStatus')}</span>
            </div>
          )}
        </div>
      </div>

      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('firecrawlConsoleLabel')}</div>
          <div className={styles.description}>{t('firecrawlConsoleDescription')}</div>
        </div>
        <a
          className={styles.linkButton}
          href={FIRECRAWL_KEYS_URL}
          target="_blank"
          rel="noreferrer"
          data-external-browser="true"
        >
          <span>{t('apiKeyConsoleAction')}</span>
          <IconRightUpOutline14 />
        </a>
      </div>
    </>
  )
}
