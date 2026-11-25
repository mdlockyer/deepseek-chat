import type { ViewportSpec } from '@deepseek-chat/lib-stage'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import { create } from 'zustand'

export type PreviewViewMode = 'preview' | 'code'

export type SessionPreviewState = {
  activeKey: string | null
  /** 用户在聊天中点击打开过的上传附件 key（用于在无产物时保持面板可切换/重开） */
  uploadKeys: string[]
  selectedFileIdByKey: Record<string, string>
  viewModeByKey: Record<string, PreviewViewMode>
  viewportByKey: Record<string, ViewportSpec | null>
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

export const createPreviewState = (panel: PanelSlot) => {
  const usePreviewStore = create<PreviewStoreState>(() => ({
    sessions: {},
  }))

  const { getState: get, setState: set } = usePreviewStore

  const getSessionPreview = (
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
  const revealPresentedFile = (
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
    const shouldOpen = options.openPanel ?? panel.getLayout().activeSessionId === sessionId
    if (shouldOpen) {
      panel.open(sessionId)
    }
  }

  /** 用户点击聊天内文件卡片或附件时打开指定文件（含特定历史版本或上传附件） */
  const openPreviewFile = (sessionId: string, key: string, fileId?: string, isLatest = true) => {
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
    panel.open(sessionId)
  }

  const selectPreviewFile = (sessionId: string, key: string) => {
    updateSessionPreview(sessionId, (prev) => ({
      ...prev,
      activeKey: key,
    }))
  }

  const openPreviewPanel = (sessionId: string, fallbackKeys: string[] = []) => {
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
    panel.open(sessionId)
  }

  const closePreviewPanel = (sessionId?: string) => {
    const targetSessionId = sessionId ?? panel.getLayout().activeSessionId
    if (!targetSessionId) {
      return
    }
    panel.close(targetSessionId)
  }

  const togglePreviewPanel = (sessionId: string, fallbackKeys: string[] = []) => {
    if (panel.isOpen(sessionId)) {
      closePreviewPanel(sessionId)
    } else {
      openPreviewPanel(sessionId, fallbackKeys)
    }
  }

  const selectPreviewVersion = (sessionId: string, key: string, fileId: string | null) => {
    updateSessionPreview(sessionId, (prev) => ({
      ...prev,
      selectedFileIdByKey: fileId
        ? { ...prev.selectedFileIdByKey, [key]: fileId }
        : omitKey(prev.selectedFileIdByKey, key),
    }))
  }

  const setPreviewViewMode = (sessionId: string, key: string, mode: PreviewViewMode) => {
    updateSessionPreview(sessionId, (prev) => ({
      ...prev,
      viewModeByKey: { ...prev.viewModeByKey, [key]: mode },
    }))
  }

  const setPreviewViewport = (sessionId: string, key: string, viewport: ViewportSpec | null) => {
    updateSessionPreview(sessionId, (prev) => ({
      ...prev,
      viewportByKey: { ...prev.viewportByKey, [key]: viewport },
    }))
  }

  const disposeSessionPreview = (sessionId: string) => {
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

  const clearAllSessionPreviews = () => {
    set({ sessions: {} })
  }

  let snapshotTrigger: (() => void) | null = null

  const registerNativePreviewSnapshotTrigger = (fn: () => void): (() => void) => {
    snapshotTrigger = fn
    return () => {
      if (snapshotTrigger === fn) {
        snapshotTrigger = null
      }
    }
  }

  const triggerNativePreviewSnapshot = () => {
    snapshotTrigger?.()
  }

  return {
    usePreviewStore,
    getSessionPreview,
    revealPresentedFile,
    openPreviewFile,
    selectPreviewFile,
    openPreviewPanel,
    closePreviewPanel,
    togglePreviewPanel,
    selectPreviewVersion,
    setPreviewViewMode,
    setPreviewViewport,
    disposeSessionPreview,
    clearAllSessionPreviews,
    registerNativePreviewSnapshotTrigger,
    triggerNativePreviewSnapshot,
  }
}

export type PreviewState = ReturnType<typeof createPreviewState>
