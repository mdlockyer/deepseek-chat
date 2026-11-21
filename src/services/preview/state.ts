import { create } from 'zustand'
import {
  closeRightPanel,
  getActiveRightPanel,
  openRightPanel,
  useSidePanelStore,
} from '../../app/rightPanel/state.js'
import type { BrowserViewportSpec } from '@deepseek-chat/spine/design'

export type PreviewViewMode = 'preview' | 'code'

export type SessionPreviewState = {
  activeKey: string | null
  /** 用户在聊天中点击打开过的上传附件 key（用于在无产物时保持面板可切换/重开） */
  uploadKeys: string[]
  selectedFileIdByKey: Record<string, string>
  viewModeByKey: Record<string, PreviewViewMode>
  viewportByKey: Record<string, BrowserViewportSpec | null>
}

export const EMPTY_SESSION_PREVIEW_STATE: SessionPreviewState = {
  activeKey: null,
  uploadKeys: [],
  selectedFileIdByKey: {},
  viewModeByKey: {},
  viewportByKey: {},
}

type PreviewStoreState = {
  sessions: Record<string, SessionPreviewState>
}

export const usePreviewStore = create<PreviewStoreState>(() => ({
  sessions: {},
}))

const { getState: get, setState: set } = usePreviewStore

export const getSessionPreview = (
  state: Pick<PreviewStoreState, 'sessions'>,
  sessionId: string | null | undefined
): SessionPreviewState =>
  sessionId && Object.hasOwn(state.sessions, sessionId)
    ? state.sessions[sessionId]
    : EMPTY_SESSION_PREVIEW_STATE

const omitKey = <T>(record: Record<string, T>, keyToOmit: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== keyToOmit))

const updateSessionPreview = (
  sessionId: string,
  updater: (prev: SessionPreviewState) => SessionPreviewState
) => {
  set((state) => {
    const prev = getSessionPreview(state, sessionId)
    const next = updater(prev)
    if (next === prev) {
      return state
    }
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: next,
      },
    }
  })
}

/** 模型/Python 生成或更新文件后在预览面板打开（仅当该会话正在前台浏览时拉起面板） */
export const revealPresentedFile = (
  sessionId: string,
  key: string,
  options: { openPanel?: boolean; defaultMode?: PreviewViewMode } = {}
) => {
  updateSessionPreview(sessionId, (prev) => ({
    ...prev,
    activeKey: key,
    selectedFileIdByKey: omitKey(prev.selectedFileIdByKey, key),
    ...(options.defaultMode && !Object.hasOwn(prev.viewModeByKey, key)
      ? { viewModeByKey: { ...prev.viewModeByKey, [key]: options.defaultMode } }
      : {}),
  }))
  const shouldOpen = options.openPanel ?? useSidePanelStore.getState().activeSessionId === sessionId
  if (shouldOpen) {
    openRightPanel(sessionId, 'preview')
  }
}

/** 用户点击聊天内文件卡片或附件时打开指定文件（含特定历史版本或上传附件） */
export const openPreviewFile = (
  sessionId: string,
  key: string,
  fileId?: string,
  isLatest = true
) => {
  updateSessionPreview(sessionId, (prev) => {
    const isUpload = key.startsWith('upload:')
    const uploadKeys =
      isUpload && !prev.uploadKeys.includes(key) ? [...prev.uploadKeys, key] : prev.uploadKeys
    const nextPins =
      fileId && !isLatest
        ? { ...prev.selectedFileIdByKey, [key]: fileId }
        : omitKey(prev.selectedFileIdByKey, key)
    return {
      ...prev,
      activeKey: key,
      uploadKeys,
      selectedFileIdByKey: nextPins,
    }
  })
  openRightPanel(sessionId, 'preview')
}

export const selectPreviewFile = (sessionId: string, key: string) => {
  updateSessionPreview(sessionId, (prev) => ({
    ...prev,
    activeKey: key,
  }))
}

export const openPreviewPanel = (sessionId: string, fallbackKeys: string[] = []) => {
  const prev = getSessionPreview(get(), sessionId)
  const validSet = new Set([...fallbackKeys, ...prev.uploadKeys])
  if (
    (!prev.activeKey || (validSet.size > 0 && !validSet.has(prev.activeKey))) &&
    fallbackKeys.length > 0
  ) {
    updateSessionPreview(sessionId, (curr) => ({
      ...curr,
      activeKey: fallbackKeys.at(-1) ?? fallbackKeys[0] ?? null,
    }))
  }
  openRightPanel(sessionId, 'preview')
}

export const closePreviewPanel = (sessionId?: string) => {
  const targetSessionId = sessionId ?? useSidePanelStore.getState().activeSessionId
  if (!targetSessionId) {
    return
  }
  closeRightPanel(targetSessionId, 'preview')
}

export const togglePreviewPanel = (sessionId: string, fallbackKeys: string[] = []) => {
  if (getActiveRightPanel(sessionId) === 'preview') {
    closePreviewPanel(sessionId)
  } else {
    openPreviewPanel(sessionId, fallbackKeys)
  }
}

export const selectPreviewVersion = (sessionId: string, key: string, fileId: string | null) => {
  updateSessionPreview(sessionId, (prev) => ({
    ...prev,
    selectedFileIdByKey: fileId
      ? { ...prev.selectedFileIdByKey, [key]: fileId }
      : omitKey(prev.selectedFileIdByKey, key),
  }))
}

export const setPreviewViewMode = (sessionId: string, key: string, mode: PreviewViewMode) => {
  updateSessionPreview(sessionId, (prev) => ({
    ...prev,
    viewModeByKey: { ...prev.viewModeByKey, [key]: mode },
  }))
}

export const setPreviewViewport = (
  sessionId: string,
  key: string,
  viewport: BrowserViewportSpec | null
) => {
  updateSessionPreview(sessionId, (prev) => ({
    ...prev,
    viewportByKey: { ...prev.viewportByKey, [key]: viewport },
  }))
}

export const disposeSessionPreview = (sessionId: string) => {
  set((state) => {
    if (!Object.hasOwn(state.sessions, sessionId)) {
      return state
    }
    return {
      sessions: Object.fromEntries(
        Object.entries(state.sessions).filter(([key]) => key !== sessionId)
      ),
    }
  })
}

export const clearAllSessionPreviews = () => {
  set({ sessions: {} })
}

let snapshotTrigger: (() => void) | null = null

export const registerNativePreviewSnapshotTrigger = (fn: () => void): (() => void) => {
  snapshotTrigger = fn
  return () => {
    if (snapshotTrigger === fn) {
      snapshotTrigger = null
    }
  }
}

export const triggerNativePreviewSnapshot = () => {
  snapshotTrigger?.()
}
