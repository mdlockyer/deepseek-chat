import { formatSize } from './format.js'
import { classifyPreviewKind, inferMimeType, isTextPreviewKind } from './fileKinds.js'
import {
  collectWorkspaceArtifacts,
  findWorkspaceFile,
  getBasename,
  makeArtifactKey,
  normalizeWorkspacePath,
  type FileRecord,
  type PresentedFile,
} from './workspace.js'

/** Model-visible client tool definition (client tools carry no `type` field). */
export type FileToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

export const PRESENT_FILE_TOOL_NAME = 'present_file'
export const EDIT_FILE_TOOL_NAME = 'edit_file'
export const READ_FILE_TOOL_NAME = 'read_file'

const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024
const MAX_READ_CHARS = 40_000

export type FileTextEdit = {
  old_text: string
  new_text: string
}

export const PREVIEW_TOOLS: FileToolDefinition[] = [
  {
    name: PRESENT_FILE_TOOL_NAME,
    description:
      'Create and display a self-contained file to the user in the right-side File Preview panel (HTML/CSS/JS interactive apps, SVG graphics, Markdown reports, Mermaid diagrams, CSV/TSV tables, JSON, or complete standalone source files). Calling present_file with an existing path creates the next version (v2, v3, ...); within the same reply it revises the version that reply already made.',
    input_schema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          description:
            'Workspace filename or relative path with extension (e.g. "dashboard.html", "chart.svg", "report.md", "sales.csv", "app.tsx").',
        },
        content: {
          type: 'string',
          description: 'Complete UTF-8 text content of the file.',
        },
        title: {
          type: 'string',
          description: 'Optional concise display title for the file tab and card.',
        },
        mime_type: {
          type: 'string',
          description: 'Optional MIME type (inferred from extension if omitted).',
        },
      },
    },
  },
  {
    name: EDIT_FILE_TOOL_NAME,
    description:
      'Apply targeted search-and-replace edits to a file previously presented in this conversation, updating it in the preview panel without rewriting the entire file (the next version, or the same version when this reply already made one).',
    input_schema: {
      type: 'object',
      required: ['path', 'edits'],
      properties: {
        path: {
          type: 'string',
          description: 'Path or filename of the existing presented file to update.',
        },
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['old_text', 'new_text'],
            properties: {
              old_text: {
                type: 'string',
                description: 'Exact existing text snippet to replace (must match uniquely).',
              },
              new_text: {
                type: 'string',
                description: 'Replacement text.',
              },
            },
          },
          description: 'Ordered list of exact text replacements to apply.',
        },
        title: {
          type: 'string',
          description: 'Optional updated display title.',
        },
      },
    },
  },
  {
    name: READ_FILE_TOOL_NAME,
    description:
      'Read the current UTF-8 text content of a presented file or text-based user attachment in this conversation before editing or referencing it.',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Path or filename of the file to read.',
        },
      },
    },
  },
]

export const PREVIEW_TOOL_NAMES = new Set(PREVIEW_TOOLS.map((tool) => tool.name))

export const PREVIEW_TOOL_INSTRUCTIONS = [
  'You have file presentation tools (`present_file`, `edit_file`, `read_file`) that open files directly in the user’s right-hand File Preview panel.',
  'Use `present_file` for substantial, self-contained artifacts meant to be viewed, rendered, copied, or saved—such as interactive single-file HTML/CSS/JS widgets or visualizations, SVG graphics, long Markdown documents/reports, Mermaid diagrams, CSV/JSON datasets, or complete standalone source files (~25+ lines).',
  'Keep short code snippets, terminal commands, quick examples, and conversational answers inline in Markdown rather than creating a file.',
  'When revising a file you already presented, prefer `edit_file` (or `read_file` first if unsure of exact lines) with the same `path` so versions increment cleanly (v1 -> v2) instead of creating duplicate files.',
  'Get a file right before you present it: plan it briefly in your thinking, then put the file’s full text only in `content`; never draft the file itself in your thinking. Present it once, complete. Within the same reply, use `edit_file` on it only to fix a real error you found, not for polish or second thoughts.',
  'Presented files exist only in the File Preview panel: they have no URL or path that any other tool can open (the built-in browser refuses `file://` URLs), and you cannot see them rendered yourself. Do not try to open or screenshot a presented file to check it; review its content before presenting instead.',
  'After `present_file` or `edit_file`, briefly summarize what you created or changed without pasting the full file contents into your message.',
].join(' ')

