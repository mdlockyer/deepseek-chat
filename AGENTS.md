# Architecture: Sealed Slice Architecture (SSA) — Profile 1 (TypeScript, React + Tauri client)

Tiers, top to bottom: `app/` → `slices/*` → `libs/*` → `spine/`. `src-tauri/` is the native host
(a bridge to the OS, not a slice); the app adapts it into ports. See
[`docs/ssa-architecture.md`](docs/ssa-architecture.md) for the full 12-slice map, capability
contracts, and live SSA proofs.

## Commands

- Test one slice: `node --import ./scripts/test-loader.mjs --test 'slices/<target>/tests/**/*.test.ts'`
- Test one library: `node --import ./scripts/test-loader.mjs --test 'libs/<target>/tests/**/*.test.ts'`
- Test the spine: `node --import ./scripts/test-loader.mjs --test 'spine/tests/**/*.test.ts'`
- Test app wiring & SSA proofs: `node --import ./scripts/test-loader.mjs --test 'app/tests/**/*.test.ts'`
- Verify the DAG, anatomy, and SSA rules S1–S5: `pnpm check:dag`
- Verify design tokens, contrast, and boundaries: `pnpm check:design`
- Live SSA Demo (dev-only workbench): `pnpm dev:ssa`
- Full gate before every commit:
  `pnpm -s type && pnpm -s test && pnpm -s lint && pnpm -s check:dag && pnpm -s check:design && pnpm -s format:check && pnpm -s build`
- Format: `pnpm -s oxfmt --write <paths>` (no semicolons, single quotes, width 100).

## Authoring Rules

- **Code isolation is not feature isolation.** No slice imports another slice, but features still
  collaborate through three open mechanisms: Spine facts on the `EventLog` (`spine/runtime`), the
  open `ToolCapability` / `ToolRegistry` contract (`libs/tools`), and domain-blind ports/view slots
  composed in the factory root (`app/runtime.ts`).
- **Working set.** Scope a slice task to `spine/` + `slices/<target>/` (`SPEC.md`, `src/`,
  `tests/`). Touch `app/` only for factory composition, port adapters, view placement, and the
  window shell (right-hand panel, settings dialog frame). Domain rules stay in the owning slice.
- **Spine discipline.** `spine/runtime`, `spine/ports` and `spine/design` stay domain-blind;
  `spine/design` holds CSS semantic tokens (`tokens.css`), the root theme contract (`theme.ts`),
  and the translation mechanism/locale (`i18n.ts`), never React UI components or feature strings.
  Facts in `spine/facts/` are named and shaped in the producer's domain, and added only when a
  built slice or the app consumes them. Prefer a small local helper over growing the spine.
- **Libraries** (`libs/*`) are domain-free code shared by slices (`libs/ui` component kit,
  `libs/stage` viewport stage, `libs/markdown` renderer, `libs/agent` streaming, `libs/tools`
  open capability registry). They import only themselves, the spine's domain-blind parts,
  `@deepseek-chat/lib-ui` (for non-UI libraries), and external packages; callers pass in anything
  domain-shaped.
- **Factory-scoped multi-instance slices (Rules S1 & S2).** Every slice (including `conversations`)
  is factory-scoped with zero module-level Zustand stores or module-level IndexedDB handles, supports
  multiple independent instances in the same process, and returns a `dispose()` method that tears
  down subscriptions, timers, streams, and owned DB connections.
- **Ownership (Rules S4 & S5).** Each slice owns its `chat-demo:*` storage keys, UI strings
  (`defineMessages`), settings rows, composer/header toggles, and views. `slices/conversations`
  stays domain-blind to every sibling tool slice. Production `app/` never renders `SettingRow`
  directly and owns only the app-shell panel width key (`chat-demo:browser-panel-width`).
- **No `lateBindings` or app cycles (Rule S3).** Lint enforces `import/no-cycle` (dynamic imports
  count). Wire slices inside `createAppRuntime` (`app/runtime.ts`) using local factory closures
  rather than module-level mutable bindings or dynamic imports.
- **State, specs and errors.** `SPEC.md` separates behavioural invariants from tunable
  parameters. Model lifecycles as discriminated unions, not boolean flags; keep stateless
  transforms pure. Never mask invariant failures with broad catches or silent fallbacks.
- **UI copy & row discipline (no middot `·` separators).** Never use `·` to join items in a row.
  A middot usually masks information that does not belong there, a missing visual hierarchy, or
  fragments that should read as one natural sentence. Drop low-value telemetry, write one coherent
  phrase, or give distinct facts distinct layout/visual structure.
- **Harness prompting.** System prompt sections, tool descriptions, `COMPOSITION_PROMPT_NOTES`, and
  `latest_reminder` follow the unified human-voiced prompting architecture documented in
  `docs/prompting-harness.md`. Whenever you add/change tools, UI surfaces, or sandbox/security
  boundaries, update the matching prompt layer in the same commit and keep `system` static for
  KV-cache reuse.
- **Verification.** Test only sealed boundaries in `slices/<target>/tests/` (the package
  entrypoint, an in-memory `EventLog`, fake ports, `fake-indexeddb` where storage is IndexedDB) and
  wiring/SSA proofs in `app/tests/`, with zero internal mocks; tests import a slice by its package
  name, never `../src`. Derive assertions and randomized invariants (reference models, round trips)
  from `SPEC.md` and the entrypoint types, never by mirroring `src/`. Don't pin tunable parameters.
  Show each new test can fail (break the code on purpose, see it go red, restore). If `SPEC.md`
  conflicts with the spine or the tests, stop and surface it; never weaken assertions.
