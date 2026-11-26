import type { CompactionTrigger } from '../types.js'

export const CHECKPOINT_ACK = 'Understood. I will continue from this checkpoint.'

const formatCompactTokens = (tokens: number): string =>
  tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens)

const triggerSummaryPhrase = (
  trigger: CompactionTrigger,
  tokensBefore: number,
  line: number,
  window: number
): string => {
  const before = formatCompactTokens(tokensBefore)
  const lineStr = formatCompactTokens(line)
  const windowStr = formatCompactTokens(window)
  switch (trigger) {
    case 'turnStart':
      return `This conversation reached about ${before} tokens (above the ${lineStr} token compaction line for a ${windowStr} token window) before the next user message.`
    case 'betweenRounds':
      return `The current turn reached about ${before} tokens between tool rounds (above the ${lineStr} token compaction line for a ${windowStr} token window).`
    case 'manual':
      return `The user manually asked to compact this conversation (currently about ${before} tokens in a ${windowStr} token window).`
    case 'fit':
      return `The request reached about ${before} tokens, exceeding the safe context ceiling for this ${windowStr} token window.`
    case 'overflow':
      return `The model provider rejected the previous request for exceeding its context or payload limit (estimated around ${before} tokens).`
  }
}

export const buildCompactionInstruction = (params: {
  readonly trigger: CompactionTrigger
  readonly tokensBefore: number
  readonly line: number
  readonly contextWindow: number
  readonly hasPendingQuestion: boolean
  readonly midTurn: boolean
  readonly droppingReasoning: boolean
}): string => {
  const {
    trigger,
    tokensBefore,
    line,
    contextWindow,
    hasPendingQuestion,
    midTurn,
    droppingReasoning,
  } = params

  const situation = triggerSummaryPhrase(trigger, tokensBefore, line, contextWindow)
  const boundaryNote = midTurn
    ? 'A reply turn is currently in progress. Your summary will anchor the checkpoint before the next tool round runs, while the original turn request and any newer tool results remain in context.'
    : hasPendingQuestion
      ? 'A new user message is waiting and will be delivered verbatim right after this checkpoint. Do not answer the pending user message here.'
      : 'The conversation is paused between turns and will continue from this checkpoint on the next user message.'

  const retentionNote = droppingReasoning
    ? 'The checkpoint will preserve your summary, recent dialogue verbatim, and a deterministic ledger of files, sources, and user decisions. Raw older tool outputs, earlier inline images/attachments, and prior hidden reasoning will be dropped.'
    : 'The checkpoint will preserve your summary, recent dialogue verbatim, and a deterministic ledger of files, sources, and user decisions. Raw older tool outputs and earlier inline images/attachments will be dropped.'

  return [
    'From the app harness, not the user:',
    situation,
    boundaryNote,
    retentionNote,
    'Write a concise, accurate handoff summary so you can resume seamlessly without re-asking the user or repeating completed work. Keep concrete facts, numbers, paths, URLs, constraints, and unresolved issues intact; never claim an action succeeded unless tool results actually confirmed it.',
    'Use these exact English markdown headings (write the content under each heading in the language of the conversation):',
    '## Goal',
    '## Current State',
    '## Decisions & Constraints',
    '## Key Findings',
    '## Next Steps',
    'Write only the structured summary. Do not call any tools, do not include preamble or sign-off, and keep it concise.',
  ].join('\n\n')
}

