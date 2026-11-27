import type { ReplyBlock } from './types.js'

/**
 * Collects every cited URL already assigned in a reply, in the exact order `buildReplyView`
 * registers them in `SourceRegistry`. This is the single source of truth for reply citation numbers.
 */
export const collectCitedUrls = (blocks: readonly ReplyBlock[]): Map<string, number> => {
  const toolResults = new Map<string, Extract<ReplyBlock, { type: 'tool_result' }>>()
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      toolResults.set(block.tool_use_id, block)
    }
  }

  const cited = new Map<string, number>()
  const addUrl = (url: string) => {
    const trimmed = url.trim()
    if (trimmed && !cited.has(trimmed)) {
      cited.set(trimmed, cited.size + 1)
    }
  }

  for (const block of blocks) {
    if (block.type !== 'tool_use') {
      continue
    }
    const result = toolResults.get(block.id)
    if (!result) {
      continue
    }
    for (const item of result.sources ?? []) {
      addUrl(item.url)
    }
  }

  return cited
}