const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle) {
    return 0
  }
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) {
      break
    }
    count++
    pos = idx + needle.length
  }
  return count
}

/** 依次应用精确文本替换；未找到或命中多处时抛出明确错误 */
export const applyTextEdits = (
  original: string,
  edits: FileTextEdit[],
  pathLabel: string
): string => {
  let next = original
  for (let i = 0; i < edits.length; i++) {
    const { old_text: oldText, new_text: newText } = edits[i]
    if (!oldText) {
      throw new Error(`Edit #${i + 1} has empty old_text.`)
    }
    const matches = countOccurrences(next, oldText)
    if (matches === 0) {
      throw new Error(
        `Edit #${i + 1} old_text not found in "${pathLabel}". Call read_file to inspect the current contents.`
      )
    }
    if (matches > 1) {
      throw new Error(
        `Edit #${i + 1} old_text matched ${matches} places in "${pathLabel}". Include more surrounding lines so it matches once.`
      )
    }
    const idx = next.indexOf(oldText)
    next = next.slice(0, idx) + newText + next.slice(idx + oldText.length)
  }
  return next
}

export type PreviewToolRunResult = {
  status: 'ok' | 'error'
  text: string
  file?: {
    ref: PresentedFile
    blob: Blob
    artifactKey: string
  }
  fileAction: {
    tool: 'present_file' | 'edit_file' | 'read_file'
    path: string
    title?: string
    version?: number
  }
  durationMs: number
}

