# Production Readiness Gap Report

Snapshot of what is verified and what remains before public distribution of `deepseek-chat` (`0.2.0`).

## Verified baseline

- **Static and unit checks**: `pnpm format:check`, `pnpm type`, `pnpm lint` (0 warnings/errors), `pnpm check:dag`, `pnpm test` (268 tests across 79 suites covering `spine/`, `libs/markdown/`, `app/` wiring, and all 8 `slices/*`), `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `plutil -lint` on `src-tauri/Info.plist` and `src-tauri/Entitlements.plist`.
- **Desktop packaging, signing, and notarization**: `src-tauri/tauri.conf.json` configures `productName: "DeepSeek"` (`DeepSeek.app`), `bundle.macOS.hardenedRuntime: true`, `src-tauri/Info.plist` (`NSMicrophoneUsageDescription`), and `src-tauri/Entitlements.plist` (`com.apple.security.device.audio-input`, `com.apple.security.network.client`). `.github/workflows/ci.yml` runs frontend checks, unit tests, and Rust `rustfmt` / `clippy` / `cargo test`, while `.github/workflows/release.yml` builds universal macOS `.app` and `.dmg` bundles, signs, notarizes, staples, and publishes GitHub Releases. Signing and notarization secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`) are configured on `mdlockyer/deepseek-chat` and verified end-to-end in CI (`Release macOS` run `44112133282`, `v0.2.0-rc.1` DMG smoke-tested on macOS; `spctl --assess`: `source=Notarized Developer ID` on both `.app` and `.dmg`).
- **Core hardening completed**: Private `0600` desktop API key storage with legacy Keychain migration (`src-tauri/src/lib.rs`), WebView CSP (`src-tauri/tauri.conf.json`), native browser SSRF/localhost and IPv6/IPv4-mapped IPv6 guards (`src-tauri/src/browser.rs`, `slices/browser/`), isolated `ds-preview://` file preview webview (`src-tauri/src/preview.rs`), OS-sandboxed native CPython (`src-tauri/src/python_sandbox.rs`) and serialized Pyodide worker (`slices/python/src/worker.ts`, `kernel.ts`), ZIP entry/total size caps (`slices/conversations/src/history/zipReader.ts`, `importArchive.ts`), React error boundaries (`app/AppErrorBoundary.tsx`), and default non-streaming REST timeouts (`slices/conversations/src/api/client.ts`).

## Remaining gaps

### 1. Updater

- **No auto-updater**: `tauri-plugin-updater` is not integrated, so users must manually download and replace bundles for updates.

### 2. End-to-end desktop coverage

- **No desktop E2E tests**: Tauri IPC commands (`get_api_key`, `set_api_key`, `save_file`, native browser/preview webviews) and native menu events are verified via Rust unit tests, TS boundary tests over fakes, and manual/dev runs rather than automated WebDriver E2E tests.
