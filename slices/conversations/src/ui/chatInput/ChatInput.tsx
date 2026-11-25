import type { ToolRegistry } from '@deepseek-chat/lib-tools'
import {
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline16,
  useIsMobile,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ACCEPT } from '../../attachments.js'
import { useConversations } from '../../context.js'
import { EMPTY_DRAFT, prepareDraftMessage } from '../../drafts.js'
import { useTranslate } from '../../messages.js'
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
    useChatStore,
    useThinkingStore,
    setThinking,
    drafts,
    uploads,
    sendMessage,
    stopReply,
    ensureApiKey,
    showNotice,
  } = useConversations()

  const voiceViews = deps.ui.voice
  const useVoiceInput = voiceViews ? voiceViews.useVoiceInput : useNoVoiceInput
  const draft = drafts.useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => drafts.setDraftText(sessionId, value)
  const draftReady = uploads.useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useThinkingStore((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const capabilitySwitches = useCapabilityToggles(tools)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const openFilePicker = useCallback(() => {
    if (!useChatStore.getState().importingHistory && ensureApiKey()) {
      fileInputRef.current?.click()
    }
  }, [ensureApiKey, useChatStore])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    const error = drafts.addDraftFiles(sessionId, files, deps.getApiKey() ?? '')
    if (error) {
      showNotice(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        drafts.retryDraftAttachment(sessionId, id, deps.getApiKey() ?? '')
      }
    },
    [deps, drafts, ensureApiKey, sessionId, useChatStore]
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
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady

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
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
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
        <ComposerMenu
          tools={composerTools}
          disabled={importingHistory}
          onUploadFiles={openFilePicker}
        />
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
          {streaming && sessionId ? (
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
