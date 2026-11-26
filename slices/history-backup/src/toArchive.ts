import type { ToolCallRecord, ToolResultRecord } from '@deepseek-chat/lib-tools'
import { fail } from './errors.js'
import type {
  ChatMessage,
  ChatMessageStatus,
  FileEntry,
  Fragment,
  SessionFile,
  SessionIndexEntry,
} from './format.js'
import type {
  BackupAssistantMessage,
  BackupMessage,
  BackupSession,
  BackupToolResultPart,
  BackupUserMessage,
  ToolBlockSerializer,
} from './types.js'

/** 返回图片原件在 ZIP 里的条目名；无原件或非图片附件返回 null，仅导出元数据。 */
export type ExportImage = (file: { id: string; name: string; isImage: boolean }) => string | null

export type ToSessionFileOptions = {
  readonly serializeToolBlock?: ToolBlockSerializer
  readonly describeReplyNotice?: (message: BackupAssistantMessage) => string | null
}

const iso = (ms: number) => new Date(ms).toISOString()

const isoOrNull = (value: string | null) => {
  const ms = value === null ? NaN : Date.parse(value)
  return Number.isFinite(ms) ? iso(ms) : null
}

const normalizeSession = (session: BackupSession): BackupSession =>
  session.rootMessageId !== undefined
    ? session
    : {
        ...session,
        rootMessageId: session.messages[0]?.id ?? null,
        messages: session.messages.map((message, index, messages) => ({
          ...message,
          parentId: messages[index - 1]?.id ?? null,
          selectedChildId: messages[index + 1]?.id,
        })),
      }

const getVisibleMessages = (session: BackupSession): BackupMessage[] => {
  if (session.rootMessageId === undefined) {
    return session.messages
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const path: BackupMessage[] = []
  let id = session.rootMessageId
  while (id) {
    const message = byId.get(id)
    if (!message) {
      break
    }
    path.push(message)
    byId.delete(id)
    id = message.selectedChildId ?? null
  }
  return path
}

const userFragments = (message: BackupUserMessage, exportImage: ExportImage): Fragment[] => {
  const files = message.files.map((file): FileEntry => {
    const isImage = file.isImage
    return {
      id: file.id,
      file_name: file.name,
      file_size: file.size,
      token_usage: null,
      inserted_at: iso(message.createdAt),
      export_path: exportImage({ id: file.id, name: file.name, isImage }),
      is_image: isImage,
      width: null,
      height: null,
    }
  })
  return [
    ...(files.length > 0 ? [{ type: 'FILE' as const, files }] : []),
    { type: 'REQUEST', content: message.content },
  ]
}

const fence = (lang: string, body: string) => {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

const joinMarkdown = (existing: string, addition: string) => {
  if (!existing) {
    return addition
  }
  const gap =
    existing.endsWith('\n\n') || addition.startsWith('\n\n')
      ? ''
      : existing.endsWith('\n') || addition.startsWith('\n')
        ? '\n'
        : '\n\n'
  return `${existing}${gap}${addition}`
}

const stripCitations = (value: string) =>
  value.replace(
    /([ \t]*)((?:\[(?:citation|ref):\d+\][ \t]*)+)/g,
    (full, leadingSpace: string, run: string, offset: number, src: string) => {
      const after = src.slice(offset + full.length)
      const hasTrailingSpace = /[ \t]$/.test(run)
      if (after.length === 0 || /^[.,;:!?)\]}，。；：！？）》】]/.test(after)) {
        return ''
      }
      return leadingSpace || hasTrailingSpace ? ' ' : ''
    }
  )

const toToolResultRecord = (block: BackupToolResultPart): ToolResultRecord => ({
  tool_use_id: block.tool_use_id,
  capability: block.capability,
  content: block.content,
  status: block.status,
  files: block.files,
  sources: block.sources ?? block.searchResults,
  payload: block.payload,
})

