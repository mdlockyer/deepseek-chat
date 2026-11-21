# SPEC: `slices/python` (Python code execution)

## Purpose

Runs model-written Python in one persistent kernel and turns each run into a tool result the
conversation can hand back to the model. Two engines, chosen at init:

- **Native** (desktop): a sandboxed CPython process owned by the Rust host, reached through the
  injected `NativePythonHost`. Interrupt keeps variables.
- **Web**: Pyodide in a module Web Worker owned by this slice. Interrupt or timeout terminates the
  worker, so variables are lost.

## Public entrypoint

`createPythonSlice(deps)` returns:

| Member                                                  | Meaning                                                                              |
| :------------------------------------------------------ | :----------------------------------------------------------------------------------- |
| `toolName`, `tool`                                      | Model-visible tool definition; wording depends on the engine.                        |
| `run(code, { signal, sessionId?, uploads?, onPhase? })` | Run code; always resolves to a `PythonRunResult`, never rejects.                     |
| `runtime`                                               | Native only (`null` on web): `status()` and `reset()` of the managed Python install. |
| `RuntimeSetting`                                        | Settings row: runtime status and reset (native); renders nothing on web.             |
| `dispose()`                                             | Unsubscribe from the Spine.                                                          |

## Behavioural invariants

1. **One kernel, serialized.** Runs execute one at a time in call order. A run aborted while still
   queued resolves `aborted` without reaching the engine.
2. **Abort before start.** A run whose signal is already aborted resolves `aborted` with
   `durationMs: 0` and never reaches the engine.
3. **Session ownership.** The kernel belongs to the session of the last run.
   - Web: a run from a different session first restarts the kernel silently (no notice; the new
     session never had state).
   - Native: the host scopes state by `sessionId`; switching only forgets which uploads were staged
     and drops any pending restart notice.
4. **Restart notice, exactly once.** When the kernel restarts underneath a session (user abort on
   web, timeout, crash, native `restarted`), the next result for that session starts with the
   `<python_kernel_reset>` notice. It is not repeated on later results.
5. **Uploads staged once (native).** Each `(sessionId, uploadId)` is copied into the sandbox's
   read-only `uploads/` at most once per kernel lifetime. A kernel reset forgets staged uploads.
6. **Output to the model.** Text is stdout, then the trailing-expression repr, then the error, with
   `(no output)` when all are empty. Text longer than `outputLimit` is cut and ends with
   `[output truncated: N more characters]`. Image and presented-file notes follow the text.
7. **Presented files** arrive as bytes (`Uint8Array`) with name and MIME type.
8. **Lifecycle facts.** On `SessionDeleted` for the owning session, or on `SessionHistoryReplaced`,
   the kernel resets silently (no notice; the owner is gone).
9. **Runtime reset (native).** `runtime.reset()` reinstalls the managed runtime and then resets the
   kernel silently.

## Facts

- **Consumes:** `SessionDeleted`, `SessionHistoryReplaced` (`spine/facts/session`).
- **Publishes:** none.

## Tunable parameters

| Parameter          | Default  | Meaning                                                     |
| :----------------- | :------- | :---------------------------------------------------------- |
| `runTimeoutMs`     | `120000` | Max time for one run once it is executing.                  |
| `startupTimeoutMs` | `180000` | Web: max time to boot Pyodide and load packages.            |
| `outputLimit`      | `30000`  | Characters of text returned to the model before truncation. |

Image (6 per run) and presented-file (10 × 50 MB) caps are enforced by the engines
(`src/worker.ts`, `src-tauri/src/python*.rs`).

## Known gaps (carried over, not yet fixed)

- A native upload that fails to stage is skipped silently; the model is not told the file is
  missing from `uploads/`.
- Native `reset()` and `interrupt()` are fire-and-forget; their failures are not reported.
