# Production Readiness Gap Report

Snapshot of what is verified and what remains before public distribution of `deepseek-chat` (`0.2.0-rc.1`).

## Verified baseline

- **Static and unit checks**: `pnpm format:check`, `pnpm type`, `pnpm lint` (0 warnings/errors), `pnpm test` (17 tests across 4 files), `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test --manifest-path src-tauri/Cargo.toml` (`tests::key_file_round_trip`), and `plutil -lint` on `src-tauri/Info.plist` and `src-tauri/Entitlements.plist`.
- **Desktop packaging, signing, and notarization**: `src-tauri/tauri.conf.json` configures `bundle.macOS.hardenedRuntime: true`, `src-tauri/Info.plist` (`NSMicrophoneUsageDescription`), and `src-tauri/Entitlements.plist` (`com.apple.security.device.audio-input`, `com.apple.security.network.client`). `.github/workflows/ci.yml` runs frontend checks, unit tests, and Rust `rustfmt` / `clippy` / `cargo test`, while `.github/workflows/release.yml` builds universal macOS `.app` and `.dmg` bundles, signs, notarizes, staples, and publishes GitHub Releases. Signing and notarization secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`) are configured on `mdlockyer/deepseek-chat` and verified end-to-end in CI (`Release macOS` run `44026603345`) as well as locally (`spctl --assess`: `source=Notarized Developer ID` on both `.app` and `.dmg`).
- **Core hardening completed**: Private `0600` desktop API key storage with legacy Keychain migration (`src-tauri/src/lib.rs`), WebView CSP (`src-tauri/tauri.conf.json`), serialized Python worker execution (`src/services/python/worker.ts`) and per-session kernel isolation (`src/services/python/kernel.ts`), ZIP entry/total size caps (`src/services/chat/history/zipReader.ts`, `importArchive.ts`), and Python call/output export in v3 archives (`src/services/chat/history/toArchive.ts`).

## Remaining gaps

### 1. Updater

- **No auto-updater**: `tauri-plugin-updater` is not integrated, so users must manually download and replace bundles for updates.

### 2. Runtime resilience

- **No React Error Boundary**: No `componentDidCatch` or `getDerivedStateFromError` boundary exists in `src/`. An unhandled render exception in Markdown, KaTeX, Mermaid, or message components blanks the window instead of showing a recoverable fallback UI.
- **No default timeouts on non-streaming REST calls (`src/services/api/client.ts`)**: `request()` (`src/services/api/client.ts`) only aborts when a caller provides an `AbortSignal`. `verifyApiKey`, `uploadFile`, and `deleteFile` rely on OS socket timeouts if an endpoint hangs.
- **Signed release `.app` smoke test pending**: End-to-end verification inside the newly signed `DeepSeek Chat.app` (`tauri://localhost/` production CSP, Pyodide `micropip` online install, `present_file()` save dialog, microphone TCC prompt, `Cmd+,` menu shortcut, and external links) has not yet been run as a combined manual pass.

### 3. Automated test coverage

- **Narrow frontend test coverage**: 4 test files (`17` tests) cover `sse.ts`, `reply.ts`, `branches.ts`, `zipReader.ts`, `toArchive.ts`, and `toLocal.ts`, out of `108` non-test `.ts`/`.tsx` files.
- **Untested modules**: `src/services/chat/store.ts` (retries, file re-upload, concurrency), `src/services/chat/db.ts` (IndexedDB transactions and staging rollback), `src/services/settings.ts`, `src/services/python/kernel.ts` and `worker.ts`, `src/services/speech/`, `src/platform/desktop.ts`, and React UI flows have no automated tests.
- **No desktop E2E tests**: Tauri IPC commands (`get_api_key`, `set_api_key`, `save_file`) and native menu events are only tested via unit tests and manual/dev runs.
