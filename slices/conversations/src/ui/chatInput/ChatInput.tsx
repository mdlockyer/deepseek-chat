import type { ToolRegistry } from '@deepseek-chat/lib-tools'
import {
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline16,
  useIsMobile,
} from '@deepseek-chat/lib-ui'
import { useLocale } from '@deepseek-chat/spine/i18n'
import clsx from 'clsx'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACCEPT } from '../../attachments.js'
import { getVisibleMessages } from '../../branches.js'
import { useConversations } from '../../context.js'
import { EMPTY_DRAFT, prepareDraftMessage } from '../../drafts.js'
import { useTranslate } from '../../messages.js'
import { getContextRounds } from '../../reply.js'
import styles from './ChatInput.module.css'
import { ComposerMenu, isUploadShortcut, type ComposerToolSwitch } from './ComposerMenu.js'
import { DraftAttachments } from './DraftAttachments.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { ToolsMenu } from './ToolsMenu.js'

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
  const locale = useLocale()
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
    label: toggle.label(locale),
    icon: toggle.icon,
    checked: toggle.isEnabled(),
    onToggle: () => toggle.setEnabled(!toggle.isEnabled()),
  }))
}

/**
 * Composer. The box holds only the draft: attachments, the auto-growing text field and
 * send / stop. The row under it holds "+" (files, compact) and voice on the left, the AI caveat
 * centred, and the tools pill (DeepThink and tool switches) on the right.
 */
export const ChatInput = memo(function ChatInput({
  sessionId,
  caveat = false,
  instanceKey,
  onSent,
}: {
  sessionId: string | null
  /** Show the AI caveat centred under the box (conversation view). */
  caveat?: boolean
  /**
   * Identity of the composer instance. Defaults to one instance per session; a caller can keep
   * the same instance across a session change (the new-chat composer becoming the first chat's
   * composer) so focus and the element itself carry over.
   */
  instanceKey?: string
  /** Called after a message is accepted for sending, before the next render. */
  onSent?: (fromSessionId: string | null) => void
}) {
  return (
    <Input
      key={instanceKey ?? (sessionId === null ? 'new' : `session:${sessionId}`)}
      sessionId={sessionId}
      caveat={caveat}
      onSent={onSent}
    />
  )
})

const Input = ({
  sessionId,
  caveat,
  onSent,
}: {
  sessionId: string | null
  caveat: boolean
  onSent?: (fromSessionId: string | null) => void
}) => {
  const t = useTranslate()
  const {
    deps,
    tools,
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

  const visibleMessages = useMemo(() => (session ? getVisibleMessages(session) : []), [session])
  const hasCompactableTurns = useMemo(
    () => getContextRounds(visibleMessages).length > 0,
    [visibleMessages]
  )
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
    onSent?.(sessionId)
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
    <div className={styles.composer}>
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
        <div className={styles.inputRow}>
          <div className={styles.textareaWrapper}>
            <textarea
              ref={textareaRef}
              className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
              placeholder={t(
                sessionId === null ? 'chatInputPlaceholderChat' : 'chatInputPlaceholderReply'
              )}
              rows={1}
              autoFocus={!isMobile}
              disabled={importingHistory}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onMouseDown={(event) => {
                if (
                  isMobile &&
                  event.button === 0 &&
                  document.activeElement !== event.currentTarget
                ) {
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
          {busy && sessionId ? (
            <button
              type="button"
              className={clsx(styles.sendButton, styles.stopButton)}
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
        {dragging ? <DragMask /> : null}
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
      <div className={styles.toolbar}>
        <div className={styles.left}>
          <ComposerMenu
            disabled={importingHistory || compacting}
            canCompact={canCompact}
            onUploadFiles={openFilePicker}
            onCompact={sessionId ? () => void compactSession(sessionId) : undefined}
          />
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
          {compacting && !streaming ? (
            <span className={styles.compactingStatus} role="status" aria-live="polite">
              {t('compactingConversation')}
            </span>
          ) : null}
        </div>
        {caveat ? (
          <p className={styles.caveat} data-stage-enter="caveat">
            {t('contentCaveat')}
          </p>
        ) : (
          <span />
        )}
        <div className={styles.right}>
          <ToolsMenu tools={composerTools} disabled={importingHistory} />
        </div>
      </div>
    </div>
  )
}
