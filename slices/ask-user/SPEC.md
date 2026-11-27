# SPEC: `slices/ask-user` (structured clarifying questions tool)

## Purpose

Provides the `ask_user` interactive client tool: lets the model ask 1 to 4 concise structured
clarifying questions in a compact card docked above the composer, waits for the user's selection,
custom answer, skip, or abort, and renders both the Front Stage decision note and the Activity
Inspector card.

## Public entrypoint

`createAskUserSlice({ log })` returns:

| Member                                           | Meaning                                                                            |
| :----------------------------------------------- | :--------------------------------------------------------------------------------- |
| `toolName`, `tool`, `instructions`               | The `ask_user` tool schema and human-voiced prompt instructions.                   |
| `capability`                                     | Sealed `ToolCapability` (interactive effect, presenter, archive serializer).       |
| `ComposerDock({ sessionId, onStopReply })`       | Docked card rendered in place of the composer when a session has a pending prompt. |
| `useHasPending(sessionId)`                       | React hook indicating whether `sessionId` currently waits on user input.           |
| `submit(sessionId, answers)` / `skip(sessionId)` | Resolves a session's active prompt (UI and programmatic tests).                    |
| `run(input, { sessionId, signal })`              | Runs one `ask_user` invocation; always resolves.                                   |
| `dispose()`                                      | Aborts any pending prompts and unsubscribes all Spine `EventLog` listeners.        |

Pure exports: `ASK_USER_TOOL_NAME`.

## Behavioural invariants

1. **Input validation.** Requires 1 to 4 question objects, each with a non-empty `question`.
   Extra questions beyond 4 and extra options beyond 4 are ignored; duplicate IDs are disambiguated.
   Invalid input resolves immediately with `status: 'error'`.
2. **Interactive lifecycle.** Running `ask_user` stores a pending prompt for `sessionId` and waits
   until `submit`, `skip`, `signal` abort, `SessionDeleted` for that session, `SessionHistoryReplaced`,
   or `dispose()`. Clearing removes the pending entry cleanly without affecting other sessions.
3. **Structured output.** Submitting returns `{ status: 'answered', answers }` in `content`, plus
   `frontStageNote` and `payload` (`AskActionMeta`) for Front Stage and Activity rendering. Skipping
   returns `{ status: 'skipped', note }` with `status: 'ok'`.
4. **Multi-instance isolation.** All state lives inside the factory closure; two slice instances
   never share pending prompts.

## Facts

Consumes `SessionDeleted` and `SessionHistoryReplaced`. Publishes none.
