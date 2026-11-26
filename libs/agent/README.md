# `@deepseek-chat/lib-agent`

Domain-free, provider-neutral protocol primitives for the standard Messages API: canonical wire
types, `ModelProvider` + `ModelSpec` capability contracts, the DeepSeek provider adapter, SSE
decoding, event parsing, error classification, stateless HTTP helpers, and the pure stream-event
reducer. It holds no agent loop, concurrency control, timers beyond per-request HTTP timeouts,
storage, or UI — each slice builds its own runtime loop on top of these parts.

## API

| Export                                                              | Meaning                                                                                                                                  |
| :------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `ModelProvider`, `ProviderAttachmentPort`                           | Provider-neutral streaming message transport + optional remote file upload capability.                                                   |
| `ModelSpec`, `ModelCapabilities`, `ModelId`, `ProviderId`           | Explicit model metadata (context window, max output tokens, capabilities) and widened string model/provider identifiers.                 |
| `createDeepSeekProvider(config)`                                    | DeepSeek adapter implementing `ModelProvider` over `/anthropic/v1/messages` + `/anthropic/v1/files` (isolating DeepSeek quirks).         |
| `DEEPSEEK_MODELS`, `DEFAULT_DEEPSEEK_MODEL`, `resolveModelSpec`     | Built-in DeepSeek model specs (`deepseek-flash`, `deepseek-v4-pro`) and safe fallback lookup for custom model IDs.                       |
| `request(fetch, url, init, timeoutMs?)`                             | Low-level HTTP helper with optional timeout and external abort pass-through.                                                             |
| `readMessagesEventStream(res, signal?)`                             | Validates `text/event-stream` response and yields parsed `MessageStreamEvent`s.                                                          |
| `ApiError`, `ApiErrorKind`, `ApiErrorCondition`                     | Structured failure (`http`, `stream`, `network`, `interrupted`, `protocol`) and normalized error conditions incl. `contextOverflow`.     |
| `classifyStatus`, `classifyApiError`, `isRetryableApiError`         | Provider-neutral classifiers (`unauthorized`, `insufficientBalance`, `contextOverflow`, `payloadTooLarge`, `rateLimited`, `serverBusy`). |
| `ServerSentEventDecoder`, `readServerSentEvents`                    | WHATWG-compliant SSE byte-stream decoder.                                                                                                |
| `readMessageEvent`                                                  | Validates and normalizes parsed SSE JSON payloads into canonical `MessageStreamEvent \| null` (handling partial usage deltas).           |
| `Transcript`, `Block`, `emptyTranscript()`, `applyEvent(t, e, now)` | Pure stream-event reducer that folds `MessageStreamEvent`s into a `Transcript` (merging partial `message_delta.usage`).                  |

## Guarantees

1. **Chunk-boundary invariance.** Splitting the same SSE byte stream at any byte boundaries yields
   the exact same sequence of events and the exact same reduced `Transcript`.
2. **Standard Messages wire contract.** Canonical requests emit only standard `user` / `assistant`
   roles, `text` / `thinking` / `image` / `document` / `tool_use` / `tool_result` blocks (supporting
   both remote `file` and inline `base64` sources), and zero DeepSeek-proprietary wire extensions
   (`latest_reminder`, `title`, `safety_check`, server-side web tools). Provider-specific transport
   quirks live exclusively inside provider adapters such as `createDeepSeekProvider`.
3. **Typed protocol errors.** Non-2xx responses become `ApiError('http', …)`; oversized requests or
   non-`text/event-stream` responses become `ApiError('protocol', …)`; SSE error frames become
   `ApiError('stream', …)`; streams ending before `message_stop` become `ApiError('interrupted', '')`;
   timeouts become `ApiError('network', …)` with `timedOut: true`, while caller aborts propagate
   unchanged.
4. **Pure reduction.** `applyEvent` never mutates its input `Transcript`, blocks, or index map.
   Malformed `tool_use` JSON is preserved in `inputJson` rather than throwing.
5. **No runtime loop.** This library never executes tools, schedules retries, or manages agent
   lifecycles.