const assistantFragments = (
  message: BackupAssistantMessage,
  options: ToSessionFileOptions
): Fragment[] => {
  const { blocks } = message
  const clientResults = new Map<string, BackupToolResultPart>()
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      clientResults.set(block.tool_use_id, block)
    }
  }

  const usedSources = blocks.some(
    (block) =>
      block.type === 'tool_result' &&
      ((block.sources?.length ?? 0) > 0 || (block.searchResults?.length ?? 0) > 0)
  )

  const handledToolResultIds = new Set<string>()
  const fragments: Fragment[] = []
  let response: { type: 'RESPONSE' | 'TEMPLATE_RESPONSE'; content: string } | undefined
  let separateNextText = false

  const appendResponse = (chunk: string, separate: boolean) => {
    if (!response || response.type !== 'RESPONSE') {
      response = { type: 'RESPONSE', content: '' }
      fragments.push(response)
    }
    response.content = separate
      ? joinMarkdown(response.content, chunk)
      : `${response.content}${chunk}`
  }

  for (const block of blocks) {
    if (block.type === 'text') {
      const text = usedSources ? stripCitations(block.text) : block.text
      if (block.isTemplate) {
        if (!response || response.type !== 'TEMPLATE_RESPONSE') {
          response = { type: 'TEMPLATE_RESPONSE', content: '' }
          fragments.push(response)
        }
        response.content += text
      } else {
        appendResponse(text, separateNextText)
      }
      separateNextText = false
      continue
    }

    if (block.type === 'tool_use') {
      const rawResult = clientResults.get(block.id)
      const callRecord: ToolCallRecord = {
        id: block.id,
        name: block.name,
        input: block.input,
        inputJson: block.inputJson,
      }
      const custom = options.serializeToolBlock?.(
        callRecord,
        rawResult ? toToolResultRecord(rawResult) : undefined
      )
      if (custom !== undefined && custom !== null) {
        handledToolResultIds.add(block.id)
        for (const item of custom) {
          if (item.type === 'MARKDOWN') {
            appendResponse(item.content, item.separate !== false)
            separateNextText = true
          } else if (item.type === 'TOOL_SEARCH') {
            fragments.push({
              type: 'TOOL_SEARCH',
              queries: [...item.queries],
              status: item.status,
              results: item.results.map((r) => ({ ...r, published_at: isoOrNull(r.published_at) })),
            })
            response = undefined
            separateNextText = false
          } else {
            fragments.push({
              type: 'TOOL_OPEN',
              status: item.status,
              url: item.url,
              title: item.title,
              snippet: item.snippet,
              site_name: item.site_name,
              published_at: isoOrNull(item.published_at),
            })
            response = undefined
            separateNextText = false
          }
        }
        continue
      }

      // Generic domain-blind fallback for unmounted or unregistered client tools.
      const input = block.input as { code?: unknown } | null
      const code =
        typeof input?.code === 'string'
          ? input.code
          : (block.inputJson ?? (block.input ? JSON.stringify(block.input) : ''))
      if (code.trim()) {
        appendResponse(fence('', code), true)
        separateNextText = true
      }
      continue
    }

    if (block.type === 'tool_result') {
      if (handledToolResultIds.has(block.tool_use_id)) {
        continue
      }
      if (block.status !== 'running' && block.content.trim()) {
        appendResponse(fence('text', block.content), true)
        separateNextText = true
      }
      continue
    }

    const converted: Fragment[] =
      block.type === 'thinking' && block.thinking
        ? [
            {
              type: 'THINK',
              content: block.thinking,
              elapsed_secs:
                block.elapsedSeconds ??
                (block.startedAt === undefined || block.endedAt === undefined
                  ? null
                  : (block.endedAt - block.startedAt) / 1000),
            },
          ]
        : []
    if (converted.length > 0) {
      fragments.push(...converted)
      response = undefined
      separateNextText = false
    }
  }

  const hasTemplate = blocks.some((block) => block.type === 'text' && block.isTemplate)
  if (
    (message.status === 'error' && message.error) ||
    (!hasTemplate && message.stopReason === 'refusal')
  ) {
    const noticeText = options.describeReplyNotice?.(message)
    if (noticeText) {
      fragments.push({ type: 'TEMPLATE_RESPONSE', content: noticeText })
    }
  }
  return fragments
}

const replyStatus = ({ status, stopReason }: BackupAssistantMessage): ChatMessageStatus => {
  if (stopReason === 'refusal') {
    return 'CONTENT_FILTER'
  }
  switch (status) {
    case 'done':
      return stopReason === 'max_tokens' ? 'INCOMPLETE' : 'FINISHED'
    case 'stopped':
      return 'INCOMPLETE'
    case 'error':
      return 'FAILED'
    default:
      return 'WIP'
  }
}

const contextTokens = ({ usage }: BackupAssistantMessage) =>
  usage
    ? usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens +
      usage.output_tokens
    : 0

const numberMessages = (messages: BackupMessage[]) => {
  const byId = new Map(messages.map((message) => [message.id, message]))
  const ids = new Map<string, number>()
  const ordered: BackupMessage[] = []
  const visit = (message: BackupMessage, depth: number) => {
    if (ids.has(message.id)) {
      return
    }
    if (message.parentId) {
      const parent = byId.get(message.parentId)
      visit(parent && depth < messages.length ? parent : fail('backupInvalidBranches'), depth + 1)
    }
    ids.set(message.id, ordered.push(message))
  }
  messages.forEach((message) => visit(message, 0))
  return { ordered, ids }
}

export const toSessionFile = (
  original: BackupSession,
  exportImage: ExportImage,
  options: ToSessionFileOptions = {}
): SessionFile => {
  const session = normalizeSession(original)
  const { ordered, ids } = numberMessages(session.messages)
  const id = (message: BackupMessage) => ids.get(message.id) ?? fail('backupInvalidBranches')
  const firstReply = new Map<string, BackupAssistantMessage>()
  for (const message of ordered) {
    if (message.role === 'assistant' && message.parentId && !firstReply.has(message.parentId)) {
      firstReply.set(message.parentId, message)
    }
  }
  const messages = ordered.map((message): ChatMessage => {
    const tree = {
      id: id(message),
      parent_id: message.parentId ? (ids.get(message.parentId) ?? null) : null,
    }
    const reply = message.role === 'assistant' ? message : firstReply.get(message.id)
    const searchEnabled = reply?.enabledCapabilities?.['web-research'] ?? reply?.search ?? false
    return {
      ...tree,
      role: message.role === 'user' ? 'USER' : 'ASSISTANT',
      status: message.role === 'user' ? 'FINISHED' : replyStatus(message),
      thinking_enabled: reply?.thinking ?? false,
      search_enabled: searchEnabled,
      accumulated_token_usage: message.role === 'user' ? 0 : contextTokens(message),
      inserted_at: iso(message.createdAt),
      fragments:
        message.role === 'user'
          ? userFragments(message, exportImage)
          : assistantFragments(message, options),
    }
  })
  const current = getVisibleMessages(session).at(-1)
  return {
    id: session.id,
    title: session.title || null,
    pinned: false,
    current_message_id: current ? id(current) : 0,
    inserted_at: iso(session.createdAt),
    updated_at: iso(session.updatedAt),
    messages,
  }
}

export const toIndexEntry = (file: SessionFile): SessionIndexEntry => ({
  id: file.id,
  title: file.title,
  pinned: false,
  message_count: file.messages.length,
  inserted_at: file.inserted_at,
  updated_at: file.updated_at,
})
