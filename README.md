# deepseek-chat

A desktop and web client for the DeepSeek API, forked from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo). It packages the chat UI with [Tauri 2](https://v2.tauri.app/) and gives the model an in-browser Python REPL.

English | [简体中文](README.zh-CN.md)

You'll need your own API key from [platform.deepseek.com](https://platform.deepseek.com/api_keys). Chats and attachments stay local in IndexedDB, and requests go straight to `api.deepseek.com`.

## Download

Signed and notarized universal macOS (`DeepSeek.app` for Apple Silicon and Intel) `.dmg` installers are published on [GitHub Releases](https://github.com/mdlockyer/deepseek-chat/releases).

Windows and Linux builds are not pre-packaged in CI yet and require building from source.

## Running locally

Requires Node.js 22.12+ and pnpm. For the desktop app, you also need Rust 1.90+.

```sh
git clone https://github.com/mdlockyer/deepseek-chat.git
cd deepseek-chat
pnpm install
```

Run the desktop app in dev mode:

```sh
pnpm desktop:dev
```

Or run just the browser version at `http://localhost:8090`:

```sh
pnpm dev
```

To build a desktop release bundle under `src-tauri/target/release/bundle/`:

```sh
pnpm desktop:build
```

## Notes

When DeepThink is enabled, the model gets a persistent Python 3 runner powered by Pyodide in a Web Worker. Desktop builds bundle `numpy`, `pandas`, `matplotlib`, `Pillow`, and `micropip` locally; other packages load from jsDelivr when online. Matplotlib plots show inline and go back to the model, and files written with `present_file()` download through a native save dialog.

On desktop, API requests go through `tauri-plugin-http` instead of the webview's `fetch` to avoid CORS limits, links open in your default browser, `Cmd+,` opens Settings on macOS, and your API key is saved in `~/Library/Application Support/com.mlockyer.deepseekchat/api-key` (`0600`) rather than `localStorage`.

The rest of the upstream chat UI is intact: branching conversations, web search, link reading, attachments, voice input, read-aloud, KaTeX, Mermaid diagrams, light/dark themes, English/Chinese localization, and ZIP history export/import.

## Commands

```sh
pnpm test          # run unit tests
pnpm type          # TypeScript check
pnpm lint          # oxlint
pnpm format        # format with oxfmt
pnpm build         # static site output in dist/
```

To point the client at another API server, pass `apiOrigin` to `createConfig()` in [rspack.config.ts](rspack.config.ts).

## License

[MIT](LICENSE)
