import type {
  ActivityStepEntry,
  CompactionLedgerSection,
  DeliveredFileRef,
  ToolRegistry,
} from '@deepseek-chat/lib-tools'
import { formatSize } from '../attachments.js'
import type { FileAttachment, Message, ReplyBlock, ToolCallPart, ToolResultPart } from '../types.js'
import { estimateTextTokens } from './estimate.js'

const renderSectionsWithCap = (
  sections: readonly CompactionLedgerSection[],
  maxTokens: number
): string => {
  if (sections.length === 0 || maxTokens <= 0) {
    return ''
  }
  const output: string[] = []
  let usedTokens = 0
  let truncated = false

  for (const section of sections) {
    if (section.lines.length === 0) {
      continue
    }
    const heading = `#### ${section.title}`
    const headingTokens = estimateTextTokens(heading) + 4
    if (usedTokens + headingTokens > maxTokens) {
      truncated = true
      break
    }
    const keptLines: string[] = []
    let sectionTokens = headingTokens
    for (const line of section.lines) {
      const lineTokens = estimateTextTokens(line) + 2
      if (usedTokens + sectionTokens + lineTokens > maxTokens) {
        truncated = true
        break
      }
      keptLines.push(line)
      sectionTokens += lineTokens
    }
    if (keptLines.length > 0) {
      output.push(`${heading}\n${keptLines.join('\n')}`)
      usedTokens += sectionTokens
    }
    if (truncated) {
      break
    }
  }

  if (truncated && output.length > 0) {
    output.push('(Additional ledger entries omitted to stay within the checkpoint budget.)')
  }
  return output.join('\n\n')
}

/**
 * Deterministically builds a factual ledger of uploaded files, user decisions, and verified tool
 * outcomes from stored message/block records (never from model prose). Capability-specific facts
 * flow through the open `ToolRegistry.buildCompactionLedger` hook to keep `conversations` domain-blind.
 */
export const buildCompactionLedgerText = (params: {
  readonly messages: readonly Message[]
  readonly tools: ToolRegistry
  readonly maxTokens: number
}): string => {
  const { messages, tools, maxTokens } = params

  const uploads = new Map<string, FileAttachment>()
  const decisionLines: string[] = []
  const entriesByCapability = new Map<string, ActivityStepEntry[]>()
  const statesByCapability = new Map<string, unknown[]>()
  const deliveredFallback = new Map<string, DeliveredFileRef>()
  const capabilitiesWithLedger = new Set(
    tools.capabilities
      .filter((cap) => typeof cap.buildCompactionLedger === 'function')
      .map((cap) => cap.id)
  )

  const pushEntry = (capabilityId: string, entry: ActivityStepEntry) => {
    const list = entriesByCapability.get(capabilityId)
    if (list) {
      list.push(entry)
    } else {
      entriesByCapability.set(capabilityId, [entry])
    }
  }

  const pushState = (capabilityId: string, state: unknown) => {
    const list = statesByCapability.get(capabilityId)
    if (list) {
      list.push(state)
    } else {
      statesByCapability.set(capabilityId, [state])
    }
  }

  for (const message of messages) {
    if (message.role === 'user') {
      for (const file of message.files) {
        uploads.set(file.id, file)
      }
      continue
    }

    if (message.capabilityState) {
      for (const [capId, state] of Object.entries(message.capabilityState)) {
        if (state !== undefined) {
          pushState(capId, state)
        }
      }
    }

    const callsById = new Map<string, ToolCallPart>()
    const resultsById = new Map<string, ToolResultPart>()
    const callOrder: ToolCallPart[] = []

    const blocks: readonly ReplyBlock[] = message.blocks
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        callsById.set(block.id, block)
        callOrder.push(block)
      } else if (block.type === 'tool_result') {
        resultsById.set(block.tool_use_id, block)
        if (block.frontStageNote) {
          if (block.frontStageNote.status === 'skipped') {
            decisionLines.push(
              '- User skipped a clarifying question and deferred to the assistant.'
            )
          } else if (block.frontStageNote.status === 'done') {
            for (const item of block.frontStageNote.items) {
              const formatted = Array.isArray(item.value)
                ? item.value.filter(Boolean).join(', ')
                : item.value?.trim()
              if (formatted) {
                decisionLines.push(`- ${item.label}: ${formatted}`)
              }
            }
          }
        }
        if (block.status === 'ok' && block.files?.length) {
          for (const file of block.files) {
            const ownerCap = file.producer ?? block.capability
            if (!ownerCap || !capabilitiesWithLedger.has(ownerCap)) {
              const key = file.path ?? file.name
              deliveredFallback.set(key, file)
            }
          }
        }
      }
    }

    for (const call of callOrder) {
      const result = resultsById.get(call.id)
      const capabilityId = result?.capability ?? tools.capabilityIdOf(call.name)
      if (!capabilityId) {
        continue
      }
      pushEntry(capabilityId, {
        call: {
          id: call.id,
          name: call.name,
          input: call.input,
          ...(call.inputJson !== undefined ? { inputJson: call.inputJson } : {}),
        },
        ...(result ? { result } : {}),
      })
    }
  }

  const sections: CompactionLedgerSection[] = []

  if (uploads.size > 0) {
    const lines = [...uploads.values()].map((file) => {
      const kind = file.mimeType || (file.isImage ? 'image' : 'file')
      return `- \`${file.name}\` (${formatSize(file.size)}, ${kind})`
    })
    lines.push(
      'Earlier user attachments are no longer re-sent inline or by file reference after compaction; they remain stored locally in this chat.'
    )
    sections.push({ title: 'Uploaded files', lines })
  }

  if (decisionLines.length > 0) {
    sections.push({ title: 'User decisions', lines: decisionLines })
  }

  const capabilitySections = tools.buildCompactionLedger(entriesByCapability, statesByCapability)
  sections.push(...capabilitySections)

  if (deliveredFallback.size > 0) {
    const lines = [...deliveredFallback.values()].map((file) => {
      const label = file.path ?? file.name
      const version = file.version !== undefined ? `v${file.version}` : 'saved'
      const meta = file.title ? `${version}, ${file.title}` : version
      return `- \`${label}\` (${meta})`
    })
    sections.push({ title: 'Delivered files', lines })
  }

  return renderSectionsWithCap(sections, maxTokens)
}
