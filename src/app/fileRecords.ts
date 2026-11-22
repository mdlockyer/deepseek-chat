import type { FileRecord } from '@deepseek-chat/slice-workspace-files'
import type { Message } from '@deepseek-chat/slice-conversations'

/**
 * 把可见分支上的消息转换为 workspace-files 的文件记录（按对话顺序）：
 * 回复里工具结果携带的文件，以及用户上传的附件。
 */
export const toFileRecords = (messages: readonly Message[]): FileRecord[] => {
  const records: FileRecord[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      for (const file of message.files) {
        records.push({
          kind: 'upload',
          fileId: file.id,
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
          messageId: message.id,
          createdAt: message.createdAt,
        })
      }
      continue
    }
    const toolNames = new Map<string, string>()
    for (const block of message.blocks) {
      if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name)
      }
    }
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || !block.files?.length) {
        continue
      }
      const producedBy = toolNames.get(block.tool_use_id)
      for (const ref of block.files) {
        records.push({
          kind: 'presented',
          fileId: ref.id,
          name: ref.name,
          ...(ref.path !== undefined ? { path: ref.path } : {}),
          ...(ref.title !== undefined ? { title: ref.title } : {}),
          size: ref.size,
          mimeType: ref.mimeType,
          ...(ref.version !== undefined ? { version: ref.version } : {}),
          ...(ref.source !== undefined ? { source: ref.source } : {}),
          ...(producedBy !== undefined ? { producedBy } : {}),
          messageId: message.id,
          createdAt: message.createdAt,
        })
      }
    }
  }
  return records
}
