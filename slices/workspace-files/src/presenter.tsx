import {
  IconBrowseOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-chat/lib-ui'
import type {
  ActivityStepRenderProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { getCodeLanguage } from './fileKinds.js'
import { workspaceMessages } from './messages.js'
import { EDIT_FILE_TOOL_NAME, PRESENT_FILE_TOOL_NAME, READ_FILE_TOOL_NAME } from './tools.js'
import styles from './FileActivity.module.css'

type FileActionPayload = {
  readonly tool: 'present_file' | 'edit_file' | 'read_file'
  readonly path: string
  readonly title?: string
  readonly version?: number
}

const readAction = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
): FileActionPayload => {
  const payload = result?.payload
  if (payload && typeof payload === 'object' && 'path' in payload) {
    return payload as FileActionPayload
  }
  const input =
    call.input && typeof call.input === 'object'
      ? (call.input as { path?: unknown; title?: unknown })
      : null
  const tool =
    call.name === EDIT_FILE_TOOL_NAME
      ? 'edit_file'
      : call.name === READ_FILE_TOOL_NAME
        ? 'read_file'
        : 'present_file'
  return {
    tool,
    path: typeof input?.path === 'string' ? input.path : 'file',
    ...(typeof input?.title === 'string' && input.title.trim()
      ? { title: input.title.trim() }
      : {}),
  }
}

const fence = (lang: string, body: string) => {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

export const serializeWorkspaceFileForArchive = (
  call: ToolCallRecord,
  result: ToolResultRecord | undefined
): readonly ArchiveFragment[] => {
  const action = readAction(call, result)
  const input =
    call.input && typeof call.input === 'object'
      ? (call.input as { content?: unknown; title?: unknown })
      : null
  if (call.name === PRESENT_FILE_TOOL_NAME && typeof input?.content === 'string') {
    const lang = getCodeLanguage(action.path, '')
    const title = action.title || action.path
    return [
      {
        type: 'MARKDOWN',
        content: `**${title}**\n\n${fence(lang === 'text' ? '' : lang, input.content)}`,
        separate: true,
      },
    ]
  }
  if (call.name === EDIT_FILE_TOOL_NAME) {
    return [
      {
        type: 'MARKDOWN',
        content: fence(
          'text',
          `[Updated ${action.path}${action.version ? ` (v${action.version})` : ''}]`
        ),
        separate: true,
      },
    ]
  }
  if (call.name === READ_FILE_TOOL_NAME) {
    return [{ type: 'MARKDOWN', content: fence('text', `[Read ${action.path}]`), separate: true }]
  }
  return []
}

const FileActivityView = ({
  entries,
  sessionId,
  openFile,
  focusedCallId,
  focusNonce,
}: ActivityStepRenderProps) => {
  const t = workspaceMessages.useTranslate()
  const hasFocused = Boolean(
    focusedCallId && entries.some((entry) => entry.call.id === focusedCallId)
  )
  const [open, setOpen] = useState(hasFocused)

  useEffect(() => {
    if (hasFocused) {
      setOpen(true)
    }
  }, [focusedCallId, focusNonce, hasFocused])

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.toggleHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.title}>
          <IconBrowseOutline16 />
          <span>{t('activityFileTitle')}</span>
          <span className={styles.meta}>{entries.length}</span>
        </span>
        <span className={styles.chevron} aria-hidden="true">
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
      </button>
      {open ? (
        <div className={styles.list}>
          {entries.map(({ call, result }) => {
            const action = readAction(call, result)
            const key =
              action.tool === 'edit_file'
                ? 'activityFileEdited'
                : action.tool === 'read_file'
                  ? 'activityFileRead'
                  : 'activityFilePresented'
            const label = t(key, { path: action.title || action.path })
            const fileRef = result?.files?.[0]
            const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')
            if (fileRef && sessionId && openFile) {
              return (
                <button
                  key={call.id}
                  type="button"
                  data-activity-call-id={call.id}
                  className={clsx(styles.row, styles.rowButton, failed && styles.rowError)}
                  onClick={() => openFile(sessionId, fileRef)}
                >
                  <span className={styles.path}>{label}</span>
                  {action.version ? (
                    <span className={styles.meta}>
                      {t('previewVersionLabel', { version: action.version })}
                    </span>
                  ) : null}
                </button>
              )
            }
            return (
              <div
                key={call.id}
                data-activity-call-id={call.id}
                className={clsx(styles.row, failed && styles.rowError)}
              >
                <span className={styles.path}>{label}</span>
                {action.version ? (
                  <span className={styles.meta}>
                    {t('previewVersionLabel', { version: action.version })}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export const workspaceFilesPresenter: ToolStepPresenter = {
  summarize: (call, result, { streaming }) => {
    const action = readAction(call, result)
    const running = !result || result.status === 'running'
    return {
      lane: 'files',
      icon: <IconBrowseOutline16 />,
      liveVerb: workspaceMessages.translate('activityFileWorking'),
      detail: action.title || action.path,
      stillRunning: running && streaming,
      failed: !running && result.status !== 'ok',
      tally: {
        key: 'files',
        count: 1,
        label: (count) =>
          workspaceMessages.translate(
            count === 1 ? 'activityFileCountOne' : 'activityFileCountMany',
            {
              count,
            }
          ),
      },
    }
  },
  renderActivity: FileActivityView,
}
