# SPEC: `libs/tools` (domain-free client-tool capability contract)

## Purpose

Defines the domain-blind contract that lets feature slices contribute client tools, composer
toggles, subagent profiles, activity-inspector presenters, archive serializers, and turn-lifecycle
hooks to the application without coupling slices to one another or requiring a switchboard in
`app/`.

## Guarantees

1. **Domain-blindness.** Contains zero product or slice nouns (no references to Python, Firecrawl,
   browsers, workspace files, or chat storage).
2. **Deterministic `summary` injection.** `withSummaryParam(tool)` prepends a required `summary`
   string parameter as the first key in `input_schema.properties` without mutating the input schema
   and preserves an existing `summary` field unchanged.
3. **Composable `createToolRegistry`.** Aggregates any list of `ToolCapability` objects in
   registration order, routes calls by `handles(name)` (with `agentProfile` fallback for spawned
   profiles), resolves `effectOf`, `presenterFor`, `serializeForArchive`, `turnHooks`, and appends
   static `CompositionPromptNote` entries only when all required capability IDs are active in the
   current turn.
4. **Graceful unknown handling.** Calling `run` for an unknown tool always resolves with
   `status: 'error'` and never throws; `effectOf` defaults to `'session'`.
5. **Domain-blind presentation & deep-linking.** `ToolStepSummary` may attach an optional
   `icon?: ReactNode` so transcript views render capability-supplied icons without knowing any
   sibling slice's tools. `ActivityStepRenderProps` may carry optional `focusedCallId?: string | null`
   and `focusNonce?: number` so presenters can auto-expand an explicitly targeted call while
   keeping all other items collapsed by default.
