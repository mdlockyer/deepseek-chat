/**
 * The conversations slice's view of the right-hand panels: workspace files, the built-in browser
 * and its own search results.
 */
import type {
  ChatFile,
  ChatPanels,
  ConversationsSlice,
  Message,
} from '@deepseek-chat/slice-conversations'
import { getVisibleMessages } from '@deepseek-chat/slice-conversations'
import {
  collectWorkspaceArtifacts,
  makeArtifactKey,
  makeUploadPreviewKey,
  normalizeWorkspacePath,
} from '@deepseek-chat/slice-workspace-files'
import { useMemo } from 'react'
import { browser } from './composition.js'
import { toFileRecords } from './fileRecords.js'
import { createPanelSlot } from './rightPanel/panelSlot.js'
import { getActiveRightPanel, useSidePanelStore } from './rightPanel/state.js'
import { workspaceFiles } from './workspaceFiles.js'

const keyOf = (file: ChatFile) =>
  file.kind === 'upload'
    ? makeUploadPreviewKey(file.fileId)
    : makeArtifactKey(normalizeWorkspacePath(file.file.path ?? file.file.name) || file.file.name)

/** The latest version's file id of the artifact at `key`, or `fallback`. */
const latestFileId = (messages: readonly Message[], key: string, fallback: string) =>
  collectWorkspaceArtifacts(toFileRecords(messages)).find((item) => item.key === key)?.latest
    .fileId ?? fallback

const useActivePanel = (sessionId: string) =>
  useSidePanelStore((state) => getActiveRightPanel(sessionId, state))

/** `chat()` gives the slice instance once it exists (the two are created together). */
export const createChatPanels = (
  chat: () => ConversationsSlice,
  options: { browser: boolean }
): ChatPanels => ({
  files: {
    useIsShown: (sessionId, file) => {
      const activePanel = useActivePanel(sessionId)
      const preview = workspaceFiles.useSession(sessionId)
      const messages = chat().useChatMessages(sessionId)
      const key = keyOf(file)
      const fileId = file.kind === 'upload' ? file.fileId : file.file.id
      const latest = useMemo(() => latestFileId(messages, key, fileId), [messages, key, fileId])
      if (activePanel !== 'preview' || preview.activeKey !== key) {
        return false
      }
      if (file.kind === 'upload') {
        return true
      }
      const pinned = preview.selectedFileIdByKey[key]
      return pinned ? pinned === fileId : latest === fileId
    },
    open: (sessionId, file) => {
      const key = keyOf(file)
      if (file.kind === 'upload') {
        workspaceFiles.openFile(sessionId, key, file.fileId, true)
        return
      }
      const latest = latestFileId(chat().getChatMessages(sessionId), key, file.file.id)
      workspaceFiles.openFile(sessionId, key, file.file.id, latest === file.file.id)
    },
    useToggle: (session) => {
      const open = useActivePanel(session.id) === 'preview'
      const hasActiveFile = workspaceFiles.useSession(session.id).activeKey !== null
      const keys = useMemo(
        () =>
          collectWorkspaceArtifacts(toFileRecords(getVisibleMessages(session))).map((a) => a.key),
        [session]
      )
      return {
        visible: open || keys.length > 0 || hasActiveFile,
        open,
        toggle: () => workspaceFiles.togglePanel(session.id, keys),
      }
    },
  },
  browser: options.browser
    ? {
        useToggle: (sessionId) => ({
          open: useActivePanel(sessionId) === 'browser',
          toggle: () => void browser.togglePanel(sessionId),
        }),
      }
    : null,
  search: createPanelSlot('search'),
})
