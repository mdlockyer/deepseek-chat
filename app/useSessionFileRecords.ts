import type { FileRecord } from '@deepseek-chat/slice-workspace-files'
import { useMemo } from 'react'
import { conversations } from './conversations.js'
import { toFileRecords } from './fileRecords.js'

/** 会话可见分支的文件记录；会话未加载时为空 */
export const useSessionFileRecords = (sessionId: string | null): readonly FileRecord[] => {
  const messages = conversations.useChatMessages(sessionId)
  return useMemo(() => toFileRecords(messages), [messages])
}
