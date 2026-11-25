import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconBrowseOutline16,
  IconBrowserOutline14,
  IconButton,
  IconCheckedOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseFill14,
  IconCloseOutline16,
  IconRightUpOutline14,
  IconSearchOutline16,
  IconThinkOutline16,
} from '@deepseek-chat/lib-ui'
import {
  buildActivityTimeline,
  type ActivityPhase,
  type ResearchPhase,
  type SubagentsPhase,
} from '../../activityView.js'
import { deps } from '../../env.js'
import { useTranslate } from '../../messages.js'
import { useChatStore } from '../../store.js'
import type { AssistantMessage } from '../../types.js'
import {
  buildReplyView,
  getSiteName,
  type AgentStep,
  type BrowserStep,
  type FileStep,
  type PythonStep,
  type Source,
} from '../../view.js'
import { ChatMarkdown as Markdown } from '../messages/ChatMarkdown.js'
import '../messages/thinking.markdown.css'
import { useReplyView } from '../messages/useReplyView.js'
import { SourceCard } from '../search/SourceCard.js'
import {
  closeActivityPanel,
  setActivityPanelTab,
  useActivityPanel,
  type ActivityTarget,
} from './activityPanelState.js'
import styles from './ActivityPanel.module.css'

const fence = (lang: string, body: string) => {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

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

const openExternalOrInApp = (event: React.MouseEvent, url: string) => {
  const { openInApp } = deps().ui
  if (openInApp && /^https?:\/\//i.test(url)) {
    event.preventDefault()
    openInApp(url)
  }
}

/**
 * Unified right-hand Turn Activity & Sources inspector hosted inside `RightPanel`.
 * Reads the bound reply live from `useChatStore` so streaming updates stay current.
 */
export const ActivityPanel = ({ topActions }: { topActions?: ReactNode } = {}) => {
  const t = useTranslate()
  const target = useActivityPanel((state) => state.target)
  // Retain the last target while the side panel slides closed so content doesn't flash blank.
  const lastTargetRef = useRef<ActivityTarget | null>(target)
  if (target) {
    lastTargetRef.current = target
  }
  const activeTarget = target ?? lastTargetRef.current

  const message = useChatStore((state) => {
    if (!activeTarget) {
      return null
    }
    const session = state.sessionCache[activeTarget.sessionId]
    const found = session?.messages.find((item) => item.id === activeTarget.messageId)
    return found?.role === 'assistant' ? found : null
  })
  const isStreaming = useChatStore((state) =>
    activeTarget ? Boolean(state.streaming[activeTarget.sessionId]) : false
  )

  return (
    <ActivityPanelBody
      sessionId={activeTarget?.sessionId ?? null}
      message={message}
      tab={activeTarget?.tab ?? 'activity'}
      streaming={isStreaming}
      topActions={topActions}
      closeLabel={t('close')}
    />
  )
}

const EMPTY_MESSAGE: AssistantMessage = {
  id: '',
  role: 'assistant',
  createdAt: 0,
  model: 'deepseek-flash',
  thinking: false,
  search: false,
  prefix: false,
  status: 'done',
  blocks: [],
}

const ActivityPanelBody = ({
  sessionId,
  message,
  tab,
  streaming,
  topActions,
  closeLabel,
}: {
  sessionId: string | null
  message: AssistantMessage | null
  tab: 'activity' | 'sources'
  streaming: boolean
  topActions?: ReactNode
  closeLabel: string
}) => {
  const t = useTranslate()
  const live = Boolean(message && streaming && message.status === 'streaming')
  const tick = useTicker(live, 1000)
  const view = useReplyView(message ?? EMPTY_MESSAGE, live)
  const timeline = useMemo(() => buildActivityTimeline(view, Date.now() + tick * 0), [view, tick])

  const hasSources = view.sources.length > 0
  const effectiveTab = hasSources ? tab : 'activity'

  return (
    <>
      <div className={styles.header} data-tauri-drag-region>
        {hasSources ? (
          <div className={styles.tabList} role="tablist" aria-label={t('activityPanelTitle')}>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === 'activity'}
              className={clsx(styles.tab, effectiveTab === 'activity' && styles.tabActive)}
              onClick={() => setActivityPanelTab('activity')}
            >
              {t('activityTabSteps')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === 'sources'}
              className={clsx(styles.tab, effectiveTab === 'sources' && styles.tabActive)}
              onClick={() => setActivityPanelTab('sources')}
            >
              <span>{t('activityTabSources')}</span>
              <span>({view.sources.length})</span>
            </button>
          </div>
        ) : (
          <div role="heading" aria-level={2} className={styles.title} data-tauri-drag-region>
            {t('activityPanelTitle')}
          </div>
        )}
        <div className={styles.topActions}>
          {topActions}
          <IconButton
            size="xs"
            icon={<IconCloseOutline16 />}
            tooltip={closeLabel}
            tooltipPlacement="bottom"
            aria-label={closeLabel}
            onClick={closeActivityPanel}
          />
        </div>
      </div>

      <div className={styles.content}>
        {!message ? (
          <div className={styles.empty}>{t('activityEmpty')}</div>
        ) : effectiveTab === 'sources' ? (
          <SourcesView
            cited={timeline.citedSources}
            other={timeline.otherSources}
            all={view.sources}
          />
        ) : timeline.phases.length === 0 && timeline.thinkingBlocks.length === 0 ? (
          <div className={styles.empty}>{t('activityEmpty')}</div>
        ) : (
          <div className={styles.phaseList}>
            {timeline.phases.map((phase) => (
              <PhaseSection
                key={phase.key}
                phase={phase}
                sessionId={sessionId}
                message={message}
                sources={view.sources}
                streaming={live}
                onViewSources={() => setActivityPanelTab('sources')}
              />
            ))}
            {timeline.thinkingBlocks.length > 0 ? (
              <ReasoningSection
                key={`${message.id}-reasoning`}
                messageId={message.id}
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

const SourcesView = ({
  cited,
  other,
  all,
}: {
  cited: Source[]
  other: Source[]
  all: Source[]
}) => {
  const t = useTranslate()
  if (cited.length === 0) {
    return (
      <div className={styles.sourceSection}>
        {all.map((source) => (
          <SourceCard key={source.url} source={source} className={styles.sourceItem} />
        ))}
      </div>
    )
  }
  return (
    <div className={styles.sourceSections}>
      <section className={styles.sourceSection} aria-label={t('activityCitedHeading')}>
        <div className={styles.sourceSectionHeading}>
          {t('activityCitedHeading')} ({cited.length})
        </div>
        {cited.map((source) => (
          <SourceCard
            key={source.url}
            source={source}
            citationIndex={source.index}
            className={styles.sourceItem}
          />
        ))}
      </section>
      {other.length > 0 ? (
        <section className={styles.sourceSection} aria-label={t('activityOtherSourcesHeading')}>
          <div className={styles.sourceSectionHeading}>
            {t('activityOtherSourcesHeading')} ({other.length})
          </div>
          {other.map((source) => (
            <SourceCard key={source.url} source={source} className={styles.sourceItem} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

const PhaseSection = ({
  phase,
  sessionId,
  message,
  sources,
  streaming,
  onViewSources,
}: {
  phase: ActivityPhase
  sessionId: string | null
  message: AssistantMessage
  sources: Source[]
  streaming: boolean
  onViewSources: () => void
}) => {
  switch (phase.type) {
    case 'research':
      return <ResearchPhaseView phase={phase} onViewSources={onViewSources} />
    case 'subagents':
      return <SubagentsPhaseView phase={phase} message={message} />
    case 'python':
      return <PythonPhaseView step={phase.step} messageId={message.id} streaming={streaming} />
    case 'browser':
      return <BrowserPhaseView step={phase.step} />
    case 'file':
      return <FilePhaseView step={phase.step} sessionId={sessionId} />
    case 'ask':
      return <AskPhaseView step={phase.step} />
    case 'preamble':
      return (
        <div className={styles.phase}>
          <div className="ds-think-content">
            <Markdown
              content={phase.markdown}
              loading={false}
              cacheKey={`${message.id}-${phase.key}`}
              disableLink={false}
              sources={sources}
            />
          </div>
        </div>
      )
  }
}

const ResearchPhaseView = ({
  phase,
  onViewSources,
}: {
  phase: ResearchPhase
  onViewSources: () => void
}) => {
  const t = useTranslate()
  const queryCount = Math.max(phase.queries.length, phase.searchCount)
  return (
    <section className={styles.phase}>
      {queryCount > 0 ? (
        <>
          <div className={styles.phaseHeader}>
            <div className={styles.phaseTitle}>
              <IconSearchOutline16 />
              <span>{t('activityWebSearchPhase')}</span>
              <span className={styles.phaseMeta}>
                ·{' '}
                {t(queryCount === 1 ? 'activityPhaseQueriesOne' : 'activityPhaseQueriesMany', {
                  count: queryCount,
                })}
              </span>
            </div>
            {phase.sources.length > 0 ? (
              <button type="button" className={styles.linkButton} onClick={onViewSources}>
                {t('activityViewSources')} ({phase.sources.length})
              </button>
            ) : null}
          </div>
          {phase.queries.length > 0 ? (
            <div className={styles.queryList}>
              {phase.queries.map((query) => (
                <div key={query} className={styles.queryItem}>
                  “{query}”
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {phase.pages.length > 0 ? (
        <div className={queryCount > 0 ? styles.subSection : styles.phase}>
          {queryCount > 0 ? (
            <div className={styles.subSectionLabel}>
              {t('activityPagesReadPhase')} · {phase.pages.length}
            </div>
          ) : (
            <div className={styles.phaseHeader}>
              <div className={styles.phaseTitle}>
                <IconBrowseOutline16 />
                <span>{t('activityPagesReadPhase')}</span>
                <span className={styles.phaseMeta}>· {phase.pages.length}</span>
              </div>
            </div>
          )}
          <div className={styles.pageList}>
            {phase.pages.map((page) => {
              const domain = page.url ? getSiteName(page.url) : ''
              return (
                <div key={page.id} className={styles.pageItem}>
                  {page.status === 'failed' ? (
                    <span className={clsx(styles.pageLinkText, styles.pageFailed)}>
                      {page.title || page.url} · {t('toolOpenFailTooltip')}
                    </span>
                  ) : (
                    <a
                      className={styles.pageLink}
                      href={page.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => openExternalOrInApp(event, page.url)}
                    >
                      <span className={styles.pageLinkText}>{page.title || page.url}</span>
                      <IconRightUpOutline14 />
                    </a>
                  )}
                  {domain || page.summary ? (
                    <div className={styles.pageSub}>
                      {[domain, page.summary].filter(Boolean).join(' · ')}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {phase.findPatterns.length > 0 ? (
        <div className={styles.patternRow}>
          {phase.findPatterns.map((item) => (
            <span key={item.id} className={styles.patternChip}>
              {item.status === 'failed' ? <IconCloseFill14 /> : <IconCheckedOutline14 />}
              <span>{item.pattern}</span>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

const SubagentsPhaseView = ({
  phase,
  message,
}: {
  phase: SubagentsPhase
  message: AssistantMessage
}) => {
  const t = useTranslate()
  return (
    <section className={styles.phase}>
      {phase.agents.length > 0 ? (
        <>
          <div className={styles.phaseHeader}>
            <div className={styles.phaseTitle}>
              <IconSearchOutline16 />
              <span>{t('activitySubagentsPhase')}</span>
              <span className={styles.phaseMeta}>· {phase.agents.length}</span>
            </div>
          </div>
          <div className={styles.agentStack}>
            {phase.agents.map((agent) => (
              <SubagentCard key={agent.key} agent={agent} message={message} />
            ))}
          </div>
        </>
      ) : null}

      {phase.notes.length > 0 ? (
        <div className={styles.notesBlock}>
          <div className={styles.subSectionLabel}>{t('activitySharedNotes')}</div>
          {phase.notes.map((post) => (
            <div key={post.id} className={styles.noteItem}>
              {post.kind === 'finding' ? (
                <>
                  <span className={styles.noteKind}>{t('agentBoardFinding')}:</span>
                  <span>{post.text}</span>
                </>
              ) : post.kind === 'question' ? (
                <>
                  <span className={styles.noteKind}>{t('agentBoardQuestion')}:</span>
                  <span>
                    {post.question} ({t('agentBoardAssuming', { assumption: post.assumption })})
                  </span>
                </>
              ) : (
                <>
                  <span className={styles.noteKind}>{t('agentBoardDirection')}:</span>
                  <span>{post.text}</span>
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

const SubagentCard = ({ agent, message }: { agent: AgentStep; message: AssistantMessage }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const running = agent.state.status === 'running'
  const errored = agent.state.status === 'failed' || agent.state.status === 'stopped'

  const statusLabel = (() => {
    switch (agent.state.status) {
      case 'running':
        return t('agentRunning')
      case 'finished':
        return t('agentFinished')
      case 'exhausted':
        return t('agentExhausted')
      case 'failed':
        return t('agentFailed')
      case 'stopped':
        return t('agentStopped')
    }
  })()

  const childTimeline = useMemo(() => {
    if (!open) {
      return null
    }
    const childView = buildReplyView(
      {
        ...message,
        id: `${message.id}-${agent.runId}`,
        blocks: agent.blocks,
        agents: undefined,
        board: undefined,
      },
      running
    )
    return buildActivityTimeline(childView, Date.now())
  }, [open, message, agent.runId, agent.blocks, running])

  return (
    <div className={styles.agentCard}>
      <button
        type="button"
        className={styles.agentCardHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <div className={styles.agentTitleGroup}>
          <span className={styles.agentTitle}>{agent.summary || agent.label}</span>
          {running && agent.latestStep ? (
            <span className={styles.agentLatest}>{agent.latestStep}</span>
          ) : null}
        </div>
        <span
          className={clsx(
            styles.agentStatus,
            running && styles.agentStatusRunning,
            errored && styles.agentStatusError
          )}
        >
          {running ? <span className={styles.runningDot} aria-hidden="true" /> : null}
          <span>{statusLabel}</span>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
      </button>

      {open && childTimeline ? (
        <div className={styles.agentBody}>
          {childTimeline.phases.map((childPhase) => (
            <PhaseSection
              key={childPhase.key}
              phase={childPhase}
              sessionId={null}
              message={message}
              sources={[]}
              streaming={running}
              onViewSources={() => setActivityPanelTab('sources')}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

const PythonPhaseView = ({
  step,
  messageId,
  streaming,
}: {
  step: PythonStep
  messageId: string
  streaming: boolean
}) => {
  const t = useTranslate()
  const status = step.result?.status ?? (streaming ? 'running' : 'notRun')
  const [open, setOpen] = useState(status === 'error')
  const label =
    status === 'running'
      ? step.result?.phase === 'installing'
        ? t('pythonInstalling')
        : step.result?.phase === 'starting'
          ? t('pythonStarting')
          : t('pythonRunning')
      : status === 'error'
        ? t('pythonFailed')
        : status === 'aborted'
          ? t('pythonStopped')
          : status === 'notRun'
            ? t('pythonNotRun')
            : t('pythonRan')
  const seconds =
    step.result?.durationMs !== undefined ? ` · ${(step.result.durationMs / 1000).toFixed(1)}s` : ''

  return (
    <section className={styles.phase}>
      <button
        type="button"
        className={styles.toggleHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.phaseTitle}>
          <IconThinkOutline16 />
          <span>{step.summary || label}</span>
          {seconds ? <span className={styles.phaseMeta}>{seconds}</span> : null}
        </span>
        <span className={styles.toggleChevron}>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
      </button>
      {open ? (
        <div className={styles.codeBody}>
          <Markdown
            content={fence('python', step.code)}
            loading={false}
            cacheKey={`${messageId}-${step.key}-code`}
            disableLink
          />
          {step.result?.content ? (
            <Markdown
              content={fence('text', step.result.content)}
              loading={false}
              cacheKey={`${messageId}-${step.key}-out-${step.result.status}`}
              disableLink
            />
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

const BrowserPhaseView = ({ step }: { step: BrowserStep }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(step.status === 'failed')
  const totalMs = step.actions.reduce((acc, item) => acc + (item.durationMs ?? 0), 0)
  const label =
    step.status === 'wip'
      ? step.actions.at(-1)?.summary || t('browserStepRunning')
      : step.actions.length === 1
        ? step.actions[0]?.summary || t('browserStepOne')
        : t('browserStepMany', { count: step.actions.length })
  const seconds = step.status !== 'wip' && totalMs > 0 ? ` · ${(totalMs / 1000).toFixed(1)}s` : ''

  return (
    <section className={styles.phase}>
      <button
        type="button"
        className={styles.toggleHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.phaseTitle}>
          <IconBrowserOutline14 />
          <span>{label}</span>
          {seconds ? <span className={styles.phaseMeta}>{seconds}</span> : null}
        </span>
        <span className={styles.toggleChevron}>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
      </button>
      {open ? (
        <div className={styles.browserActions}>
          {step.actions.map((action, index) => {
            const actionUrl = action.url && /^https?:\/\//i.test(action.url) ? action.url : null
            return (
              <div key={action.id} className={styles.browserActionRow}>
                <div className={styles.browserActionLine}>
                  <span className={styles.stepIndex}>{index + 1}.</span>
                  <span>{action.summary}</span>
                  {actionUrl ? (
                    <a
                      className={styles.pageLink}
                      href={actionUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => openExternalOrInApp(event, actionUrl)}
                    >
                      <span className={styles.pageLinkText}>{action.title || actionUrl}</span>
                    </a>
                  ) : null}
                </div>
                {action.output ? <div className={styles.errorText}>{action.output}</div> : null}
                {action.images?.map((src, imgIndex) => (
                  <img key={imgIndex} src={src} alt="" className={styles.screenshot} />
                ))}
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

const FilePhaseView = ({ step, sessionId }: { step: FileStep; sessionId: string | null }) => {
  const t = useTranslate()
  const describe = (action: FileStep['actions'][number]) => {
    const name = action.title || action.path
    if (action.status === 'wip') {
      return action.tool === 'edit_file'
        ? t('previewToolEditing', { name })
        : action.tool === 'read_file'
          ? t('previewToolReading', { name })
          : t('previewToolPresenting', { name })
    }
    if (action.status === 'failed') {
      return action.tool === 'edit_file'
        ? t('previewToolEditFailed', { name })
        : action.tool === 'read_file'
          ? t('previewToolReadFailed', { name })
          : t('previewToolPresentFailed', { name })
    }
    if (action.tool === 'edit_file') {
      return t('previewToolEdit', { name, version: action.version ?? 2 })
    }
    if (action.tool === 'read_file') {
      return t('previewToolRead', { name })
    }
    return t('previewToolPresent', { name })
  }

  return (
    <section className={styles.phase}>
      <div className={styles.phaseHeader}>
        <div className={styles.phaseTitle}>
          <IconBrowseOutline16 />
          <span>{t('previewPanelTitle')}</span>
          <span className={styles.phaseMeta}>· {step.actions.length}</span>
        </div>
      </div>
      <div className={styles.fileList}>
        {step.actions.map((action) => {
          const presented = action.files?.[0]
          return (
            <div key={action.id} className={styles.pageItem}>
              <div className={styles.fileItem}>
                <span>{describe(action)}</span>
                {sessionId && presented ? (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() =>
                      deps().ui.panels.files.open(sessionId, { kind: 'presented', file: presented })
                    }
                  >
                    {t('activityOpenFile')}
                  </button>
                ) : null}
              </div>
              {action.summary ? <div className={styles.pageSub}>{action.summary}</div> : null}
              {action.error ? <div className={styles.errorText}>{action.error}</div> : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

const AskPhaseView = ({ step }: { step: Extract<ActivityPhase, { type: 'ask' }>['step'] }) => {
  const t = useTranslate()
  const ask = step.askAction
  const answeredItems =
    ask?.status === 'answered'
      ? ask.items.filter((item) =>
          Array.isArray(item.answer) ? item.answer.length > 0 : Boolean(item.answer)
        )
      : []
  return (
    <section className={styles.phase}>
      <div className={styles.phaseHeader}>
        <div className={styles.phaseTitle}>
          <IconCheckedOutline14 />
          <span>{step.summary || t('askCardTitle')}</span>
        </div>
      </div>
      {answeredItems.length > 0 ? (
        <div className={styles.askEntries}>
          {answeredItems.map((item) => (
            <div key={item.id}>
              <span className={styles.askKey}>{item.header}:</span>
              <span className={styles.askVal}>
                {Array.isArray(item.answer) ? item.answer.join(', ') : item.answer}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
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
  const t = useTranslate()
  const [open, setOpen] = useState(defaultOpen)
  const label =
    seconds !== null
      ? t('activityReasoningWithDuration', { count: seconds })
      : t('activityReasoningTitle')

  return (
    <section className={styles.phase}>
      <button
        type="button"
        className={styles.toggleHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.phaseTitle}>
          <IconThinkOutline16 />
          <span>{label}</span>
        </span>
        <span className={styles.toggleChevron}>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
      </button>
      {open ? (
        <div className={clsx(styles.reasoningBody, 'ds-think-content')}>
          <Markdown
            content={markdown}
            loading={loading}
            cacheKey={`${messageId}-reasoning-panel`}
            disableLink
          />
        </div>
      ) : null}
    </section>
  )
}
