# Architecture: Sealed Slice Architecture (SSA) — Profile 1 (TypeScript, React + Tauri client)

Tiers, top to bottom: `app/` → `slices/*` → `libs/*` → `spine/`. `src-tauri/` is the native host
(a bridge to the OS, not a slice); the app adapts it into ports.

## Commands

- Test one slice: `node --import ./scripts/test-loader.mjs --test 'slices/<target>/tests/**/*.test.ts'`
- Test one library: `node --import ./scripts/test-loader.mjs --test 'libs/<target>/tests/**/*.test.ts'`
- Test `libs/agent`: `node --import ./scripts/test-loader.mjs --test 'libs/agent/tests/**/*.test.ts'`
- Test the spine: `node --import ./scripts/test-loader.mjs --test 'spine/tests/**/*.test.ts'`
- Test app wiring: `node --import ./scripts/test-loader.mjs --test 'app/tests/**/*.test.ts'`
- Verify the DAG and slice anatomy: `pnpm check:dag`
- Full gate before every commit:
  `pnpm -s type && pnpm -s test && pnpm -s lint && pnpm -s check:dag && pnpm -s format:check && pnpm -s build`
- Format: `pnpm -s oxfmt --write <paths>` (no semicolons, single quotes, width 100).

## Authoring Rules

- **Code isolation is not feature isolation.** No slice imports another slice, but features still
  collaborate: through spine facts on the event log (`spine/runtime`), ports and view slots the app
  injects, and the conversations `ToolGateway` the app adapts (`app/toolGateway.ts`). Wiring that
  connects slices is routine app work, not a product trade-off.
- **Working set.** Scope a slice task to `spine/` + `slices/<target>/` (`SPEC.md`, `src/`,
  `tests/`). Touch `app/` only for composition, port adapters, view placement and the window
  layout (right-hand panel, settings dialog frame). Domain rules stay in the owning slice.
- **Spine discipline.** `spine/runtime`, `spine/ports` and `spine/design` stay domain-blind;
  `spine/design` holds stateless UI primitives, the translation mechanism and the locale, never
  strings of a feature. Facts in `spine/facts/` are named and shaped in the producer's domain, and
  added only when a built slice or the app consumes them. Prefer a small local helper over growing
  the spine.
- **Libraries** (`libs/*`) are domain-free code shared by slices (e.g. Markdown rendering). They
  import only themselves, the spine's domain-blind parts and external packages; callers pass in
  anything domain-shaped (citations, scroll, theme).
- **Ownership.** Each slice owns its storage keys (keep existing `chat-demo:*` keys exactly), its
  UI strings (its own catalogue via `defineMessages`), its settings rows and its views. A slice
  that renders into the right-hand panel gets a `PanelSlot` for its own panel kind only.
- **conversations is one instance per app** (module-level store and IndexedDB connection); its
  factory throws on a second call. Its tests create it once per test file.
- **State, specs and errors.** `SPEC.md` separates behavioural invariants from tunable
  parameters. Model lifecycles as discriminated unions, not boolean flags; keep stateless
  transforms pure. Never mask invariant failures with broad catches or silent fallbacks.
- **App tier cycles.** Lint enforces `import/no-cycle` (dynamic imports count). Break app wiring
  cycles with `app/lateBindings.ts` or lazy factories, not dynamic imports.
- **Harness prompting.** System prompt sections, tool descriptions, and `latest_reminder` follow
  the unified human-voiced prompting architecture documented in `docs/prompting-harness.md`.
  Whenever you add/change tools, UI surfaces, or sandbox/security boundaries, update the matching
  prompt layer in the same commit and keep `system` static for KV-cache reuse.
- **Verification.** Test only sealed boundaries in `slices/<target>/tests/` (the package
  entrypoint, an in-memory `EventLog`, fake ports, `fake-indexeddb` where storage is IndexedDB) and
  wiring in `app/tests/`, with zero internal mocks; tests import a slice by its package name, never
  `../src`. Derive assertions and randomized invariants (reference models, round trips) from
  `SPEC.md` and the entrypoint types, never by mirroring `src/`. Don't pin tunable parameters.
  Show each new test can fail (break the code on purpose, see it go red, restore). If `SPEC.md`
  conflicts with the spine or the tests, stop and surface it; never weaken assertions.
