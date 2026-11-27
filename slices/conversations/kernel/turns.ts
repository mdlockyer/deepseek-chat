import type { AssistantMessage } from './types.js'

/** A user's prompt shortened to one line, for turn labels in lists and on the transcript minimap. */
export const excerptOfPrompt = (text: string): string => {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 56 ? `${clean.slice(0, 55)}…` : clean
}

/** Whether a reply recorded anything worth inspecting: reasoning or tool steps. */
export const hasTurnActivity = (message: AssistantMessage): boolean =>
  message.blocks.some(
    (block) =>
      block.type === 'thinking' || block.type === 'tool_use' || block.type === 'tool_result'
  )
