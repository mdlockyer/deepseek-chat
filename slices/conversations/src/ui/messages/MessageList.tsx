import { useIsMobile } from '@deepseek-chat/lib-ui'
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buildMessageVersions, getVisibleMessages, type MessageVersions } from '../../branches.js'
import { useConversations } from '../../context.js'
import { type CompactionCheckpoint, type Message, type Session } from '../../types.js'
import { AssistantMessage } from './AssistantMessage.js'
import { CompactionDivider } from './CompactionDivider.js'
import styles from './MessageList.module.css'
import { ScrollFollowContext, ScrollToBottomContext, type ScrollFollow } from './scrollContext.js'
import { TranscriptChapters, buildTranscriptTurns, turnStartIds } from './TranscriptChapters.js'
import { UserMessage } from './UserMessage.js'

const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}

const STICKY_THRESHOLD = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

export const MessageList = ({
  session,
  streaming,
  compacting = false,
  footer,
}: {
  session: Session
  streaming: boolean
  compacting?: boolean
  /** Rendered under the scroll area; the session stage places the composer itself. */
  footer?: React.ReactNode
}) => {
  const { selectMessageVersion } = useConversations()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const messages = getVisibleMessages(session)
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  const follow = useMemo<ScrollFollow>(
    () => ({
      stop: () => {
        stickyRef.current = false
      },
      sync: () => {
        const el = scrollRef.current
        if (el) {
          stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
        }
      },
    }),
    []
  )

  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    let lastContentHeight = content.offsetHeight
    let lastScrollHeight = scroll.clientHeight
    const observer = new ResizeObserver(() => {
      const nextContentHeight = content.offsetHeight
      const nextScrollHeight = scroll.clientHeight
      const grew = nextContentHeight > lastContentHeight
      const viewportChanged = nextScrollHeight !== lastScrollHeight
      lastContentHeight = nextContentHeight
      lastScrollHeight = nextScrollHeight
      if (grew || viewportChanged) {
        scrollToBottom()
      }
    })
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [scrollToBottom])

  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  const busy = streaming || compacting
  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (busy) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      selectMessageVersion(session.id, messageId)
    },
    [busy, selectMessageVersion, session.id]
  )

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollToBottom])

  const checkpointsByAnchor = useMemo(() => {
    const map = new Map<string, CompactionCheckpoint[]>()
    const visibleIds = new Set(messages.map((item) => item.id))
    for (const checkpoint of session.checkpoints ?? []) {
      if (!visibleIds.has(checkpoint.anchorMessageId)) {
        continue
      }
      const list = map.get(checkpoint.anchorMessageId)
      if (list) {
        list.push(checkpoint)
      } else {
        map.set(checkpoint.anchorMessageId, [checkpoint])
      }
    }
    return map
  }, [messages, session.checkpoints])

  const isMobile = useIsMobile()
  const turns = useMemo(
    () => buildTranscriptTurns(getVisibleMessages(session), session.checkpoints ?? []),
    [session]
  )
  const turnStarts = useMemo(() => turnStartIds(getVisibleMessages(session)), [session])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, busy)
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <ScrollFollowContext.Provider value={follow}>
        <div className={styles.container}>
          <div className={styles.scrollArea}>
            <div ref={scrollRef} className={styles.scroll} data-message-scroll>
              <div ref={contentRef} className={styles.column} data-stage-enter="messages">
                {messages.map((message, index) => {
                  const anchoredCheckpoints = checkpointsByAnchor.get(message.id)
                  const startsTurn = turnStarts.get(message.id)
                  return (
                    <Fragment key={message.id}>
                      {startsTurn ? <div data-turn-anchor={startsTurn} /> : null}
                      {message.role === 'user' ? (
                        <UserMessage
                          sessionId={session.id}
                          message={message}
                          retryUploadId={uploadRetryId}
                          isFirst={index === 0}
                          isLast={index === lastIndex || index === lastIndex - 1}
                          busy={busy}
                          versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                          onSelectVersion={selectVersion}
                        />
                      ) : (
                        <AssistantMessage
                          sessionId={session.id}
                          message={message}
                          isLast={index === lastIndex}
                          streaming={streaming && index === lastIndex}
                          compacting={compacting && index === lastIndex}
                          busy={busy}
                          versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                          onSelectVersion={selectVersion}
                        />
                      )}
                      {anchoredCheckpoints?.map((checkpoint) => (
                        <CompactionDivider key={checkpoint.id} checkpoint={checkpoint} />
                      ))}
                    </Fragment>
                  )
                })}
              </div>
            </div>
            {turns.length >= 2 && !isMobile ? (
              <TranscriptChapters
                sessionId={session.id}
                turns={turns}
                scrollRef={scrollRef}
                contentRef={contentRef}
              />
            ) : null}
          </div>
          {footer}
        </div>
      </ScrollFollowContext.Provider>
    </ScrollToBottomContext.Provider>
  )
}
