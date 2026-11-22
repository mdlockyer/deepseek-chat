import type { PanelLayout, PanelSlot } from '@deepseek-chat/spine/design'
import { stageHost } from './stageHost.js'
import {
  closeRightPanel,
  getActiveRightPanel,
  openRightPanel,
  setRightPanelAnimating,
  useSidePanelStore,
  type RightPanelKind,
} from './state.js'

type PanelState = ReturnType<typeof useSidePanelStore.getState>

const toLayout = (state: PanelState): PanelLayout => ({
  activeSessionId: state.activeSessionId,
  animating: state.panelAnimating,
  resizing: state.panelResizing,
  overlayLocked: state.overlayLocks > 0,
  width: state.width,
})

/** 右侧面板中某一类面板的栏位，交给对应 slice 使用 */
export const createPanelSlot = (kind: RightPanelKind): PanelSlot => ({
  ...stageHost,
  isOpen: (sessionId) => getActiveRightPanel(sessionId) === kind,
  open: (sessionId) => openRightPanel(sessionId, kind),
  close: (sessionId) => closeRightPanel(sessionId, kind),
  setAnimating: setRightPanelAnimating,
  getLayout: () => toLayout(useSidePanelStore.getState()),
  subscribe: (listener) => useSidePanelStore.subscribe(() => listener()),
  useLayout: (select) => useSidePanelStore((state) => select(toLayout(state))),
})
