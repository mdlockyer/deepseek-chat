# Adding a Python REPL tool to chat-demo

Investigation date: 2026-11-15. Sources: chat-demo at `5d5dd75`, Unharnessed at `fe2cf28`, the DeepSeek Messages API reference (https://api-docs.deepseek.com/zh-cn/api/create-message), and the Pyodide docs (stable 314.0.7).

## Summary

The tool is feasible. Running Python is the smaller part of the work; changing how replies are stored and sent is the larger part.

chat-demo has no backend, so the REPL cannot be a host CPython process the way it is in Unharnessed. It can be Pyodide (CPython compiled to WebAssembly) running in a Web Worker. Pyodide already gives the two properties that define the Unharnessed tool: one persistent `__main__` namespace across calls, and top-level `await`.

chat-demo currently treats a client `tool_use` block as something to discard: `parseEvent.ts` drops `input_json_delta`, `reply.ts` drops the `tool_use` block, and `store.ts` makes one request per reply. A tool loop needs a reply to span several API requests, needs the stored reply format to carry tool calls and their results, and needs `toRequestMessages` to expand those back into alternating `assistant`/`user` messages. Every later turn of the conversation goes through that path, so it needs the most care and the most tests.

The DeepSeek API supports what the loop needs. Client tools are declared without a `type` field (a `type` makes the server parse the entry as a server tool, and `custom` returns `422`). `tool_use`, `tool_result`, `input_json_delta` and `tool_choice` are all supported, and the reference does not restrict client tools when `deepseek_web_search`, `deepseek_read_url` or `safety_check` are present. I have not confirmed that combination against the live API; that is the first thing to test.

## How Unharnessed's `ipython` tool works

Unharnessed gives the model one tool, `ipython`, with this schema and description (`crates/uh-core/src/tools/ipython.rs`):

```json
{
  "name": "ipython",
  "description": "Run Python code in the persistent REPL.",
  "input_schema": {
    "type": "object",
    "required": ["code"],
    "properties": { "code": { "type": "string", "description": "Python code to run." } }
  }
}
```

The Rust host runs calls one at a time (`ExecutionMode::Sequential`) against a CPython 3.11+ child process. The child speaks newline-delimited JSON (`unharnessed-runtime/src/rlm/repl.md`, protocol version 3). The parts that matter for a port:

| Unharnessed behaviour                                                                                   | Where                           | Portable to the browser?                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| One persistent `__main__` namespace, one asyncio loop, top-level `await` (`PyCF_ALLOW_TOP_LEVEL_AWAIT`) | `rlm/repl.py`                   | Yes. Pyodide `runPythonAsync` with a kept `globals` dict does this.                                                              |
| Result text = stdout, then stderr, then `repr` of the trailing expression, then the traceback on error  | `format_execute_text`           | Yes, port directly.                                                                                                              |
| `repr` and traceback entries capped at 1,048,576 characters with a truncation marker                    | `repl.md`                       | Yes. A much lower cap suits a chat context; see below.                                                                           |
| `emit({mime: payload})` display events; image MIME types become image blocks in the tool result         | `image_blocks_from_attachments` | Yes. The DeepSeek `tool_result` accepts text and image blocks.                                                                   |
| Real interrupts: `KeyboardInterrupt` lands in the running cell                                          | `repl.md` "Interrupt"           | Only with `SharedArrayBuffer`, which needs cross-origin isolation. Otherwise the only stop is killing the worker.                |
| Kernel restart notice (`<ipython_kernel_reset>`) prepended when the kernel was killed                   | `kernel_restart_notice`         | Yes, and it will fire more often here because killing the worker is the fallback interrupt.                                      |
| `bash()` returning a `BashHandle`, MCP inside the kernel, `uv pip install`                              | `rlm/bash.py`, `rlm/mcp.py`     | No. There is no shell in a browser. `micropip` replaces package installs for pure-Python wheels and Pyodide's prebuilt packages. |
| Snapshot/restore of the namespace with `dill` across sessions and compaction                            | `repl.md` "Snapshot / restore"  | Possible later (pickle to bytes, store in IndexedDB), not needed for a first version.                                            |
| No sandbox: model code runs with the user's permissions                                                 | README warning                  | Inverted. The browser is the sandbox, which is the main safety gain of this design.                                              |

Unharnessed's static system prompt is short and mostly about `bash()`. The rules worth keeping for chat-demo are: batch steps that do not need an unseen result into one call, store results in variables instead of recomputing, and stop calling the tool when done and give the final answer.

## Where to run Python

**Option A: Pyodide in a Web Worker (recommended).** This fits the app's design: static files, no backend, works from GitHub Pages. Costs and limits:

- First use downloads the Pyodide runtime, several MB before any package. Load it lazily on the first tool call, not at page load, and show a "starting Python" state the way Unharnessed reports startup progress.
- `file://` use is the weak point. The README says that `dist/index.html` works when double-clicked. Chrome refuses `new Worker('file://…')`; a Blob-URL worker that loads Pyodide from a CDN is the likely workaround, but I have not tested it on `file://`. If it fails, the tool should be hidden on `file://` with a note, not break the app.
- Interrupts need `SharedArrayBuffer` plus `pyodide.setInterruptBuffer`, which needs `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers. GitHub Pages cannot set these, and `file://` has none. Without them, "Stop" must terminate the worker and lose all variables. Pyodide issue #6082 also reports that interrupts do not reach code blocked in `time.sleep` or `requests` even with the buffer.
- Network from Python goes through `fetch` and is subject to CORS, so most sites will refuse. That limit is acceptable for a REPL whose main use is computation and data handling.

**Option B: an optional local kernel bridge.** A small local process (for example Unharnessed's `rlm.repl` behind a localhost WebSocket) would give a real CPython with a filesystem and shell. It breaks the "no application backend" promise and brings back Unharnessed's no-sandbox risk, so it fits only as an opt-in advanced setting after option A works.

**Option C: server-side execution.** The DeepSeek API reference lists no code-execution server tool, so this is not available.

### Isolation inside the browser

A worker runs on the page's origin. Pyodide's `js` module gives model-written code the worker's global scope, which includes `indexedDB` for the same origin. That database holds every conversation and attachment. The API key is safer because workers have no `localStorage`, but code could still `postMessage` or `fetch` data out.

To close this, host the worker inside an `<iframe sandbox="allow-scripts">` without `allow-same-origin`. The iframe then gets an opaque origin, has no access to the app's IndexedDB, and talks to the app only through `postMessage`. Whether a worker can start inside an opaque-origin iframe on every target browser (`chrome >= 105`, `safari >= 16`, `firefox >= 110` per `rspack.config.ts`) needs a spike.

## Changes in chat-demo

### API types and stream parsing

- `src/services/api/types.ts`: add a client tool type `{ name, description, input_schema }` with no `type` field, and widen `CreateMessageRequest['tools']` to accept it. Add `ToolUseBlockParam` to `AssistantBlockParam`, and a `ToolResultBlockParam` (`{ type: 'tool_result', tool_use_id, content }`) to the `user` message content. The reference says `tool_result` blocks must come before any text or image blocks in that message, one result per pending call, and that `is_error` is ignored, so error details go in `content`.
- `src/services/api/parseEvent.ts`: `readDelta` returns `null` for `input_json_delta`, so the streamed tool input is lost today. Accept it.

### Reply model and history

- `src/services/chat/types.ts`: add reply blocks for a tool call (id, name, accumulated input JSON, parsed `code`) and a tool result (stdout, stderr, result, error, images, duration, a status of `running`/`ok`/`error`/`aborted`, and whether the kernel was restarted). Keep the result's local display data separate from the text sent to the model, as Unharnessed separates `details` from `content`.
- `src/services/chat/reply.ts`:
  - `applyEvent` / `toReplyBlock` currently drop `tool_use` and set `prefix: false`. Store the block instead and append `input_json_delta` to it.
  - `toAssistantParam` returns one `assistant` message per reply. A reply with tool rounds must become `assistant(…, tool_use)`, `user(tool_result)`, `assistant(…)`, and so on. `toRequestMessages` and `getContextRounds` assume one user/assistant pair per round and need to emit that expanded sequence.
  - Thinking: the code drops historical thinking blocks except when continuing a reply. The DeepSeek reference says that during a tool loop in thinking mode the full assistant content, including thinking blocks, must be sent back, and that the server returns `400` when it needs thinking it cannot recover. Within a tool loop, thinking blocks must therefore be kept.
  - `canContinueReply` rejects any reply with `stopReason === 'tool_use'`. Decide what "continue" means for a reply that stopped mid-loop (probably: re-run the loop from the last unanswered call).
- `src/services/chat/store.ts` `streamReply`: turn the single request into a loop. When a response ends with `stop_reason: 'tool_use'`, run each call in order, append the results, and send the next request. Add an iteration cap so a model that keeps calling the tool cannot run forever. The file-reupload retry treats "received a content block" as not retryable; that check has to apply per request inside the loop. "Stop" must also interrupt or kill the kernel.

### Kernel lifetime

Unharnessed keeps one kernel per session. Here the choice is one worker per conversation, which uses more memory, or one shared worker that is reset when the user switches conversations, which loses state. A first version can keep one kernel for the active conversation and tell the model through the restart notice when its variables are gone. Variables do not survive a page reload in either case unless snapshotting is added.

### Settings, UI and copy

- A Settings toggle for the Python tool, off by default, because it adds download cost and changes model behaviour. Declare the tool only when it is on.
- `ReplyArea.tsx` already renders server tool steps (search, open page, find). Add a step for a Python cell: the code (with Prism, which is already a dependency), streamed output, the trailing result, images, and the traceback on error, collapsed by default.
- `SYSTEM_PROMPT` is one Chinese sentence today. Add a short tool section adapted from Unharnessed's rules, without the `bash()` material, plus the list of preinstalled Pyodide packages.
- `src/i18n/en.ts` and `zh.ts` need the new strings.

### History import and export

The archive format (`src/services/chat/history/`) maps to a fragment format (`REQUEST`, `FILE`, `TOOL_OPEN`, …) that has no slot for a code cell. Either export Python cells as text (code and output in a fenced block) or leave them out. Decide this before release, because import after export must not produce a history that the request builder rejects.

## Suggested order

1. Spike, about a day: a Blob-URL worker loading Pyodide from a CDN, run inside a sandboxed iframe, tested on `https://`, `localhost` and `file://` in Chrome, Safari and Firefox. Separately, send one hand-built request to the DeepSeek API with the `ipython` client tool plus `deepseek_read_url` and `safety_check: { level: 'high' }`, with thinking on, and complete one tool round. Either result can change the plan.
2. Protocol and storage: types, stream parsing, reply blocks, request expansion, the loop in `streamReply`. This needs unit tests for `toRequestMessages` with tool rounds, thinking on and off, and continuation.
3. Kernel module: worker, iframe host, execute/interrupt/restart, output formatting ported from `format_execute_text`, an output cap, image capture from matplotlib.
4. UI, settings, prompt, i18n.
5. History export handling.

## Open decisions

- Output cap: Unharnessed caps `repr` at 1 MiB because its context is managed by compaction. chat-demo has no compaction, so every tool result stays in every later request of the conversation. A cap around 20–50 KB of text per call, with a truncation marker, is more realistic. This needs a number.
- Whether to hide the tool on `file://` or try to make it work there.
- Whether option B (local kernel bridge) is in scope at all.
