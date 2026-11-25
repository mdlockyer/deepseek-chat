import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconThinkOutline14,
} from '@deepseek-chat/lib-ui'
import type {
  ActivityStepRenderProps,
  ArchiveFragment,
  LiveTrack,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { subagentsMessages } from './messages.js'
import { POST_TOOL_NAME, WAIT_TOOL_NAME } from './tools.js'
import { isSubagentsReplyState, type AgentRun, type ChildBlock } from './types.js'
import styles from './SubagentsActivity.module.css'

const fence = (lang: string, body: string) => {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

const latestChildStepText = (blocks: readonly ChildBlock[]): string | null => {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]
    if (block?.type === 'tool_use') {
      const summary =
        block.input && typeof (block.input as { summary?: unknown }).summary === 'string'
          ? (block.input as { summary: string }).summary.trim()
          : ''
      return summary || block.name
    }
  }
  return null
}

const toLiveTrack = (agent: AgentRun): LiveTrack => ({
  id: agent.runId,
  label: agent.label || agent.profile,
  detail: latestChildStepText(agent.blocks) ?? agent.summary ?? null,
  status: agent.state.status,
})

export const serializeSubagentForArchive = (
  _call: ToolCallRecord,
  result: ToolResultRecord | undefined
): readonly ArchiveFragment[] => {
  // Keep every tool result text (including wait results and board digests), omitting child transcripts.
  if (result && result.status !== 'running' && result.content.trim()) {
    return [{ type: 'MARKDOWN', content: fence('text', result.content), separate: true }]
  }
  return []
}

const SubagentRow = ({
  agent,
  focusedCallId,
  focusNonce,
}: {
  agent: AgentRun
  focusedCallId?: string | null
  focusNonce?: number
}) => {
  const t = subagentsMessages.useTranslate()
  const isFocused = Boolean(focusedCallId && focusedCallId === agent.startedBy)
  const [open, setOpen] = useState(isFocused)

  useEffect(() => {
    if (focusedCallId === agent.startedBy) {
      setOpen(true)
    }
  }, [focusedCallId, focusNonce, agent.startedBy])

  const isRunning = agent.state.status === 'running'
  const isFailed = agent.state.status === 'failed'
  const statusKey = isRunning
    ? 'statusRunning'
    : agent.state.status === 'finished'
      ? 'statusFinished'
      : agent.state.status === 'exhausted'
        ? 'statusExhausted'
        : isFailed
          ? 'statusFailed'
          : 'statusStopped'
  const toolCalls = agent.blocks.filter((b) => b.type === 'tool_use')
  const expandable = toolCalls.length > 0 || isFailed

  const titleLine = (
    <span className={styles.rowTop}>
      <span className={styles.chevron} aria-hidden="true">
        {expandable ? open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 /> : null}
      </span>
      <span className={clsx(styles.label, !isRunning && !isFailed && styles.labelSettled)}>
        {agent.label || agent.profile}
      </span>
      <span
        className={clsx(
          styles.status,
          isRunning && styles.statusRunning,
          isFailed && styles.statusError
        )}
      >
        {t(statusKey)}
      </span>
    </span>
  )

  return (
    <div className={styles.row} data-activity-call-id={agent.startedBy}>
      {expandable ? (
        <button
          type="button"
          className={styles.rowTrigger}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {titleLine}
          {agent.summary ? <span className={styles.summary}>{agent.summary}</span> : null}
        </button>
      ) : (
        <div className={styles.rowStatic}>
          {titleLine}
          {agent.summary ? <span className={styles.summary}>{agent.summary}</span> : null}
        </div>
      )}
      {expandable && open ? (
        <div className={styles.steps}>
          {toolCalls.map((call) => {
            const summary =
              call.input && typeof (call.input as { summary?: unknown }).summary === 'string'
                ? (call.input as { summary: string }).summary
                : call.name
            return (
              <div key={call.id} className={styles.stepRow}>
                {summary}
              </div>
            )
          })}
          {agent.state.status === 'failed' ? (
            <div className={clsx(styles.stepRow, styles.statusError)}>
              {agent.state.error.message || agent.state.error.kind}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const SubagentsActivityView = ({
  entries,
  capabilityState,
  focusedCallId,
  focusNonce,
}: ActivityStepRenderProps) => {
  const t = subagentsMessages.useTranslate()
  const state = isSubagentsReplyState(capabilityState) ? capabilityState : null
  const callIds = new Set(entries.map((entry) => entry.call.id))
  const agents = (state?.agents ?? []).filter((agent) => callIds.has(agent.startedBy))
  const notes = state?.board ?? []

  if (agents.length === 0 && notes.length === 0) {
    return null
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span>{t('phaseTitle')}</span>
        {agents.length > 0 ? <span className={styles.meta}>{agents.length}</span> : null}
      </div>
      {agents.length > 0 ? (
        <div className={styles.list}>
          {agents.map((agent) => (
            <SubagentRow
              key={agent.runId}
              agent={agent}
              focusedCallId={focusedCallId}
              focusNonce={focusNonce}
            />
          ))}
        </div>
      ) : null}
      {notes.length > 0 ? (
        <div className={styles.board}>
          <div className={styles.boardHeading}>{t('boardNotes')}</div>
          <div className={styles.noteList}>
            {notes.map((post) => (
              <div key={post.id} className={styles.note}>
                <span className={styles.noteKind}>
                  {t(
                    post.kind === 'finding'
                      ? 'boardFinding'
                      : post.kind === 'question'
                        ? 'boardQuestion'
                        : 'boardDirection'
                  )}
                </span>
                <span className={styles.noteBody}>
                  {post.kind === 'finding'
                    ? post.text
                    : post.kind === 'question'
                      ? `${post.question} (${t('boardAssumption', { text: post.assumption })})`
                      : post.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export const subagentsPresenter: ToolStepPresenter = {
  summarize: (call, result, { streaming, capabilityState }) => {
    const state = isSubagentsReplyState(capabilityState) ? capabilityState : null
    if (call.name === WAIT_TOOL_NAME || call.name === POST_TOOL_NAME) {
      const running = !result || result.status === 'running'
      return {
        lane: 'subagents',
        liveVerb: subagentsMessages.translate('liveWorking'),
        hiddenInTimeline: true,
        stillRunning: running && streaming,
        liveTracks: state ? state.agents.map(toLiveTrack) : undefined,
        failed: !running && result.status !== 'ok',
      }
    }
    const agent = state?.agents.find((a) => a.startedBy === call.id)
    const running = agent
      ? agent.state.status === 'running'
      : !result || result.status === 'running'
    return {
      lane: 'subagents',
      icon: <IconThinkOutline14 />,
      liveVerb: subagentsMessages.translate('liveWorking'),
      stillRunning: running && streaming,
      failed: agent ? agent.state.status === 'failed' : Boolean(result && result.status !== 'ok'),
      tally: {
        key: 'subagents',
        count: 1,
        label: (count) =>
          subagentsMessages.translate(count === 1 ? 'countOne' : 'countMany', { count }),
      },
      liveTracks: state ? state.agents.map(toLiveTrack) : undefined,
    }
  },
  renderActivity: SubagentsActivityView,
}
