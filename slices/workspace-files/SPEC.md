# SPEC: `slices/workspace-files` (files the model presents, and the preview panel)

## Purpose

A per-chat workspace of files. The model creates, edits and reads text files through three tools;
Python and user uploads add files too. Each logical path keeps a version history. The user views
any file and any version in the right-hand panel, as a rendered preview or as source, and can copy
or save it. The slice owns the tool rules, version history, the per-chat preview state and the
panel's views; the chat owns storing messages and file contents.

## Public entrypoint

`createWorkspaceFilesSlice({ log, panel, host, loadFile, saveFile, copyText, views, newId? })`
returns:

| Member                                                 | Meaning                                                                                                                                                                                  |
| :----------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declareTools()`, `instructions`, `handles(name)`      | The three file tools, offered on every turn, and their system-prompt text (when to make a file; present it once, complete; it cannot be opened by other tools; revise with `edit_file`). |
| `toolNames`                                            | `present_file`, `edit_file`, `read_file`. Persisted in chat history; never rename.                                                                                                       |
| `run(name, input, { records })`                        | Run one tool against the chat's files. Always resolves to `{ status, text, file?, fileAction, durationMs }`.                                                                             |
| `reveal(sessionId, key, { openPanel?, defaultMode? })` | Show a newly stored file.                                                                                                                                                                |
| `openFile(sessionId, key, fileId?, isLatest?)`         | The user opened a file card or attachment.                                                                                                                                               |
| `togglePanel(sessionId, fallbackKeys)`, `closePanel()` | The chat's preview panel.                                                                                                                                                                |
| `getSession(id)`, `useSession(id)`                     | A chat's preview state: `{ activeKey, uploadKeys, selectedFileIdByKey, viewModeByKey, viewportByKey }`.                                                                                  |
| `refreshSnapshot()`                                    | Refresh the still image shown while the native preview is hidden.                                                                                                                        |
| `PreviewPanel({ records, topActions? })`               | The panel view for the chat on screen.                                                                                                                                                   |
| `dispose()`                                            | Stop listening to facts.                                                                                                                                                                 |

Pure helpers exported by the package: `collectWorkspaceArtifacts`, `normalizeWorkspacePath`,
`makeArtifactKey`, `makeUploadPreviewKey`, `inferMimeType`, `classifyPreviewKind`,
`supportsPreviewToggle`, `getCodeLanguage`, `parseDelimitedText`, and the tool-name constants.

Inputs and ports:

- `FileRecord[]`: the chat's files on its visible branch in conversation order, each `presented`
  (from a tool result: id, name, path?, title?, size, MIME, version?, source?, producedBy?) or
  `upload` (a user attachment). The app derives them from messages and passes them in.
- `loadFile(id)`: stored contents. `saveFile(name, blob)`, `copyText(text)`.
- `PanelSlot` (`spine/design`): this slice's slot in the app's right-hand panel.
- `PreviewHost`: the desktop's isolated preview webview for HTML and PDF; `null` on the web.
- `WorkspaceViews`: Markdown, Mermaid, code highlighting and file icons, provided by the app.

## Behavioural invariants

1. **Paths.** A workspace path is trimmed, `\` becomes `/`, and empty, `.` and `..` segments are
   dropped, so a path can never climb out of the workspace. A path that normalizes to empty is
   rejected by every tool.
2. **Artifacts and versions.** Presented records with the same normalized path (or the name, when
   there is no path) form one artifact, in first-appearance order. Versions are kept in record
   order; the last is the latest. A record without a version number gets the next number.
   The title is the latest one given. A record from the `python` tool, or marked `python`, has
   source `python`; otherwise `model`. Uploads are never artifacts.
3. **present_file.** Requires string `content`. The MIME type comes from `mime_type` when given and
   specific, else from the extension. Content over 10 MB is rejected. The new file is version 1,
   or one more than the path's latest version, with a fresh id; earlier versions are untouched.
   The result carries the file for the caller to store and its artifact key.
4. **edit_file.** Requires a non-empty `edits` list of `{ old_text, new_text }` strings and an
   existing presented file at the path (exact path first, then case-insensitive path or name;
   uploads are not editable). The file must be text. Edits apply in order to the latest version;
   each `old_text` must be non-empty and match exactly once, or the call fails naming the edit and
   the problem (not found / matched N places). The result is a new version with a fresh id, the
   same path and MIME type, and the earlier title unless a new one is given. Over 10 MB fails.
5. **read_file.** Finds a presented file as `edit_file` does, then falls back to uploads (latest
   first, by path or case-insensitive name). Non-text files fail with "not a UTF-8 text file".
   Text over 40,000 characters is cut there with a note giving both lengths.
6. **Failures** resolve `status: 'error'` with the message as text; nothing is stored.
7. **Reveal.** Revealing a file makes it the chat's active file and drops any version pin on it.
   The panel opens when `openPanel` says so; by default only when that chat is on screen.
   Revealing in a background chat never opens or changes the panel of the chat on screen.
8. **Opening a file.** Opening a file card makes it active and opens the panel. Opening an older
   version pins that version; opening the latest clears the pin. Opened uploads are remembered as
   keys the panel can return to.
9. **Toggle.** Toggling an open panel closes it. Opening it keeps the active file when it is still
   one of the given keys or a remembered upload; otherwise it shows the last given key. With no
   keys given, the active file is kept as is.
10. **Per-chat state.** Active file, pins, view modes and viewports belong to one chat; a chat
    never seen has the empty state.
11. **Lifecycle facts.** `SessionDeleted` drops that chat's preview state; `SessionHistoryReplaced`
    drops every chat's.
12. **Surfaces.** On the desktop, HTML and PDF render in the host's isolated webview; on the web,
    HTML renders in a sandboxed iframe and PDF in the browser's viewer. Markdown, Mermaid, SVG,
    images, CSV/TSV tables and code render in the page on both.
13. **Tables.** CSV/TSV parse per RFC 4180: quoted cells may hold the delimiter, `""` and line
    breaks; CRLF and a leading BOM are handled; short rows are padded; rows past the limit are cut
    and marked truncated.

## Parameters

| Name                 | Value                |
| :------------------- | :------------------- |
| Text file size limit | 10 MB                |
| `read_file` cut      | 40,000 characters    |
| Table row limit      | 2,000 rows (default) |
