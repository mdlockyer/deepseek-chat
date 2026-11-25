# SPEC: `slices/history-backup` (ZIP v3 archive import/export & Data settings)

## Purpose

Owns DeepSeek `export_format_version: 3` ZIP archive serialization/deserialization, the serialized
backup queue (import, export, clear), and the Settings dialog's **Data** tab (import/export/delete
rows and confirmation modals). Has zero imports from `slices/conversations` or any tool slice:
reads/writes sessions through `HistorySessionsPort`, reads image blobs through Spine `BlobStore`,
and delegates client tool-block serialization through `serializeToolBlock`.

## Public entrypoint

`createHistoryBackupSlice(deps)` returns:

| Member                         | Meaning                                                                      |
| :----------------------------- | :--------------------------------------------------------------------------- |
| `exportHistory()`              | Exports all chats + local images to `{ name, blob }` (`deepseek_data-…zip`). |
| `importHistory(file)`          | Validates manifest/version, parses ZIP, and replaces all chats + blobs.      |
| `clearHistory()`               | Replaces all local chats and blobs with an empty history.                    |
| `historyErrorText(error)`      | Localized failure reason for `BackupError`, or `null`.                       |
| `useDataSettings()`            | Controller hook for import/delete busy state and confirmation dialogs.       |
| `DataSettings({ controller })` | The three Data settings rows (Import, Export, Delete all chats).             |
| `DataModals({ controller })`   | Confirmation modals for destructive import overwrite and delete-all.         |
| `dispose()`                    | Marks the slice disposed (no global state or dangling subscriptions).        |

Pure codec exports: `BackupError`, `ArchiveError`, `readArchive`, `readEntry`, `writeArchive`,
`readSessionFile`, `toSessionFile`, `toLocalSession`.

## Behavioural invariants

1. **Serialized queue.** Import, export, and clear execute sequentially on an instance-scoped queue
   so a concurrent clear never corrupts an in-flight export or import.
2. **Pre-flight manifest check.** `importHistory` validates ZIP magic and `manifest.json` version
   before calling `sessions.replaceHistory`, so an invalid file never aborts active replies.
3. **Round-trip fidelity.** Exporting and re-importing restores every chat's title, message tree,
   visible branch, and image attachments (with byte-sniffed MIME types).
4. **Open tool serialization.** Client `tool_use` / `tool_result` blocks delegate to
   `serializeToolBlock` (from `ToolRegistry`); unrecognized tools gracefully serialize as fenced
   Markdown without requiring knowledge of sibling slices.
5. **Multi-instance isolation.** Zero module-level queues or stores; two instances operate
   independently.

## Facts

Consumes none; publishes none (`conversations` publishes `SessionHistoryReplaced` upon commit).
