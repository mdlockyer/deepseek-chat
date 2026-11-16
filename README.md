# deepseek-chat

A fork of [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT) that adds a persistent in-browser Python tool for the model and packages the app as a Tauri 2 desktop app.

English | [简体中文](README.zh-CN.md)

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

The upstream browser version is online at [deepseek-ai.github.io/chat-demo](https://deepseek-ai.github.io/chat-demo/). This repository adds the Python tool and the desktop app described below. Enter your API key in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/mdlockyer/deepseek-chat.git
cd deepseek-chat
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Desktop app

The same UI also runs as a desktop app built with [Tauri 2](https://v2.tauri.app/). The native code is in `src-tauri/`. Install a Rust toolchain, then run:

```sh
pnpm desktop:dev    # starts `pnpm dev` and opens the app window
pnpm desktop:build  # builds dist/ and bundles the app under src-tauri/target/release/bundle/
```

If `pnpm dev` is already running, use `pnpm tauri dev --config '{"build":{"beforeDevCommand":""}}'` so a second dev server is not started on port 8090. That dev server then serves the browser build, which loads Pyodide from jsDelivr.

The desktop app differs from the browser build in these ways:

- The API key is stored in the operating system's credential store (the Keychain on macOS) instead of localStorage. A key left in localStorage by an older build moves to the Keychain on first launch.
- API requests are sent from Rust through `tauri-plugin-http`, so browser CORS rules do not apply. The capability file allows only `https://api.deepseek.com/*`.
- Pyodide ships with the app, together with numpy, pandas, matplotlib, Pillow, micropip and their dependencies (about 32 MB). `pnpm pyodide:fetch` prepares them in `vendor/pyodide/`; the desktop scripts run it automatically. Other Pyodide packages still load from jsDelivr when the app is online. The browser build loads all of Pyodide from jsDelivr.
- Files that the Python tool offers for download are saved through a native save dialog, because the macOS webview does not download `blob:` links.
- Links in replies open in the default browser.
- The app keeps its own chats and settings, separate from any browser.

The Python tool is offered to the model only when DeepThink is on. Requests always declare `safety_check` and `deepseek_read_url`, and with those the API accepts client tools only in thinking mode.

## Data and storage

Your API key and settings are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
