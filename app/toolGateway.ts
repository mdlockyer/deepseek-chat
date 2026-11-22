/**
 * The conversations slice's tool gateway: adapts the slices that run client tools (workspace
 * files, web research, Python, the built-in browser) to the chat's tool-call loop.
 */
import { BROWSER_TOOL_NAMES } from '@deepseek-chat/slice-browser'
import type {
  PresentedFileRef,
  ToolGateway,
  ToolKind,
  ToolResult,
} from '@deepseek-chat/slice-conversations'
import { WEB_SCRAPE_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '@deepseek-chat/slice-web-research'
import {
  EDIT_FILE_TOOL_NAME,
  PRESENT_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  collectWorkspaceArtifacts,
  getCodeLanguage,
  makeArtifactKey,
  normalizeWorkspacePath,
} from '@deepseek-chat/slice-workspace-files'
import type { Message } from '@deepseek-chat/slice-conversations'
import { createId } from './utils/id.js'
import { browser, python, webResearch } from './composition.js'
import { toFileRecords } from './fileRecords.js'
import { workspaceFiles } from './workspaceFiles.js'

/** Collects user attachments plus the latest version of model-presented files for Python's read-only `uploads/`. */
export const collectPythonUploads = (
  messages: readonly Message[],
  loadFile: (id: string) => Promise<Blob | undefined>
) => {
  const seen = new Set<string>()
  const uploads: { id: string; name: string; loadBlob: () => Promise<Blob | undefined> }[] = []
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      if (!seen.has(file.id)) {
        seen.add(file.id)
        uploads.push({ id: file.id, name: file.name, loadBlob: () => loadFile(file.id) })
      }
    }
  }
  for (const artifact of collectWorkspaceArtifacts(toFileRecords(messages))) {
    if (artifact.source === 'python') {
      continue
    }
    const { fileId, name } = artifact.latest
    if (!seen.has(fileId)) {
      seen.add(fileId)
      uploads.push({ id: fileId, name, loadBlob: () => loadFile(fileId) })
    }
  }
  return uploads
}

const kindOf = (name: string): ToolKind | null => {
  switch (name) {
    case WEB_SEARCH_TOOL_NAME:
      return 'web_search'
    case WEB_SCRAPE_TOOL_NAME:
      return 'web_scrape'
    case PRESENT_FILE_TOOL_NAME:
      return 'present_file'
    case EDIT_FILE_TOOL_NAME:
      return 'edit_file'
    case READ_FILE_TOOL_NAME:
      return 'read_file'
    case python.toolName:
      return 'python'
    default:
      return BROWSER_TOOL_NAMES.has(name) ? 'browser' : null
  }
}

