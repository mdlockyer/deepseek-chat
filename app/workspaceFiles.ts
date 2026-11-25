/** workspace-files slice instance with its app-provided ports and view slots. */
import { copyText } from '@deepseek-chat/lib-ui'
import { createWorkspaceFilesSlice } from '@deepseek-chat/slice-workspace-files'
import { desktopPreviewHost, isDesktopApp } from './platform/desktop.js'
import { createId } from './utils/id.js'
import { notices, spine } from './composition.js'
import { late } from './lateBindings.js'
import { createPanelSlot } from './rightPanel/panelSlot.js'
import { saveFile } from './saveFile.js'
import { workspaceViews } from './workspaceViews.js'

export const workspaceFiles = createWorkspaceFilesSlice({
  log: spine,
  panel: createPanelSlot('preview'),
  host: isDesktopApp ? desktopPreviewHost : null,
  // conversations 的文件库（conversations 在本 slice 之后创建）
  loadFile: (fileId) => late.loadFile(fileId),
  saveFile,
  copyText,
  views: workspaceViews,
  notify: notices,
  newId: createId,
})
