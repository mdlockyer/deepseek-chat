# `@deepseek-chat/lib-agent`

Domain-free protocol primitives for DeepSeek's Anthropic-compatible Messages API: wire types, SSE
decoding, event parsing, error classification, stateless HTTP/streaming helpers, and the pure
stream-event reducer. It holds no agent loop, concurrency control, timers beyond per-request HTTP
timeouts, storage, or UI — each slice builds its own runtime loop on top of these parts.

## API

| Export                                                              | Meaning                                                                                   |
| :------------------------------------------------------------------ | :---------------------------------------------------------------------------------------- |
| `AgentIO`                                                           | Stateless transport ports (`{ fetch, apiOrigin, apiKey }`).                               |
| `streamMessage(io, body, signal)`                                   | `POST /anthropic/v1/messages` with `stream: true`; yields validated `MessageStreamEvent`. |
| `request(fetch, url, init, timeoutMs?)`                             | Low-level HTTP helper with optional timeout and external abort pass-through.              |
| `uploadFile(io, file, purpose, signal?)`                            | `POST /anthropic/v1/files` (60 s timeout).                                                |
| `deleteFile(io, fileId)`                                            | `DELETE /anthropic/v1/files/{id}` (15 s timeout).                                         |
| `ApiError`, `ApiErrorKind`                                          | Structured failure (`http`, `stream`, `network`, `interrupted`, `protocol`).              |
| `classifyStatus`, `classifyApiError`, `isRetryableApiError`         | Condition classifiers for callers to render domain-specific copy or retry policy.         |
| `getFileErrorCode`, `extractFileIds`, `getUploadErrorInfo`          | Classifiers for Files API 400 error bodies.                                               |
| `ServerSentEventDecoder`, `readServerSentEvents`                    | WHATWG-compliant SSE byte-stream decoder.                                                 |
| `readMessageEvent`                                                  | Validates and normalizes parsed SSE JSON payloads into `MessageStreamEvent \| null`.      |
| `Transcript`, `Block`, `emptyTranscript()`, `applyEvent(t, e, now)` | Pure stream-event reducer that folds `MessageStreamEvent`s into a `Transcript`.           |

## Guarantees

1. **Chunk-boundary invariance.** Splitting the same SSE byte stream at any byte boundaries yields
   the exact same sequence of events and the exact same reduced `Transcript`.
2. **Typed protocol errors.** Non-2xx responses become `ApiError('http', …)`; request bodies over
   3,000,000 bytes or non-`text/event-stream` responses become `ApiError('protocol', …)`; SSE error
   frames or JSON `{ error }` frames become `ApiError('stream', …)`; streams ending before
   `message_stop` become `ApiError('interrupted', '')`; timeouts become `ApiError('network', …)`
   with `timedOut: true`, while caller aborts propagate unchanged.
3. **Pure reduction.** `applyEvent` never mutates its input `Transcript`, blocks, or index map.
   Malformed `tool_use` JSON is preserved in `inputJson` rather than throwing.
4. **No runtime loop.** This library never executes tools, schedules retries, or manages agent
   lifecycles.
