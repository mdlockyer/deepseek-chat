# SPEC: `libs/chat-archive-contract` (Tier-`1c` persisted chat archive contract)

## Purpose

Opt-in CSA Tier-`1c` contract library holding only the persisted chat session/message record schema
and `ChatArchiveSessionsPort` shared between `slices/conversations` and `slices/history-backup`.
Carries zero runtime logic, zero UI, and zero sibling-slice behavior.

## Consumer scope

Mechanically allowlisted in `scripts/check-dag.mjs` strictly to:

- `slices/conversations` (extends the persisted records with optional runtime/compaction fields)
- `slices/history-backup` (exports/imports v3 ZIP archives against `ChatArchiveSessionsPort`)
- `app` (if needed for declaration emit when wiring the port)

No other slice may depend on this package.

## Behavioural invariants

1. **Pure contract only.** Exports only TypeScript types (`ArchiveSession`, `ArchiveMessage`,
   `ArchiveAssistantMessage`, `ArchiveUserMessage`, `ArchiveReplyBlock`, `ArchiveFileAttachment`,
   `ChatArchiveSessionsPort`, and their component types) with zero runtime side effects.
2. **Bidirectional zero-cast compatibility.** Every field added by `slices/conversations` beyond
   `ArchiveSession` / `ArchiveAssistantMessage` / `ArchiveToolResultPart` is optional, so
   conversations and history-backup wire together in `app/runtime.ts` with zero type assertions.
