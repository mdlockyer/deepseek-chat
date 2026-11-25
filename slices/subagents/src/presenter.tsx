import { Banner, IconThinkOutline14, IconWarningOutline16 } from '@deepseek-chat/lib-ui'
import type {
  ActivityStepDetailProps,
  ArchiveFragment,
  LiveTrack,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import { subagentsMessages } from './messages.js'
import { POST_TOOL_NAME, WAIT_TOOL_NAME } from './tools.js'
import { isSubagentsReplyState, type AgentRun, type BoardPost, type ChildBlock } from './types.js'
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

const notesForAgent = (board: readonly BoardPost[], runId: string): readonly BoardPost[] =>
  board.filter((post) => {
    if (post.author.kind === 'agent' && post.author.runId === runId) {
      return true
    }
    if (post.kind === 'direction') {
      return post.to.kind === 'all' || post.to.runId === runId
    }
    return false
  })

const statusLabelOf = (agent: AgentRun): string | undefined => {
  switch (agent.state.status) {
    case 'running':
      return subagentsMessages.translate('statusRunning')
    case 'finished':
      return subagentsMessages.translate('statusFinished')
    case 'exhausted':
      return subagentsMessages.translate('statusExhausted')
    case 'stopped':
      return subagentsMessages.translate('statusStopped')
    case 'failed':
      return undefined
  }
}

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

const SubagentStepDetail = ({ entry, capabilityState }: ActivityStepDetailProps) => {
  const t = subagentsMessages.useTranslate()
  const state = isSubagentsReplyState(capabilityState) ? capabilityState : null
  const agent = state?.agents.find((a) => a.startedBy === entry.call.id) ?? null
  if (!agent) {
    return null
  }
  const toolCalls = agent.blocks.filter((b) => b.type === 'tool_use')
  const notes = notesForAgent(state?.board ?? [], agent.runId)

  return (
    <div className={styles.detail}>
      {agent.summary ? <div className={styles.summary}>{agent.summary}</div> : null}

      {toolCalls.length > 0 ? (
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
        </div>
      ) : null}

      {agent.state.status === 'failed' ? (
        <Banner tone="error" compact role="note" icon={<IconWarningOutline16 />}>
          <div className={styles.errorText}>
            {agent.state.error.message || agent.state.error.kind}
          </div>
        </Banner>
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
    const failed = agent
      ? agent.state.status === 'failed'
      : Boolean(result && result.status !== 'ok')
    const meta = agent ? statusLabelOf(agent) : undefined
    const hasDetail = Boolean(
      agent &&
      (agent.blocks.some((b) => b.type === 'tool_use') ||
        agent.state.status === 'failed' ||
        Boolean(agent.summary) ||
        notesForAgent(state?.board ?? [], agent.runId).length > 0)
    )
    return {
      lane: 'subagents',
      icon: <IconThinkOutline14 />,
      liveVerb: subagentsMessages.translate('liveWorking'),
      detail: agent?.label || agent?.profile,
      ...(meta ? { meta } : {}),
      hasDetail,
      stillRunning: running && streaming,
      failed,
      tally: {
        key: 'subagents',
        count: 1,
        label: (count) =>
          subagentsMessages.translate(count === 1 ? 'countOne' : 'countMany', { count }),
      },
      liveTracks: state ? state.agents.map(toLiveTrack) : undefined,
    }
  },
  renderStepDetail: SubagentStepDetail,
}