export const toolGateway: ToolGateway = {
  declare: ({ search, python: pythonEnabled, browser: browserEnabled, questionText }) => [
    ...workspaceFiles.declareTools(),
    ...webResearch.declareTools({ searchEnabled: search, questionText }),
    ...(pythonEnabled ? [python.tool] : []),
    ...browser.declareTools({ enabled: browserEnabled }),
  ],

  instructions: (names) => {
    const has = (handles: (name: string) => boolean) => [...names].some(handles)
    return [
      ...(has(workspaceFiles.handles) ? [workspaceFiles.instructions] : []),
      ...(has(webResearch.handles) ? [webResearch.instructions] : []),
      ...(has(browser.handles) ? [browser.instructions] : []),
    ]
  },

  kindOf,

  fenceLanguage: (path) => getCodeLanguage(path, ''),

  run: async (call, context): Promise<ToolResult> => {
    const startedAt = Date.now()

    if (webResearch.handles(call.name)) {
      // 同一回复内已编号的来源 URL → 编号，保证多次搜索时 [citation:N] 与前端编号一致
      const citedUrls = new Map<string, number>()
      for (const block of context.replyBlocks) {
        if (block.type !== 'tool_result') {
          continue
        }
        for (const item of block.searchResults ?? []) {
          if (!citedUrls.has(item.url)) {
            citedUrls.set(item.url, citedUrls.size + 1)
          }
        }
        if (block.scrapedPage && !citedUrls.has(block.scrapedPage.url)) {
          citedUrls.set(block.scrapedPage.url, citedUrls.size + 1)
        }
      }
      const outcome = await webResearch.run(call.name, call.input, {
        signal: context.signal,
        inputJson: context.inputJson,
        citedUrls,
      })
      return {
        content: outcome.content,
        status: outcome.status,
        durationMs: Date.now() - startedAt,
        ...(outcome.searchResults ? { searchResults: outcome.searchResults } : {}),
        ...(outcome.scrapedPage ? { scrapedPage: outcome.scrapedPage } : {}),
      }
    }

    if (browser.handles(call.name)) {
      const outcome = await browser.run(call.name, call.input, {
        signal: context.signal,
        sessionId: context.sessionId,
      })
      return {
        content: outcome.text,
        status: outcome.status,
        ...(outcome.images.length > 0 ? { images: outcome.images } : {}),
        durationMs: outcome.durationMs,
        browserAction: outcome.meta,
      }
    }

    if (workspaceFiles.handles(call.name)) {
      const outcome = await workspaceFiles.run(call.name, call.input, {
        records: toFileRecords(context.messages),
        // 可见分支的最后一条就是生成中的回复（conversations SPEC 不变式 3a）
        replyId: context.messages.at(-1)?.id ?? '',
      })
      let presented: PresentedFileRef[] = []
      if (outcome.file) {
        try {
          await context.saveFiles([{ id: outcome.file.ref.id, blob: outcome.file.blob }])
          presented = [outcome.file.ref]
          workspaceFiles.reveal(context.sessionId, outcome.file.artifactKey, {
            openPanel: context.isActive(),
          })
        } catch {
          outcome.text +=
            '\n[Saving the file in the browser failed, so the user cannot preview or download it.]'
        }
      }
      return {
        content: outcome.text,
        status: outcome.status,
        durationMs: outcome.durationMs,
        fileAction: outcome.fileAction,
        ...(presented.length ? { files: presented } : {}),
      }
    }

    if (call.name !== python.toolName) {
      return { content: `Unknown tool: ${call.name}`, status: 'error', images: [], durationMs: 0 }
    }
    const code =
      call.input && typeof (call.input as { code?: unknown }).code === 'string'
        ? (call.input as { code: string }).code
        : null
    if (code === null) {
      return {
        content: `Invalid input: expected {"code": string}, got ${call.inputJson ?? JSON.stringify(call.input)}`,
        status: 'error',
        images: [],
        durationMs: 0,
      }
    }
    const uploads = collectPythonUploads(context.messages, context.loadFile)
    const outcome = await python.run(code, {
      signal: context.signal,
      onPhase: context.onPhase,
      sessionId: context.sessionId,
      uploads,
    })
    // 下载文件先落盘到 IndexedDB，回复里只保存引用；保存失败时告诉模型。
    let presented: PresentedFileRef[] = []
    if (outcome.files.length > 0) {
      const stored = outcome.files.map((file) => ({
        id: createId(),
        blob: new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.mimeType }),
        file,
      }))
      try {
        await context.saveFiles(stored.map(({ id, blob }) => ({ id, blob })))
        presented = stored.map(({ id, file }) => ({
          id,
          name: file.name,
          path: normalizeWorkspacePath(file.name) || file.name,
          size: file.data.byteLength,
          mimeType: file.mimeType,
          source: 'python',
        }))
        const lastFile = presented.at(-1)
        if (lastFile) {
          workspaceFiles.reveal(
            context.sessionId,
            makeArtifactKey(lastFile.path ?? lastFile.name),
            { openPanel: context.isActive() }
          )
        }
      } catch {
        outcome.text +=
          '\n[Saving the files in the browser failed, so the user cannot download them.]'
      }
    }
    return {
      content: outcome.text,
      status: outcome.status,
      images: outcome.images,
      durationMs: outcome.durationMs,
      ...(presented.length ? { files: presented } : {}),
    }
  },
}