export const buildChunkedCompactionPrompt = (params: {
  readonly chunkText: string
  readonly previousSummary: string | null
  readonly chunkIndex: number
  readonly totalChunks: number
  readonly trigger: CompactionTrigger
  readonly tokensBefore: number
  readonly line: number
  readonly contextWindow: number
  readonly midTurn: boolean
}): string => {
  const {
    chunkText,
    previousSummary,
    chunkIndex,
    totalChunks,
    trigger,
    tokensBefore,
    line,
    contextWindow,
    midTurn,
  } = params

  const header = [
    'From the app harness, not the user:',
    triggerSummaryPhrase(trigger, tokensBefore, line, contextWindow),
    `Because the full transcript exceeded the request ceiling, you are folding chunk ${chunkIndex + 1} of ${totalChunks} in plain text (binary images and raw file payloads are marked as omitted).`,
    midTurn
      ? 'A turn is currently in progress; capture everything needed to finish it cleanly on the next round.'
      : 'Capture everything needed to continue seamlessly from this checkpoint.',
  ].join('\n\n')

  const priorSection = previousSummary
    ? `### Running summary from earlier chunks\n\n${previousSummary}\n\nUpdate and merge that running summary with the new transcript chunk below, preserving important facts and pruning superseded details.`
    : 'Summarize the transcript chunk below.'

  return [
    header,
    priorSection,
    `### Transcript chunk ${chunkIndex + 1} of ${totalChunks}\n\n${chunkText}`,
    'Use these exact English markdown headings (write the content under each heading in the language of the conversation):',
    '## Goal',
    '## Current State',
    '## Decisions & Constraints',
    '## Key Findings',
    '## Next Steps',
    'Write only the updated structured summary. Do not call any tools and do not add preamble or sign-off.',
  ].join('\n\n')
}

const GOAL_HEADING_PATTERN = /^#{1,3}\s+(?:Goal\b|目标)/im
const NEXT_STEPS_HEADING_PATTERN = /^#{1,3}\s+(?:Next Steps\b|下一步)/im
const MIN_SUMMARY_CHARS = 24

/**
 * Rejects empty, trivial (e.g. "OK"), or structurally broken compaction summaries so bad output
 * never replaces working context.
 */
export const validateCompactionSummary = (
  raw: string
):
  | { readonly ok: true; readonly summary: string }
  | { readonly ok: false; readonly reason: string } => {
  const summary = raw.trim()
  if (summary.length < MIN_SUMMARY_CHARS) {
    return { ok: false, reason: 'Compaction summary was empty or too short.' }
  }
  if (!GOAL_HEADING_PATTERN.test(summary)) {
    return { ok: false, reason: 'Compaction summary is missing the required Goal section.' }
  }
  if (!NEXT_STEPS_HEADING_PATTERN.test(summary)) {
    return { ok: false, reason: 'Compaction summary is missing the required Next Steps section.' }
  }
  return { ok: true, summary }
}

export const renderCheckpointWireText = (params: {
  readonly trigger: CompactionTrigger
  readonly droppedReasoning: boolean
  readonly summary: string
  readonly ledger: string
  readonly verbatim: string
  readonly midTurnRequest?: string
}): string => {
  const { trigger, droppedReasoning, summary, ledger, verbatim, midTurnRequest } = params
  const framing = [
    'Earlier conversation history on this branch was compacted into the checkpoint below so the chat stays within the model context window.',
    droppedReasoning
      ? 'Raw older tool outputs, earlier attachments, and pre-checkpoint reasoning were omitted. Rely on the summary, verified ledger, and recent verbatim messages below rather than guessing dropped details; re-read files or re-run tools if you need exact raw output.'
      : 'Raw older tool outputs and earlier attachments were omitted. Rely on the summary, verified ledger, and recent verbatim messages below rather than guessing dropped details; re-read files or re-run tools if you need exact raw output.',
    trigger === 'betweenRounds' || midTurnRequest
      ? 'This checkpoint was created mid-turn between tool rounds; continue finishing the active request cleanly.'
      : 'Continue naturally from this checkpoint when responding to the user.',
  ].join(' ')

  const parts: string[] = ['<conversation_checkpoint>', framing, `### Summary\n\n${summary}`]

  if (ledger.trim()) {
    parts.push(`### Verified state and artifacts\n\n${ledger.trim()}`)
  }
  if (verbatim.trim()) {
    parts.push(`### Recent conversation (verbatim)\n\n${verbatim.trim()}`)
  }
  if (midTurnRequest?.trim()) {
    parts.push(`### Active turn request\n\n${midTurnRequest.trim()}`)
  }
  parts.push('</conversation_checkpoint>')
  return parts.join('\n\n')
}
