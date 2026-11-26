import { withSummaryParam } from './summary.js'
import type {
  ActivityStepEntry,
  AgentProfileSpec,
  ArchiveFragment,
  CompactionLedgerSection,
  ComposerToggleDescriptor,
  CompositionPromptNote,
  ToolCallRecord,
  ToolCapability,
  ToolCaller,
  ToolDefinition,
  ToolEffect,
  ToolProgress,
  ToolRegistry,
  ToolResultRecord,
  ToolRunContext,
  ToolRunResult,
  ToolStepPresenter,
  TurnLifecycleHooks,
} from './types.js'

const matchesAudience = (
  noteAudience: CompositionPromptNote['audience'],
  audience: ToolCaller['kind']
): boolean => !noteAudience || noteAudience === 'both' || noteAudience === audience

/**
 * Composes an ordered list of sealed `ToolCapability` objects into a single `ToolRegistry`.
 * Adding or removing a capability slice requires only editing the array passed here.
 */
export const createToolRegistry = (
  capabilities: readonly ToolCapability[],
  compositionNotes: readonly CompositionPromptNote[] = []
): ToolRegistry => {
  const byId = new Map<string, ToolCapability>()
  for (const cap of capabilities) {
    if (byId.has(cap.id)) {
      throw new Error(`Duplicate ToolCapability id: "${cap.id}"`)
    }
    byId.set(cap.id, cap)
  }

  const toggles: ComposerToggleDescriptor[] = capabilities.flatMap((cap) =>
    cap.toggle ? [cap.toggle] : []
  )

  const turnHooks: { readonly capabilityId: string; readonly hooks: TurnLifecycleHooks }[] =
    capabilities.flatMap((cap) =>
      cap.turnHooks ? [{ capabilityId: cap.id, hooks: cap.turnHooks }] : []
    )

  const ownerFor = (name: string): ToolCapability | undefined =>
    capabilities.find((cap) => cap.handles(name))

  const profileOwnerFor = (
    name: string
  ): { cap: ToolCapability; profile: AgentProfileSpec } | null => {
    for (const cap of capabilities) {
      const profile = cap.agentProfile?.(name)
      if (profile) {
        return { cap, profile }
      }
    }
    return null
  }

  const declare = (turn: {
    readonly questionText: string
    readonly enabledCapabilities: Readonly<Record<string, boolean>>
  }): ToolDefinition[] => {
    const declared: ToolDefinition[] = []
    for (const cap of capabilities) {
      const tools = cap.declareTools({
        questionText: turn.questionText,
        enabledCapabilities: turn.enabledCapabilities,
        declaredToolsSoFar: declared,
      })
      for (const tool of tools) {
        declared.push(withSummaryParam(tool))
      }
    }
    return declared
  }

  const describe = (name: string, audience: ToolCaller['kind']): ToolDefinition | null => {
    for (const cap of capabilities) {
      const explicit = cap.describe?.(name, audience)
      if (explicit) {
        return withSummaryParam(explicit)
      }
    }
    // Fallback: inspect full declaration with all capabilities enabled.
    const allEnabled: Record<string, boolean> = {}
    for (const cap of capabilities) {
      allEnabled[cap.id] = true
    }
    const found = declare({ questionText: '', enabledCapabilities: allEnabled }).find(
      (tool) => tool.name === name
    )
    return found ?? null
  }

  const capabilityIdOf = (name: string): string | null =>
    ownerFor(name)?.id ?? profileOwnerFor(name)?.cap.id ?? null

  const initialProgressOf = (name: string): ToolProgress | undefined =>
    ownerFor(name)?.initialProgress?.(name)

  const effectOf = (name: string): ToolEffect => {
    const owner = ownerFor(name)
    if (owner) {
      return owner.effectOf(name)
    }
    return profileOwnerFor(name) ? 'spawn' : 'session'
  }

  const agentProfile = (name: string): AgentProfileSpec | null =>
    profileOwnerFor(name)?.profile ?? null

  const instructions = (
    declaredNames: ReadonlySet<string>,
    audience: ToolCaller['kind']
  ): string[] => {
    const sections: string[] = []
    const activeIds = new Set<string>()
    for (const name of declaredNames) {
      const id = capabilityIdOf(name)
      if (id) {
        activeIds.add(id)
      }
    }
    for (const cap of capabilities) {
      const section = cap.instructions(declaredNames, audience)
      if (section && section.trim()) {
        sections.push(section)
      }
    }
    for (const note of compositionNotes) {
      if (
        matchesAudience(note.audience, audience) &&
        note.requires.every((id) => activeIds.has(id)) &&
        note.text.trim()
      ) {
        sections.push(note.text)
      }
    }
    return sections
  }

  const run = async (
    call: ToolCallRecord,
    ctx: ToolRunContext
  ): Promise<ToolRunResult & { readonly capabilityId?: string }> => {
    const owner = ownerFor(call.name)
    if (!owner) {
      return {
        content: `Unknown tool: ${call.name}`,
        status: 'error',
        images: [],
        durationMs: 0,
      }
    }
    const result = await owner.run(call, ctx)
    return { ...result, capabilityId: owner.id }
  }

  const presenterFor = (
    capabilityId: string | undefined,
    toolName: string
  ): ToolStepPresenter | null => {
    if (capabilityId) {
      const byExplicit = byId.get(capabilityId)?.presenter
      if (byExplicit) {
        return byExplicit
      }
    }
    return ownerFor(toolName)?.presenter ?? profileOwnerFor(toolName)?.cap.presenter ?? null
  }

  const serializeForArchive = (
    call: ToolCallRecord,
    result: ToolResultRecord | undefined
  ): readonly ArchiveFragment[] | null => {
    const owner =
      (result?.capability ? byId.get(result.capability) : undefined) ?? ownerFor(call.name)
    if (!owner?.serializeForArchive) {
      return null
    }
    return owner.serializeForArchive(call, result)
  }

  const buildCompactionLedger = (
    entriesByCapability: ReadonlyMap<string, readonly ActivityStepEntry[]>,
    statesByCapability: ReadonlyMap<string, readonly unknown[]>
  ): CompactionLedgerSection[] => {
    const sections: CompactionLedgerSection[] = []
    for (const cap of capabilities) {
      if (!cap.buildCompactionLedger) {
        continue
      }
      const entries = entriesByCapability.get(cap.id) ?? []
      const states = statesByCapability.get(cap.id) ?? []
      if (entries.length === 0 && states.length === 0) {
        continue
      }
      const section = cap.buildCompactionLedger(entries, states)
      if (section && section.lines.length > 0) {
        sections.push(section)
      }
    }
    return sections
  }

  return {
    capabilities,
    toggles,
    snapshotEnabled: () => {
      const out: Record<string, boolean> = {}
      for (const toggle of toggles) {
        out[toggle.id] = toggle.isEnabled()
      }
      return out
    },
    declare,
    instructions,
    describe,
    capabilityIdOf,
    initialProgressOf,
    effectOf,
    agentProfile,
    run,
    presenterFor,
    serializeForArchive,
    buildCompactionLedger,
    turnHooks,
  }
}
