import type { StageHost } from '@deepseek-chat/spine/ports'
import { setRightPanelResizing, setRightPanelStageSize, useSidePanelStore } from './state.js'

/** 右侧面板提供给视口舞台的宿主接口：共享舞台尺寸与「正在调整大小」标记 */
export const stageHost: StageHost = {
  useStageSize: () => useSidePanelStore((state) => state.stageSize),
  setStageSize: setRightPanelStageSize,
  setResizing: setRightPanelResizing,
  isResizing: () => useSidePanelStore.getState().panelResizing,
}
