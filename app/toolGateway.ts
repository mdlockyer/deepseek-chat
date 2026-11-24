/**
 * The conversations slice's tool gateway: adapts the slices that run client tools (workspace
 * files, web research, Python, the built-in browser) to the chat's tool-call loop.
 */
import { BROWSER_TOOL_NAMES } from '@deepseek-chat/slice-browser'
import {
  ASK_USER_INSTRUCTIONS,
  ASK_USER_TOOL,
  ASK_USER_TOOL_NAME,
  runAskUser,
  type AgentProfile,
  type ClientTool,
  type Message,
  type PresentedFileRef,
  type ToolEffect,
  type ToolGateway,
  type ToolKind,
  type ToolResult,
} from '@deepseek-chat/slice-conversations'
import {
  RESEARCH_TOOL_NAME,
  WEB_SCRAPE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '@deepseek-chat/slice-web-research'
import {
  EDIT_FILE_TOOL_NAME,
  PRESENT_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  collectWorkspaceArtifacts,
  getCodeLanguage,
  makeArtifactKey,
  normalizeWorkspacePath,
} from '@deepseek-chat/slice-workspace-files'
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
    case RESEARCH_TOOL_NAME:
      return 'subagent'
    case PRESENT_FILE_TOOL_NAME:
      return 'present_file'
    case EDIT_FILE_TOOL_NAME:
      return 'edit_file'
    case READ_FILE_TOOL_NAME:
      return 'read_file'
    case python.toolName:
      return 'python'
    case ASK_USER_TOOL_NAME:
      return 'ask_user'
    default:
      return BROWSER_TOOL_NAMES.has(name) ? 'browser' : null
  }
}

const effectOf = (name: string): ToolEffect => {
  switch (name) {
    case WEB_SEARCH_TOOL_NAME:
    case WEB_SCRAPE_TOOL_NAME:
    case READ_FILE_TOOL_NAME:
      return 'read'
    case RESEARCH_TOOL_NAME:
      return 'spawn'
    case PRESENT_FILE_TOOL_NAME:
    case EDIT_FILE_TOOL_NAME:
      return 'artifact'
    case ASK_USER_TOOL_NAME:
      return 'interactive'
    case python.toolName:
      return 'session'
    default:
      return 'session'
  }
}

const TOOL_SUMMARY_SCHEMA = {
  type: 'string',
  description:
    "Brief 1-sentence summary (6–18 words, in the user's language) explaining what this tool call is doing and why, shown live in the activity indicator. Always emit this field first.",
} as const

type DeclaredTool = ReturnType<ToolGateway['declare']>[number]

/** Prepends `summary` as the first property of every client tool schema so it streams before large payloads. */
const withSummaryParam = (tool: DeclaredTool): DeclaredTool => {
  if (!('input_schema' in tool)) {
    return tool
  }
  const schema = tool.input_schema
  const rawProps =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {}
  const properties = Object.hasOwn(rawProps, 'summary')
    ? rawProps
    : { summary: TOOL_SUMMARY_SCHEMA, ...rawProps }
  const rawRequired = Array.isArray(schema.required)
    ? schema.required.filter((item: unknown): item is string => typeof item === 'string')
    : []
  const required = rawRequired.includes('summary') ? rawRequired : ['summary', ...rawRequired]
  return {
    ...tool,
    input_schema: {
      ...schema,
      properties,
      required,
    },
  }
}

const describe = (name: string): ClientTool | null => {
  const candidates: ClientTool[] = [
    ...workspaceFiles.declareTools(),
    ASK_USER_TOOL,
    ...webResearch.declareTools({ searchEnabled: true, questionText: '' }),
    python.tool,
    ...browser.declareTools({ enabled: true }),
  ]
  const found = candidates.find((tool) => tool.name === name)
  return found ? withSummaryParam(found) : null
}

const agentProfile = (name: string): AgentProfile | null =>
  name === RESEARCH_TOOL_NAME ? webResearch.researchProfile : null

export const toolGateway: ToolGateway = {
  declare: ({ search, python: pythonEnabled, browser: browserEnabled, questionText }) =>
    [
      ...workspaceFiles.declareTools(),
      ASK_USER_TOOL,
      ...webResearch.declareTools({ searchEnabled: search, questionText }),
      ...(pythonEnabled ? [python.tool] : []),
      ...browser.declareTools({ enabled: browserEnabled }),
    ].map(withSummaryParam),

  instructions: (names, audience) => {
    const has = (handles: (name: string) => boolean) => [...names].some(handles)
    const hasWeb = has(webResearch.handles) || names.has(RESEARCH_TOOL_NAME)
    return [
      ...(has(workspaceFiles.handles) ? [workspaceFiles.instructions] : []),
      ...(names.has(ASK_USER_TOOL_NAME) ? [ASK_USER_INSTRUCTIONS] : []),
      ...(hasWeb ? [webResearch.instructionsFor(audience, names)] : []),
      ...(names.has(python.toolName) ? [python.instructions] : []),
      ...(has(browser.handles) ? [browser.instructions] : []),
    ]
  },

  describe,

  kindOf,

  effectOf,

  agentProfile,

  fenceLanguage: (path) => getCodeLanguage(path, ''),

  run: async (call, context): Promise<ToolResult> => {
    const startedAt = Date.now()

    if (call.name === ASK_USER_TOOL_NAME) {
      return runAskUser(call.input, {
        sessionId: context.sessionId,
        signal: context.signal,
      })
    }

    if (webResearch.handles(call.name)) {
      const replyId = context.messages.at(-1)?.id ?? ''
      const outcome = await webResearch.run(call.name, call.input, {
        signal: context.signal,
        inputJson: context.inputJson,
        citedUrls: context.caller.kind === 'reply' ? context.citedUrls : undefined,
        caller: context.caller,
        replyKey: replyId ? `${context.sessionId}:${replyId}` : context.sessionId,
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
        ...(outcome.previewImages?.length ? { previewImages: outcome.previewImages } : {}),
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
