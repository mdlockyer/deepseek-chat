# SPEC: `slices/workspace-files` (files the model presents and preview panel)

## Purpose

A per-chat workspace of files created/edited/read by the model (`present_file`, `edit_file`,
`read_file`), plus Python outputs and user uploads. Tracks per-path version history, preview panel
state (with `PanelSlot` as sole open/closed owner), and rendered/source preview views.

## Public entrypoint

`createWorkspaceFilesSlice({ log, panel, host, blobs?, loadFile?, saveFile, copyText, views, notify?, newId? })`
returns:

| Member                                                                                    | Meaning                                                                                                                   |
| :---------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `capability`                                                                              | Open `ToolCapability` (`id: 'workspace-files'`, `read_file` → `'read'` else `'artifact'`, blobs I/O, presenter, archive). |
| `declareTools()`, `instructions`, `handles(name)`, `toolNames`                            | The three file tools (`present_file`, `edit_file`, `read_file`; persisted in history, never rename) and prompt guidance.  |
| `run(name, input, { records, replyId })`                                                  | Runs one file tool; always resolves to `{ status, text, file?, fileAction, durationMs }`.                                 |
| `reveal`, `openFile`, `openDeliveredFile`, `openUploadFile`                               | Reveals or opens a file/version in the preview panel (`ToolFileDelivered` triggers `reveal` reactively).                  |
| `togglePanel`, `closePanel`, `getSession`, `useSession`, `useHasFiles`, `refreshSnapshot` | Per-chat preview state (`activeKey`, `uploadKeys`, version pins, view modes, viewports).                                  |
| `HeaderToggle`, `PreviewPanel({ records?, topActions? })`, `dispose()`                    | Views and Spine listener teardown.                                                                                        |

Pure package exports: `collectWorkspaceArtifacts`, `normalizeWorkspacePath`, `makeArtifactKey`,
`makeUploadPreviewKey`, `inferMimeType`, `classifyPreviewKind`, `supportsPreviewToggle`,
`getCodeLanguage`, `parseDelimitedText`.
Ports: `PanelSlot` (`spine/ports`), `BlobStore`, `NoticePort`, `PreviewHost` (desktop HTML/PDF
webview, `null` on web), `WorkspaceViews`.

## Behavioural invariants

1. **Paths.** Trimmed, `\` → `/`, empty/`.`/`..` segments dropped so paths never escape workspace;
   paths normalizing to empty are rejected by every tool.
2. **Artifacts and versions.** Presented files sharing a normalized path (or name) form one artifact
   in first-appearance order. **One version = what one reply left a file as**: a subsequent save in
   the same `replyId` replaces that reply's latest version in place (same number); a new reply adds
   the next version. Existing stored numbers are preserved; latest is last; title is latest given;
   Python-produced records carry source `'python'`, others `'model'`. Uploads are never artifacts.
3. **`present_file`.** Requires string `content` (`<= 10 MB`), resolves MIME from explicit specific
   `mime_type` else extension, allocates a fresh id, and assigns version per invariant 2 without
   mutating earlier versions.
4. **`edit_file`.** Requires non-empty `edits: { old_text, new_text }[]` and an existing presented
   text file (exact path first, then case-insensitive path/name; uploads are not editable). Applies
   edits in order; each `old_text` must be non-empty and match exactly once; result `<= 10 MB`.
5. **`read_file`.** Looks up presented files first, then uploads (latest first); rejects non-text
   files as `"not a UTF-8 text file"` and cuts text past 40,000 chars with a length note.
6. **Failures.** Always resolve `status: 'error'` without storing a file.
7. **Reveal, open, & toggle.** `reveal` activates the key, clears its version pin, and opens the
   panel only when `openPanel` allows (default: active chat only; background chats never hijack the
   active panel). Opening an older version pins it; opening latest clears the pin; opened uploads
   stay remembered. Toggling closes when open, or opens preserving a still-valid active key else the
   last given key.
8. **Per-chat state & lifecycle facts.** State is strictly per chat. Sticky `SessionFilesChanged`
   feeds `capability.run` and `PreviewPanel`; `ToolFileDelivered` reveals new files; `SessionDeleted`
   drops that chat; `SessionHistoryReplaced` clears all chats.
9. **Surfaces & RFC 4180 tables.** Desktop renders HTML/PDF in isolated `PreviewHost`, web uses
   sandboxed iframe / browser PDF viewer; Markdown, Mermaid, SVG, images, CSV/TSV, and code render
   in-page. CSV/TSV supports quoted delimiters, `""`, embedded newlines, CRLF, leading BOM, padded
   short rows, and row-limit truncation.

## Parameters

| Name                 | Default             |
| :------------------- | :------------------ |
| Text file size limit | `10 MB`             |
| `read_file` cut      | `40,000` characters |
| Table row limit      | `2,000` rows        |
