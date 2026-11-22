import type { FileRecord } from '@deepseek-chat/slice-workspace-files'
import { useMemo } from 'react'
import { getVisibleMessages } from './branches.js'
import { toFileRecords } from './fileRecords.js'
import { useChatStore } from './store.js'

const NO_RECORDS: FileRecord[] = []

/** 会话可见分支的文件记录；会话未加载时为空 */
export const useSessionFileRecords = (sessionId: string | null): readonly FileRecord[] => {
  const session = useChatStore((state) =>
    sessionId && Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]
      : undefined
  )
  return useMemo(
    () => (session ? toFileRecords(getVisibleMessages(session)) : NO_RECORDS),
    [session]
  )
}
