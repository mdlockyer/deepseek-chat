import { Markdown } from '@deepseek-chat/lib-markdown'
import {
  IconButton,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconSearchOutline16,
  IconThinkOutline16,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { GenericStepView } from './GenericStepView.js'
import { activityInspectorMessages } from './messages.js'
import { SourceCard } from './SourceCard.js'
import type { ActivityPanelState } from './state.js'
import './thinking.markdown.css'
import { buildActivityTimeline } from './timeline.js'
import type {
  ActivityInspectorDeps,
  ActivitySource,
  ActivityTarget,
  TurnSnapshot,
} from './types.js'
import styles from './ActivityPanel.module.css'

const useTicker = (active: boolean, interval: number) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setInterval(() => setTick((value) => value + 1), interval)
    return () => clearInterval(timer)
  }, [active, interval])
  return tick
}

const ReasoningSection = ({
  messageId,
  markdown,
  seconds,
  defaultOpen,
  loading,
}: {
  messageId: string
  markdown: string
  seconds: number | null
  defaultOpen: boolean
  loading: boolean
}) => {
  const t = activityInspectorMessages.useTranslate()
  const [open, setOpen] = useState(defaultOpen)
  const heading = loading
    ? t('reasoningStreaming')
    : seconds !== null
      ? t('reasoningSeconds', { seconds })
      : t('reasoningTitle')
  return (
    <div className={styles.phase}>
      <button type="button" className={styles.reasoningToggle} onClick={() => setOpen((v) => !v)}>
        <IconThinkOutline16 />
        <span>{heading}</span>
        {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
      </button>
      {open ? (
        <div className={clsx(styles.reasoningBody, 'ds-think-content')}>
          <Markdown
            content={markdown}
            loading={loading}
            cacheKey={`${messageId}-think`}
            disableLink={false}
          />
        </div>
      ) : null}
    </div>
  )
}

const SourcesView = ({
  cited,
  other,
  all,
  onOpenLink,
}: {
  cited: ActivitySource[]
  other: ActivitySource[]
  all: ActivitySource[]
  onOpenLink: (event: MouseEvent, url: string) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  if (cited.length === 0) {
    return (
      <div className={styles.sourceSection}>
        {all.map((source) => (
          <SourceCard
            key={source.url}
            source={source}
            className={styles.sourceItem}
            onOpenLink={onOpenLink}
          />
        ))}
      </div>
    )
  }
  return (
    <div className={styles.sourceSections}>
      <section className={styles.sourceSection} aria-label={t('citedHeading')}>
        <div className={styles.sourceSectionHeading}>
          {t('citedHeading')} ({cited.length})
        </div>
        {cited.map((source) => (
          <SourceCard
            key={source.url}
            source={source}
            citationIndex={source.index}
            className={styles.sourceItem}
            onOpenLink={onOpenLink}
          />
        ))}
      </section>
      {other.length > 0 ? (
        <section className={styles.sourceSection} aria-label={t('otherSourcesHeading')}>
          <div className={styles.sourceSectionHeading}>
            {t('otherSourcesHeading')} ({other.length})
          </div>
          {other.map((source) => (
            <SourceCard
              key={source.url}
              source={source}
              className={styles.sourceItem}
              onOpenLink={onOpenLink}
            />
          ))}
        </section>
      ) : null}
    </div>
  )
}

export const createActivityPanel = (state: ActivityPanelState, deps: ActivityInspectorDeps) => {
  const renderMarkdown = ({
    content,
    cacheKey,
  }: {
    readonly content: string
    readonly cacheKey: string
  }) => <Markdown content={content} loading={false} cacheKey={cacheKey} disableLink={false} />

  const ActivityPanel = ({ topActions }: { topActions?: ReactNode } = {}) => {
    const t = activityInspectorMessages.useTranslate()
    const target = state.useStore((s) => s.target)
    const lastTargetRef = useRef<ActivityTarget | null>(target)
    if (target) {
      lastTargetRef.current = target
    }
    const activeTarget = target ?? lastTargetRef.current

    const getSnapshot = useCallback((): TurnSnapshot | null => {
      if (!activeTarget) {
        return null
      }
      return deps.turnSource.getTurn(activeTarget.sessionId, activeTarget.messageId)
    }, [activeTarget])

    const turn = useSyncExternalStore(deps.turnSource.subscribe, getSnapshot, getSnapshot)
    const live = Boolean(turn && turn.streaming && turn.status === 'streaming')
    const tick = useTicker(live, 1000)
    const now = Date.now() + tick * 0

    const timeline = useMemo(
      () => (turn ? buildActivityTimeline(turn, deps.getPresenter, now) : null),
      [turn, now]
    )

    const openLink = useCallback((event: MouseEvent, url: string) => {
      if (deps.openInApp && /^https?:\/\//i.test(url)) {
        event.preventDefault()
        deps.openInApp(url)
      }
    }, [])

    const hasSources = (timeline?.sources.all.length ?? 0) > 0
    const effectiveTab = hasSources ? (activeTarget?.tab ?? 'activity') : 'activity'

    return (
      <>
        <div className={styles.header} data-tauri-drag-region>
          {hasSources ? (
            <div className={styles.tabList} role="tablist" aria-label={t('panelTitle')}>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveTab === 'activity'}
                className={clsx(styles.tab, effectiveTab === 'activity' && styles.tabActive)}
                onClick={() => state.setTab('activity')}
              >
                {t('tabSteps')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveTab === 'sources'}
                className={clsx(styles.tab, effectiveTab === 'sources' && styles.tabActive)}
                onClick={() => state.setTab('sources')}
              >
                <span>{t('tabSources')}</span>
                <span>({timeline?.sources.all.length ?? 0})</span>
              </button>
            </div>
          ) : (
            <div role="heading" aria-level={2} className={styles.title} data-tauri-drag-region>
              {t('panelTitle')}
            </div>
          )}
          <div className={styles.topActions}>
            {topActions}
            <IconButton
              size="xs"
              icon={<IconCloseOutline16 />}
              tooltip={t('close')}
              tooltipPlacement="bottom"
              aria-label={t('close')}
              onClick={state.close}
            />
          </div>
        </div>

        <div className={styles.content}>
          {!turn || !timeline ? (
            <div className={styles.empty}>{t('empty')}</div>
          ) : effectiveTab === 'sources' ? (
            <SourcesView
              cited={timeline.sources.cited}
              other={timeline.sources.other}
              all={timeline.sources.all}
              onOpenLink={openLink}
            />
          ) : timeline.phases.length === 0 && timeline.thinkingBlocks.length === 0 ? (
            <div className={styles.empty}>{t('empty')}</div>
          ) : (
            <div className={styles.phaseList}>
              {timeline.phases.map((phase) => {
                if (phase.type === 'preamble') {
                  return (
                    <div key={phase.key} className={styles.phase}>
                      <div className="ds-think-content">
                        <Markdown
                          content={phase.markdown}
                          loading={false}
                          cacheKey={`${turn.messageId}-${phase.key}`}
                          disableLink={false}
                        />
                      </div>
                    </div>
                  )
                }
                if (phase.type === 'server_search') {
                  return (
                    <div key={phase.key} className={styles.phase}>
                      <div className={styles.phaseTitle}>
                        <IconSearchOutline16 />
                        <span>{t('serverSearchTitle')}</span>
                      </div>
                      <div className={styles.queryList}>
                        {phase.queries.map((q) => (
                          <div key={q}>{q}</div>
                        ))}
                      </div>
                    </div>
                  )
                }
                const PresenterView = phase.presenter?.renderActivity ?? GenericStepView
                const capState = phase.capabilityId
                  ? turn.capabilityState?.[phase.capabilityId]
                  : undefined
                return (
                  <div key={phase.key} className={styles.phase}>
                    <PresenterView
                      sessionId={turn.sessionId}
                      lane={phase.lane}
                      entries={phase.entries}
                      streaming={live}
                      now={now}
                      capabilityState={capState}
                      openLink={openLink}
                      openFile={deps.openFile}
                      renderMarkdown={renderMarkdown}
                    />
                  </div>
                )
              })}
              {timeline.thinkingBlocks.length > 0 ? (
                <ReasoningSection
                  key={`${turn.messageId}-reasoning`}
                  messageId={turn.messageId}
                  markdown={timeline.thinkingBlocks.map((b) => b.thinking).join('\n\n')}
                  seconds={timeline.thinkingSeconds}
                  defaultOpen={timeline.thinkingOnly}
                  loading={
                    live &&
                    timeline.thinkingBlocks.at(-1)?.startedAt !== undefined &&
                    timeline.thinkingBlocks.at(-1)?.endedAt === undefined
                  }
                />
              ) : null}
            </div>
          )}
        </div>
      </>
    )
  }

  return ActivityPanel
}
