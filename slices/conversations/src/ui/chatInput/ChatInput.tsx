import type { ToolRegistry } from '@deepseek-chat/lib-tools'
import {
  Button,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline16,
  Popover,
  useIsMobile,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACCEPT } from '../../attachments.js'
import { getVisibleMessages } from '../../branches.js'
import { estimateSessionContext } from '../../compaction/estimate.js'
import { useConversations } from '../../context.js'
import { EMPTY_DRAFT, prepareDraftMessage } from '../../drafts.js'
import { useTranslate } from '../../messages.js'
import { getContextRounds } from '../../reply.js'
import { formatCompactTokenCount } from '../messages/CompactionDivider.js'
import styles from './ChatInput.module.css'
import { ComposerMenu, isUploadShortcut, type ComposerToolSwitch } from './ComposerMenu.js'
import { DraftAttachments } from './DraftAttachments.js'
import { DragMask, useFileDrop } from './DragMask.js'

const NO_VOICE = {
  status: 'idle' as const,
  seconds: 0,
  available: false,
  getAnalyser: () => null,
  toggle: () => {},
  cancel: () => {},
}

const useNoVoiceInput = () => NO_VOICE

const useCapabilityToggles = (tools: ToolRegistry): ComposerToolSwitch[] => {
  const [, setVersion] = useState(0)
  useEffect(() => {
    const unsubs = tools.toggles.map((toggle) => toggle.subscribe(() => setVersion((v) => v + 1)))
    return () => {
      for (const unsub of unsubs) {
        unsub()
      }
    }
  }, [tools])

  return tools.toggles.map((toggle) => ({
    key: toggle.id,
    label: toggle.label(),
    icon: toggle.icon,
    checked: toggle.isEnabled(),
    onToggle: () => toggle.setEnabled(!toggle.isEnabled()),
  }))
}

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与已挂载能力开关 + 语音输入（可选） + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const {
    deps,
    tools,
    provider,
    useChatStore,
    useThinkingStore,
    setThinking,
    drafts,
    uploads,
    sendMessage,
    stopReply,
    compactSession,
    ensureApiKey,
    showNotice,
  } = useConversations()

  const voiceViews = deps.ui.voice
  const useVoiceInput = voiceViews ? voiceViews.useVoiceInput : useNoVoiceInput
  const draft = drafts.useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => drafts.setDraftText(sessionId, value)
  const draftReady = uploads.useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const session = useChatStore((state) =>
    sessionId !== null && Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]
      : undefined
  )
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const compacting = useChatStore(
    (state) => sessionId !== null && state.compacting[sessionId] === true
  )
  const thinking = useThinkingStore((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const capabilitySwitches = useCapabilityToggles(tools)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const meterAnchorRef = useRef<HTMLButtonElement>(null)
  const [meterOpen, setMeterOpen] = useState(false)

  const visibleMessages = useMemo(() => (session ? getVisibleMessages(session) : []), [session])
  const hasCompactableTurns = useMemo(
    () => getContextRounds(visibleMessages).length > 0,
    [visibleMessages]
  )
  const contextEstimate = useMemo(() => {
    if (!session || visibleMessages.length === 0) {
      return null
    }
    return estimateSessionContext({
      visibleMessages,
      checkpoints: session.checkpoints,
      modelSpec: provider.modelSpec(provider.defaultModel),
      pendingDraftText: text,
    })
  }, [provider, session, text, visibleMessages])

  const showContextMeter =
    contextEstimate !== null && contextEstimate.tokens >= contextEstimate.policy.meterVisibleTokens
  const meterRatio = contextEstimate
    ? Math.min(1, contextEstimate.tokens / Math.max(1, contextEstimate.policy.line))
    : 0
  const meterUsedLabel = contextEstimate ? formatCompactTokenCount(contextEstimate.tokens) : ''
  const meterLineLabel = contextEstimate ? formatCompactTokenCount(contextEstimate.policy.line) : ''
  const canCompact = !importingHistory && !streaming && !compacting && hasCompactableTurns

  const openFilePicker = useCallback(() => {
    if (!useChatStore.getState().importingHistory && ensureApiKey()) {
      fileInputRef.current?.click()
    }
  }, [ensureApiKey, useChatStore])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    const error = drafts.addDraftFiles(sessionId, files)
    if (error) {
      showNotice(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        drafts.retryDraftAttachment(sessionId, id)
      }
    },
    [drafts, ensureApiKey, sessionId, useChatStore]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        drafts.removeDraftAttachment(sessionId, id)
      }
    },
    [drafts, sessionId, useChatStore]
  )
  const dragging = useFileDrop(acceptFiles)

  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = drafts.getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice, useChatStore]
  )

  const recording = voice.status === 'recording'
  const busy = streaming || compacting
  const canSend = !importingHistory && !busy && voice.status === 'idle' && draftReady

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(drafts.getDraft(sessionId), uploads.useUploads.getState().tasks)
    ) {
      return
    }
    if (!ensureApiKey() || !sendMessage(sessionId)) {
      return
    }
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  const composerTools: ComposerToolSwitch[] = [
    {
      key: 'thinking',
      label: t('thinkingSwitch'),
      icon: <IconThinkOutline16 />,
      checked: thinking,
      onToggle: () => setThinking(!thinking),
    },
    ...capabilitySwitches,
  ]

  return (
    <div
      className={styles.wrapper}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
      onKeyDown={(event) => {
        if (isUploadShortcut(event.nativeEvent)) {
          event.preventDefault()
          openFilePicker()
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile && voiceViews ? (
          <voiceViews.Spectrum getAnalyser={voice.getAnalyser} />
        ) : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        <div className={styles.left}>
          <ComposerMenu
            tools={composerTools}
            disabled={importingHistory || compacting}
            canCompact={canCompact}
            onUploadFiles={openFilePicker}
            onCompact={sessionId ? () => void compactSession(sessionId) : undefined}
          />
          {showContextMeter && !compacting ? (
            <>
              <button
                ref={meterAnchorRef}
                type="button"
                className={clsx(styles.contextMeter, meterOpen && styles.contextMeterOpen)}
                aria-haspopup="dialog"
                aria-expanded={meterOpen}
                aria-label={t('contextMeterAriaLabel', {
                  used: meterUsedLabel,
                  line: meterLineLabel,
                })}
                data-context-meter=""
                onClick={() => setMeterOpen((open) => !open)}
              >
                <span className={styles.contextMeterTrack} aria-hidden="true">
                  <span
                    className={clsx(
                      styles.contextMeterFill,
                      meterRatio >= 0.8 && styles.contextMeterFillWarn
                    )}
                    style={{ width: `${Math.round(meterRatio * 100)}%` }}
                  />
                </span>
                <span className={styles.contextMeterText}>
                  {t('contextMeterLabel', { used: meterUsedLabel, line: meterLineLabel })}
                </span>
              </button>
              <Popover
                open={meterOpen}
                onOpenChange={setMeterOpen}
                anchorRef={meterAnchorRef}
                side="top"
                align="start"
                offset={8}
                role="dialog"
                ariaLabel={t('contextMeterAriaLabel', {
                  used: meterUsedLabel,
                  line: meterLineLabel,
                })}
                className={styles.contextPopover}
              >
                <p className={styles.contextPopoverText}>
                  {t('contextMeterPopoverSummary', {
                    used: meterUsedLabel,
                    line: meterLineLabel,
                  })}
                </p>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={!canCompact}
                  onClick={() => {
                    setMeterOpen(false)
                    if (sessionId) {
                      void compactSession(sessionId)
                    }
                  }}
                >
                  {t('compactConversation')}
                </Button>
              </Popover>
            </>
          ) : null}
          {compacting && !streaming ? (
            <span className={styles.compactingStatus} role="status" aria-live="polite">
              {t('compactingConversation')}
            </span>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          onChange={(event) => {
            acceptFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        <div className={styles.right}>
          {voiceViews ? (
            <voiceViews.VoiceButton
              status={voice.status}
              disabled={!voice.available}
              seconds={voice.seconds}
              onClick={() => {
                if (
                  voice.status !== 'idle' ||
                  (!useChatStore.getState().importingHistory && ensureApiKey())
                ) {
                  void voice.toggle()
                }
              }}
            />
          ) : null}
          {busy && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => stopReply(sessionId)}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {dragging ? <DragMask /> : null}
    </div>
  )
}
