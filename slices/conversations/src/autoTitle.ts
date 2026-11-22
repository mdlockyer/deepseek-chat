import type { ChatModel, CreateMessageRequest } from './api/types.js'
import { toRequestMessages } from './reply.js'
import type { AssistantMessage, Message, UserMessage } from './types.js'

export const AUTO_TITLE_KEEP = 'KEEP'
export const MAX_AUTO_TITLE_CHARS = 60

export const buildAutoTitlePrompt = (currentTitle: string): string => {
  const trimmed = currentTitle.trim()
  if (trimmed) {
    return [
      'Update the short session title for this conversation based on the full thread so far.',
      `Current title: ${JSON.stringify(trimmed)}`,
      `Reply with ONLY ${AUTO_TITLE_KEEP} if the current title still accurately reflects the conversation's main topic, or reply with a new concise title (max 6 words, same language as the user, no quotes, no markdown, no trailing punctuation). Do not call any tools.`,
    ].join('\n')
  }
  return 'Generate a concise session title (max 6 words, same language as the user, no quotes, no markdown, no trailing punctuation) for this conversation. Reply with ONLY the title. Do not call any tools.'
}

const stripSurroundingQuotes = (value: string): string => {
  const pairs: readonly [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['“', '”'],
    ['‘', '’'],
    ['«', '»'],
    ['「', '」'],
    ['『', '』'],
  ]
  let text = value.trim()
  let changed = true
  while (changed) {
    changed = false
    for (const [open, close] of pairs) {
      if (
        text.length >= open.length + close.length &&
        text.startsWith(open) &&
        text.endsWith(close)
      ) {
        text = text.slice(open.length, text.length - close.length).trim()
        changed = true
      }
    }
  }
  return text
}

/**
 * Parses the model's ephemeral rename reply. Returns the new title, or `null` when the current
 * title should be kept (empty output, `KEEP`, or identical to `currentTitle`).
 */
export const parseAutoTitleResponse = (raw: string, currentTitle: string): string | null => {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) {
    return null
  }
  let cleaned = firstLine.replace(/^(?:#+\s*|[-*•]\s*)/, '').trim()
  cleaned = stripSurroundingQuotes(cleaned)
  cleaned = cleaned.replace(/[.。:：]+$/, '').trim()
  cleaned = stripSurroundingQuotes(cleaned)
  if (!cleaned || cleaned.toUpperCase() === AUTO_TITLE_KEEP) {
    return null
  }
  if (cleaned.length > MAX_AUTO_TITLE_CHARS) {
    cleaned = cleaned.slice(0, MAX_AUTO_TITLE_CHARS).trim()
  }
  if (!cleaned || cleaned === currentTitle.trim()) {
    return null
  }
  return cleaned
}

export type AutoTitleRequestParams = {
  readonly model: ChatModel
  readonly system: string
  readonly tools: CreateMessageRequest['tools']
  readonly safetyCheck?: CreateMessageRequest['safety_check']
  readonly history: Message[]
  readonly question: UserMessage
  readonly reply: AssistantMessage
  readonly declaredClientNames: ReadonlySet<string>
  readonly currentTitle: string
}

/**
 * Builds a detached fork request that reuses the exact prefix (`model`, `system`, `tools`,
 * `safety_check`, and `messages` up through `reply`) so the server hits its KV prefix cache
 * without mutating the stored conversation or invalidating the next user turn.
 */
export const buildAutoTitleRequest = ({
  model,
  system,
  tools,
  safetyCheck,
  history,
  question,
  reply,
  declaredClientNames,
  currentTitle,
}: AutoTitleRequestParams): CreateMessageRequest => {
  const syntheticQuestion: UserMessage = {
    id: '__auto_title__',
    role: 'user',
    content: buildAutoTitlePrompt(currentTitle),
    files: [],
    createdAt: 0,
  }
  const messages = toRequestMessages(
    [...history, question, reply],
    syntheticQuestion,
    undefined,
    false,
    undefined,
    undefined,
    declaredClientNames
  )
  return {
    model,
    system,
    messages,
    thinking: { type: 'disabled' },
    ...(safetyCheck ? { safety_check: safetyCheck } : {}),
    tools,
  }
}
