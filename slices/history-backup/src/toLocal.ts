import type { CitedSourceMeta } from '@deepseek-chat/lib-tools'
import { fail } from './errors.js'
import type { ChatMessage, FileEntry, Fragment, SessionFile } from './format.js'
import { sessionFilesDir } from './paths.js'
import type {
  BackupAssistantMessage,
  BackupFileAttachment,
  BackupMessage,
  BackupReplyBlock,
  BackupReplyStatus,
  BackupSession,
  BackupUserMessage,
} from './types.js'

export type LocalSession = {
  session: BackupSession
  /** 本会话目录下应存在的图片：ZIP 条目名 → 文件 ID */
  images: Map<string, string>
}

const time = (value: string) => Date.parse(value)

/** 链接会渲染成 href，只接受 HTTP / HTTPS。 */
const isWebUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const siteNameOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const toFile = (file: FileEntry): BackupFileAttachment => ({
  id: file.id,
  serverId: null,
  name: file.file_name,
  size: file.file_size,
  isImage: file.is_image,
  mimeType: '',
})

const toUser = (message: ChatMessage): BackupUserMessage => ({
  id: String(message.id),
  role: 'user',
  createdAt: time(message.inserted_at),
  content: message.fragments.map((item) => (item.type === 'REQUEST' ? item.content : '')).join(''),
  files: message.fragments.flatMap((item) => (item.type === 'FILE' ? item.files.map(toFile) : [])),
})

const toBlocks = (fragments: Fragment[], messageId: string): BackupReplyBlock[] =>
  fragments.flatMap((item, index): BackupReplyBlock[] => {
    const id = `history-${messageId}-${index}`
    switch (item.type) {
      case 'RESPONSE':
        return [{ type: 'text', text: item.content }]
      case 'TEMPLATE_RESPONSE':
        return [{ type: 'text', text: item.content, isTemplate: true }]
      case 'THINK':
        return [
          {
            type: 'thinking',
            thinking: item.content,
            ...(item.elapsed_secs === null ? {} : { elapsedSeconds: item.elapsed_secs }),
          },
        ]
      case 'TOOL_SEARCH': {
        const query = item.queries.filter((q) => q.trim()).join(' ')
        const sources: CitedSourceMeta[] =
          item.status === 'FAILED'
            ? []
            : item.results
                .filter((result) => isWebUrl(result.url))
                .map((result) => ({
                  url: result.url,
                  title: result.title ?? result.url,
                  snippet: result.snippet ?? '',
                  siteName: result.site_name ?? siteNameOf(result.url),
                  publishedAt: result.published_at,
                }))
        return [
          { type: 'tool_use', id, name: 'web_search', input: { query } },
          ...(item.status === 'WIP'
            ? []
            : [
                {
                  type: 'tool_result' as const,
                  tool_use_id: id,
                  capability: 'web-research',
                  content: '',
                  status: item.status === 'FAILED' ? ('error' as const) : ('ok' as const),
                  sources,
                  payload: { kind: 'search', query },
                },
              ]),
        ]
      }
      case 'TOOL_OPEN': {
        if (!item.url || !isWebUrl(item.url)) {
          return []
        }
        const sources: CitedSourceMeta[] =
          item.status === 'FINISHED'
            ? [
                {
                  url: item.url,
                  title: item.title ?? item.url,
                  snippet: item.snippet ?? '',
                  siteName: item.site_name ?? siteNameOf(item.url),
                  publishedAt: item.published_at,
                },
              ]
            : []
        return [
          { type: 'tool_use', id, name: 'web_scrape', input: { url: item.url } },
          ...(item.status === 'WIP'
            ? []
            : [
                {
                  type: 'tool_result' as const,
                  tool_use_id: id,
                  capability: 'web-research',
                  content: '',
                  status: item.status === 'FAILED' ? ('error' as const) : ('ok' as const),
                  sources,
                  payload: { kind: 'scrape', url: item.url, title: item.title },
                },
              ]),
        ]
      }
      case 'TOOL_FIND':
      case 'READ_LINK':
      default:
        return []
    }
  })

const replyStatus: Record<ChatMessage['status'], BackupReplyStatus> = {
  FINISHED: 'done',
  CONTENT_FILTER: 'done',
  FAILED: 'error',
  CONTEXT_LENGTH_EXCEEDED: 'error',
  INCOMPLETE: 'stopped',
  TIMEOUT: 'error',
  WIP: 'stopped',
}

const toAssistant = (message: ChatMessage): BackupAssistantMessage => {
  const id = String(message.id)
  const blocks = toBlocks(message.fragments, id)
  const refused = message.status === 'CONTENT_FILTER'
  return {
    id,
    role: 'assistant',
    createdAt: time(message.inserted_at),
    model: null,
    thinking: message.thinking_enabled,
    enabledCapabilities: message.search_enabled ? { 'web-research': true } : {},
    status: replyStatus[message.status],
    ...(refused ? { stopReason: 'refusal' as const } : {}),
    blocks: refused
      ? blocks.filter(
          (block) => block.type !== 'thinking' && (block.type !== 'text' || block.isTemplate)
        )
      : blocks,
  }
}

const buildTree = (file: SessionFile): Pick<BackupSession, 'messages' | 'rootMessageId'> => {
  const sorted = file.messages.toSorted((a, b) => a.id - b.id)
  const byId = new Map<number, BackupMessage>()
  const messages = sorted.map((message) => {
    const { id, parent_id } = message
    const parent = parent_id === null ? undefined : byId.get(parent_id)
    if (
      byId.has(id) ||
      (parent_id === null ? message.role !== 'USER' : !parent) ||
      (parent && parent.role === (message.role === 'USER' ? 'user' : 'assistant'))
    ) {
      fail('backupInvalidBranches')
    }
    const local = message.role === 'USER' ? toUser(message) : toAssistant(message)
    local.parentId = parent ? parent.id : null
    if (parent) {
      parent.selectedChildId = local.id
    }
    byId.set(id, local)
    return local
  })
  if (messages.length === 0) {
    return { messages, rootMessageId: null }
  }
  let current = byId.get(file.current_message_id) ?? fail('backupInvalidBranches')
  current.selectedChildId = undefined
  while (current.parentId) {
    const parent = byId.get(Number(current.parentId)) ?? fail('backupInvalidBranches')
    parent.selectedChildId = current.id
    current = parent
  }
  return { messages, rootMessageId: current.id }
}

/** 转换单个会话，并列出本会话目录下需要从 ZIP 读取的图片。 */
export const toLocalSession = (file: SessionFile): LocalSession => {
  const session: BackupSession = {
    id: file.id,
    title: file.title ?? '',
    createdAt: time(file.inserted_at),
    updatedAt: time(file.updated_at),
    ...buildTree(file),
  }
  const images = new Map<string, string>()
  for (const message of file.messages) {
    for (const item of message.fragments) {
      if (item.type !== 'FILE') {
        continue
      }
      for (const entry of item.files) {
        if (!entry.is_image) {
          continue
        }
        const path = entry.export_path?.normalize('NFC')
        if (path === undefined) {
          continue
        }
        if (
          !path.startsWith(sessionFilesDir(file.id)) ||
          (images.get(path) ?? entry.id) !== entry.id
        ) {
          fail('backupInvalidFiles')
        }
        images.set(path, entry.id)
      }
    }
  }
  return { session, images }
}
