import { getReplyText } from '../reply.js'
import type { Message } from '../types.js'
import { estimateTextTokens, hasCompactableText } from './estimate.js'

export type VerbatimSelection = {
  readonly text: string
  readonly keptMessagesCount: number
  readonly droppedMessagesCount: number
}

type VerbatimCandidate = {
  readonly index: number
  readonly role: 'user' | 'assistant'
  readonly formatted: string
  readonly tokens: number
}

const formatUserCandidate = (message: Extract<Message, { role: 'user' }>): string | null => {
  const parts: string[] = []
  if (message.files.length > 0) {
    const names = message.files.map((file) => file.name).join(', ')
    parts.push(`[Attached: ${names}]`)
  }
  const trimmed = message.content.trim()
  if (trimmed) {
    parts.push(trimmed)
  }
  if (parts.length === 0) {
    return null
  }
  return `[User]\n${parts.join('\n')}`
}

const formatAssistantCandidate = (
  message: Extract<Message, { role: 'assistant' }>
): string | null => {
  if (!hasCompactableText(message)) {
    return null
  }
  const text = getReplyText(message).trim()
  return text ? `[Assistant]\n${text}` : null
}

/**
 * Selects a bounded verbatim slice of recent dialogue in original chronological order.
 * Prioritizes newest user messages first (always keeping the latest user message when it fits),
 * then fills remaining budget with newest usable assistant replies, keeping each message whole.
 */
export const buildVerbatimSection = (
  messages: readonly Message[],
  budgetTokens: number
): VerbatimSelection => {
  const candidates: VerbatimCandidate[] = []
  for (const message of messages) {
    const formatted =
      message.role === 'user' ? formatUserCandidate(message) : formatAssistantCandidate(message)
    if (!formatted) {
      continue
    }
    candidates.push({
      index: candidates.length,
      role: message.role,
      formatted,
      tokens: estimateTextTokens(formatted) + 6,
    })
  }

  if (candidates.length === 0 || budgetTokens <= 0) {
    return {
      text: '',
      keptMessagesCount: 0,
      droppedMessagesCount: candidates.length,
    }
  }

  const chosen = new Set<number>()
  let usedTokens = 0

  // Pass 1: newest user messages first.
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const item = candidates[i]
    if (item.role !== 'user') {
      continue
    }
    if (usedTokens + item.tokens <= budgetTokens) {
      chosen.add(item.index)
      usedTokens += item.tokens
    }
  }

  // Pass 2: newest assistant prose replies with remaining budget.
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const item = candidates[i]
    if (item.role !== 'assistant' || chosen.has(item.index)) {
      continue
    }
    if (usedTokens + item.tokens <= budgetTokens) {
      chosen.add(item.index)
      usedTokens += item.tokens
    }
  }

  const ordered = candidates.filter((item) => chosen.has(item.index))
  const keptMessagesCount = ordered.length
  const droppedMessagesCount = candidates.length - keptMessagesCount

  if (keptMessagesCount === 0) {
    return {
      text: '',
      keptMessagesCount: 0,
      droppedMessagesCount,
    }
  }

  const header =
    droppedMessagesCount > 0
      ? `(${droppedMessagesCount} earlier ${droppedMessagesCount === 1 ? 'message' : 'messages'} summarized above; ${keptMessagesCount} recent ${keptMessagesCount === 1 ? 'message' : 'messages'} kept verbatim below.)`
      : `(${keptMessagesCount} ${keptMessagesCount === 1 ? 'message' : 'messages'} kept verbatim below.)`

  return {
    text: `${header}\n\n${ordered.map((item) => item.formatted).join('\n\n')}`,
    keptMessagesCount,
    droppedMessagesCount,
  }
}
