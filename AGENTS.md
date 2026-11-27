# Architecture: Clean-Slate Architecture (CSA) — TypeScript, React + Tauri

Tiers, top to bottom: `app/` → `slices/*` → `libs/*` (including Tier-`1c` opt-in contracts) →
`spine/`. `src-tauri/` is the native OS host adapted into ports in `app/`. See
[`docs/ssa-architecture.md`](docs/ssa-architecture.md) for the full 11-slice Human Engineering
Standard, capability contracts, and CI gate matrix.

## Commands

- Test one slice: `node --import ./scripts/test-loader.mjs --test 'slices/<target>/tests/**/*.test.ts'`
- Test one library: `node --import ./scripts/test-loader.mjs --test 'libs/<target>/tests/**/*.test.ts'`
- Test the spine: `node --import ./scripts/test-loader.mjs --test 'spine/tests/**/*.test.ts'`
- Test app wiring & CSA proofs: `node --import ./scripts/test-loader.mjs --test 'app/tests/**/*.test.ts'`
- Verify DAG, Depth-2 purity/cells, `[ENTRY-HYGIENE]`, & S1–S5: `pnpm check:dag`
- Verify Rust ↔ TS IPC commands, events, & shared policy parity: `pnpm check:ipc`
- Verify design tokens, `@layer` boundaries, & WCAG AA contrast: `pnpm check:design`
- Live dev workbench: `pnpm dev:ssa`
- Format: `pnpm -s oxfmt --write <paths>` (no semicolons, single quotes, width 100)
- Full pre-commit gate:
  `pnpm -s type && pnpm -s test && pnpm -s lint && pnpm -s check:dag && pnpm -s check:ipc && pnpm -s check:design && pnpm -s format:check && pnpm -s build`

## Authoring Rules

- **Code isolation ≠ feature isolation.** Zero cross-slice imports control code dependencies, never
  product collaboration. Collaborate through top-down composition in `app/runtime.ts`, typed ports,
  UI slots, the open `ToolCapability` / `ToolRegistry` contract (`libs/tools`), and Spine facts on
  `EventLog` (`spine/runtime`) only for genuine multi-surface fan-out. Merge chatty peers rather
  than syncing duplicate models through `app/`.
- **Working set & Depth-2 cells.** Scope slice work to `spine/` + `slices/<target>/`. Keep slices
  `<= ~2.5K` LOC flat in `src/`. Larger stateful slices (`browser`, `conversations`) sub-seal once
  at Depth 2: pure `kernel/` (zero React/Zustand/IDB/CSS/I/O) ← isolated `cells/<name>/` (direct
  `kernel/index.js` import, zero sibling-cell or `src/` imports) ← thin `src/` facade (sole public
  `.` export). Touch `app/` only for factory wiring, port adapters, slots, and window chrome.
- **Spine, opt-in `libs/`, Tier-`1c` contracts, & `test-support`.** Keep `spine/runtime`,
  `spine/ports`, and `spine/design` (tokens, theme, instance-scoped `i18n`) 100% domain-blind.
  Facts in `spine/facts/` are past-tense in the producer's domain and require `>= 2` non-test
  packages. Shared domain-free code lives in `libs/*`; opt-in Tier-`1c` contracts
  (`libs/chat-archive-contract`) are allowlisted strictly to participating slices; test fakes live
  in dev-only `@deepseek-chat/test-support`. Prefer small local helpers over growing `spine/`.
- **Single state owner & factory-scoped runtime.** Every piece of mutable truth has one owner (no
  writable shadow copies such as shadow `panelOpen`). Every slice is factory-scoped (`create*Slice`)
  returning `dispose()`, with zero module-level Zustand stores, IndexedDB handles, or ambient
  globals, supporting multiple isolated instances in one process.
- **Kernels, specs, & loud errors.** Keep `SPEC.md` short, separating behavioral invariants from
  tunable parameters and pruning superseded clauses. Model lifecycles with discriminated unions
  (zero boolean flag soup); keep pure transforms in `kernel/` or plain functions. Never swallow
  errors with bare `catch {}` blocks or advance sync caches before host IPC succeeds.
- **Verification & stop-and-escalate.** Test outer slice boundaries only in `slices/<target>/tests/`
  (package name imports, in-memory `EventLog`, `test-support` fakes, `fake-indexeddb`; zero
  internal mocks or `../src` imports) and cross-slice guarantees + multi-instance isolation in
  `app/tests/`. Derive assertions and `t = 0` randomized invariants from `SPEC.md` + entrypoint
  types without pinning tunable parameters, and prove every new test can fail with a deliberate
  mutant. If `SPEC.md`, `spine/`, and `tests/` conflict, stop and surface it; never weaken tests.
- **Subtraction-first refactoring.** Never wrap tangled code in pass-through callbacks, keep legacy
  stores alive behind two-way sync bridges, or re-export foreign `libs/` symbols from a slice.
  Delete duplicate owners, dead helpers, and `lateBindings` in the same cutover — or regenerate
  `src/` (`cells/`) cleanly from locked `SPEC.md` + `tests/`.

## Repo-Specific Rules

- **No middot (`·`) separators in UI copy** `[why: middots mask missing hierarchy or low-value telemetry; drop noise, write one natural phrase, or use distinct layout slots]`.
- **Static prompt layers & `docs/prompting-harness.md` (zero em dashes)** `[why: preserves Anthropic/DeepSeek KV-cache prefix reuse and consistent human-voiced tool prompts; update matching prompt layers whenever tools, surfaces, or sandbox rules change]`.
- **Slice-owned `chat-demo:*` storage keys & settings** `[why: keeps optional slices 1-line removable with zero orphaned keys or settings rows; production app/ never renders SettingRow directly and owns only chat-demo:browser-panel-width]`.
- **Rust ↔ TS IPC & policy parity (`pnpm check:ipc`)** `[why: catches drifted Tauri command names, event payloads, or shared tab/sandbox caps across the Rust/TS boundary before runtime]`.
- **Zero type or hook escape hatches (`any`, `as unknown as`, skipped hooks, broad `eslint-disable`)** `[why: blocks silent type and React-hook rot across multi-commit agent maintenance]`.