export const runPreviewTool = async (
  toolName: string,
  rawInput: unknown,
  context: {
    records: readonly FileRecord[]
    /** The reply this call belongs to: saves within one reply form one version. */
    replyId: string
    loadFile: (id: string) => Promise<Blob | undefined>
    newId: () => string
  }
): Promise<PreviewToolRunResult> => {
  const startedAt = Date.now()
  /** 同一条回复内再次保存沿用最新版本号，否则加一 */
  const versionAfter = (latest: { version: number; messageId: string } | undefined) =>
    latest === undefined
      ? { version: 1, revised: false }
      : latest.messageId === context.replyId
        ? { version: latest.version, revised: true }
        : { version: latest.version + 1, revised: false }
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {}
  const rawPath = typeof input.path === 'string' ? input.path : ''
  const cleanPath = normalizeWorkspacePath(rawPath)
  const fallbackTool =
    toolName === EDIT_FILE_TOOL_NAME
      ? 'edit_file'
      : toolName === READ_FILE_TOOL_NAME
        ? 'read_file'
        : 'present_file'

  try {
    if (!cleanPath) {
      throw new Error('path must be a non-empty relative file path (e.g. "report.md").')
    }

    if (toolName === PRESENT_FILE_TOOL_NAME) {
      if (typeof input.content !== 'string') {
        const given = Object.keys(input)
        throw new Error(
          `present_file needs the file's full text in \`content\`; this call only had: ${given.length > 0 ? given.join(', ') : 'nothing'}. Call present_file again with the complete file in \`content\`.`
        )
      }
      const content = input.content
      const mimeType = inferMimeType(
        cleanPath,
        typeof input.mime_type === 'string' ? input.mime_type : null
      )
      const blob = new Blob([content], { type: mimeType })
      if (blob.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(
          `File "${cleanPath}" (${formatSize(blob.size)}) exceeds the ${formatSize(MAX_TEXT_FILE_BYTES)} text preview limit.`
        )
      }
      const existing = collectWorkspaceArtifacts(context.records).find(
        (item) => item.path === cleanPath
      )
      const { version, revised } = versionAfter(existing?.latest)
      const title =
        typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined
      const name = getBasename(cleanPath)
      const ref: PresentedFile = {
        id: context.newId(),
        name,
        path: cleanPath,
        ...(title ? { title } : {}),
        size: blob.size,
        mimeType,
        version,
        source: 'model',
      }
      return {
        status: 'ok',
        text: `Presented "${cleanPath}" (v${version}${revised ? ', revised in this reply' : ''}, ${mimeType}, ${formatSize(blob.size)}) in the user's File Preview panel.`,
        file: {
          ref,
          blob,
          artifactKey: makeArtifactKey(cleanPath),
        },
        fileAction: {
          tool: 'present_file',
          path: cleanPath,
          ...(title ? { title } : {}),
          version,
        },
        durationMs: Date.now() - startedAt,
      }
    }

    if (toolName === EDIT_FILE_TOOL_NAME) {
      const rawEdits = Array.isArray(input.edits) ? input.edits : []
      if (rawEdits.length === 0) {
        throw new Error('edits must be a non-empty array of { old_text, new_text } objects.')
      }
      const edits: FileTextEdit[] = rawEdits.map((item, idx) => {
        if (!item || typeof item !== 'object') {
          throw new Error(`Edit #${idx + 1} must be an object with old_text and new_text.`)
        }
        const rec = item as Record<string, unknown>
        if (typeof rec.old_text !== 'string' || typeof rec.new_text !== 'string') {
          throw new Error(`Edit #${idx + 1} requires string old_text and new_text.`)
        }
        return { old_text: rec.old_text, new_text: rec.new_text }
      })

      const target = findWorkspaceFile(context.records, cleanPath, { includeUploads: false })
      if (!target) {
        throw new Error(
          `Presented file "${cleanPath}" was not found in this branch. Call present_file first.`
        )
      }
      const kind = classifyPreviewKind(target.name, target.mimeType)
      if (!isTextPreviewKind(kind)) {
        throw new Error(`Cannot text-edit non-text file "${target.path}" (${target.mimeType}).`)
      }
      const existingBlob = await context.loadFile(target.fileId)
      if (!existingBlob) {
        throw new Error(`Original content for "${target.path}" is no longer available locally.`)
      }
      const previousText = await existingBlob.text()
      const updatedText = applyTextEdits(previousText, edits, target.path)
      const blob = new Blob([updatedText], { type: target.mimeType })
      if (blob.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(
          `Updated file "${target.path}" (${formatSize(blob.size)}) exceeds the ${formatSize(MAX_TEXT_FILE_BYTES)} text preview limit.`
        )
      }
      const { version, revised } = versionAfter(target)
      const title =
        typeof input.title === 'string' && input.title.trim()
          ? input.title.trim()
          : (target.title ?? undefined)
      const ref: PresentedFile = {
        id: context.newId(),
        name: target.name,
        path: target.path,
        ...(title ? { title } : {}),
        size: blob.size,
        mimeType: target.mimeType,
        version,
        source: 'model',
      }
      return {
        status: 'ok',
        text: `Updated "${target.path}" ${revised ? `(still v${version}, revised in this reply; ` : `to v${version} (`}${edits.length} ${edits.length === 1 ? 'edit' : 'edits'}, ${formatSize(blob.size)}) in the File Preview panel.`,
        file: {
          ref,
          blob,
          artifactKey: makeArtifactKey(target.path),
        },
        fileAction: {
          tool: 'edit_file',
          path: target.path,
          ...(title ? { title } : {}),
          version,
        },
        durationMs: Date.now() - startedAt,
      }
    }

    if (toolName === READ_FILE_TOOL_NAME) {
      const target = findWorkspaceFile(context.records, cleanPath, { includeUploads: true })
      if (!target) {
        throw new Error(`File "${cleanPath}" was not found in this conversation.`)
      }
      const kind = classifyPreviewKind(target.name, target.mimeType)
      if (!isTextPreviewKind(kind)) {
        throw new Error(
          `File "${target.path}" (${target.mimeType}, ${formatSize(target.size)}) is not a UTF-8 text file.`
        )
      }
      const blob = await context.loadFile(target.fileId)
      if (!blob) {
        throw new Error(`File "${target.path}" content is not available locally.`)
      }
      const fullText = await blob.text()
      const truncated = fullText.length > MAX_READ_CHARS
      const body = truncated
        ? `${fullText.slice(0, MAX_READ_CHARS)}\n\n[Truncated after ${MAX_READ_CHARS.toLocaleString()} of ${fullText.length.toLocaleString()} characters]`
        : fullText
      return {
        status: 'ok',
        text: `File: ${target.path} (v${target.version}, ${target.mimeType}, ${formatSize(target.size)})\n\n${body}`,
        fileAction: {
          tool: 'read_file',
          path: target.path,
          version: target.version,
        },
        durationMs: Date.now() - startedAt,
      }
    }

    throw new Error(`Unknown preview tool: ${toolName}`)
  } catch (error) {
    return {
      status: 'error',
      text: error instanceof Error ? error.message : String(error),
      fileAction: {
        tool: fallbackTool,
        path: cleanPath || rawPath || 'file',
      },
      durationMs: Date.now() - startedAt,
    }
  }
}
