import {
  Banner,
  Button,
  IconBrowseOutline16,
  IconChevronRightOutline14,
} from '@deepseek-chat/lib-ui'
import type {
  ActivityStepDetailProps,
  ArchiveFragment,
  ToolCallRecord,
  ToolResultRecord,
  ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
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

const FileStepDetail = ({ entry, sessionId, openFile }: ActivityStepDetailProps) => {
  const t = workspaceMessages.useTranslate()
  const { call, result } = entry
  const action = readAction(call, result)
  const key =
    action.tool === 'edit_file'
      ? 'activityFileEdited'
      : action.tool === 'read_file'
        ? 'activityFileRead'
        : 'activityFilePresented'
  const actionLabel = t(key, { path: action.title || action.path })
  const fileRef = result?.files?.[0]
  const failed = Boolean(result && result.status !== 'ok' && result.status !== 'running')

  return (
    <div className={styles.detail}>
      <div className={styles.infoRow}>
        <span className={styles.actionLabel}>{actionLabel}</span>
        {action.version ? (
          <span className={styles.meta}>
            {t('previewVersionLabel', { version: action.version })}
          </span>
        ) : null}
      </div>
      {action.title && action.path && action.title !== action.path ? (
        <div className={styles.path}>{action.path}</div>
      ) : null}
      {failed && result?.content?.trim() ? (
        <Banner tone="error" compact role="note">
          <div className={styles.errorText}>{result.content.trim()}</div>
        </Banner>
      ) : null}
      {fileRef && sessionId && openFile ? (
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="s"
            trailingIcon={<IconChevronRightOutline14 />}
            onClick={() => openFile(sessionId, fileRef)}
          >
            {t('activityFileOpenPreview')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export const workspaceFilesPresenter: ToolStepPresenter = {
  summarize: (call, result, { streaming, locale }) => {
    const action = readAction(call, result)
    const running = !result || result.status === 'running'
    const version = action.version
      ? workspaceMessages.translate(locale, 'previewVersionLabel', { version: action.version })
      : undefined
    return {
      lane: 'files',
      icon: <IconBrowseOutline16 />,
      liveVerb: workspaceMessages.translate(locale, 'activityFileWorking'),
      detail: action.title || action.path,
      ...(version ? { meta: version } : {}),
      hasDetail: true,
      stillRunning: running && streaming,
      failed: !running && result.status !== 'ok',
      tally: {
        key: 'files',
        count: 1,
        label: (count) =>
          workspaceMessages.translate(
            locale,
            count === 1 ? 'activityFileCountOne' : 'activityFileCountMany',
            {
              count,
            }
          ),
      },
    }
  },
  renderStepDetail: FileStepDetail,
}
