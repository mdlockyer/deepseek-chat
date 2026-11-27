# SPEC: `slices/subagents` (parallel read-only child subagents & shared board)

## Purpose

Orchestrates depth-1 read-only child subagents spawned from any `AgentProfileSpec` registered by a
capability slice (such as `slices/web-research`'s `research` profile). Owns the child agent loop,
shared message board (`post`), lead synchronization (`wait`), automatic orphan-prevention hook,
reply-wide child citation renumbering, Activity Inspector rendering, and v3 archive serialization.

## Public entrypoint

`createSubagentsSlice(deps)` returns:

| Member       | Meaning                                                                                                                                                              |
| :----------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capability` | `ToolCapability` declaring `wait` + `post` when any spawn profile is active, running spawn/wait/post, providing `turnHooks`, `presenter`, and `serializeForArchive`. |
| `dispose()`  | Aborts every live child across all active replies and clears runtime state.                                                                                          |

Pure exports: `POST_TOOL_NAME`, `WAIT_TOOL_NAME`, `AUTO_WAIT_ID_PREFIX`, `DEFAULT_SUBAGENTS_PARAMS`,
`assignChildCitations`, `createMessageBoard`, `formatBoardDigest`, `runAgent`.

## Behavioural invariants

1. **Read-only & depth 1.** Children receive only `read` tools named in their profile (never another
   `spawn` tool), `post`, and their profile's `finish` tool. `deps.toolHost` is injected eagerly as
   a non-subagent host so recursive subagent spawning is structurally impossible, and calls to any
   other tool resolve as an error without invoking the tool dispatcher.
2. **Caps & concurrency.** Enforces `maxRunningChildren`, `maxChildrenPerReply`, and per-child
   `maxParallelReadCalls`.
3. **Shared board & `wait`.** Children post `finding` or `question` up to `maxPostsPerChild` and
   `maxPostChars`; the lead posts `direction` to `'all'` or one running `runId`. `wait` wakes on a
   finished child, a child `question`, or timeout (`until: 'all'` waits until none remain).
4. **Provider-neutral transport, forced finish, & resilience.** Child loops run through the injected
   `ModelProvider` (defaulting to `profile.model ?? provider.defaultModel`), prepend
   `ctx.environmentContext` to the first standard `user` message (zero proprietary roles), and run
   one forced-finish nudge on round/tool-call limits or ending without calling `finish` (named
   `tool_choice` only when thinking is off). Network errors before content retry with exponential
   backoff.
5. **No orphans.** `turnHooks.onTurnEndWithoutToolCalls` injects an automatic `wait` (`until: 'all'`)
   whenever children remain running; `onTurnSettled` aborts children cleanly; `onReplyHydrated`
   settles any persisted `'running'` child to `'stopped' ('interrupted')`.
6. **Multi-instance isolation.** All live runtimes live inside the factory closure; zero globals.

## Facts

Consumes `SessionDeleted` and `SessionHistoryReplaced` (aborts live children for deleted/replaced
sessions). Publishes none.
