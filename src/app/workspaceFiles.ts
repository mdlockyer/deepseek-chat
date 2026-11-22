/** workspace-files slice instance with its app-provided ports and view slots. */
import { createWorkspaceFilesSlice } from '@deepseek-chat/slice-workspace-files'
import { copyText } from '@deepseek-chat/spine/design'
import { desktopPreviewHost, isDesktopApp, saveFileWithDialog } from '../platform/desktop.js'
import { loadFile } from '@deepseek-chat/slice-conversations'
import { createId } from '../utils/id.js'
import { spine } from './composition.js'
import { createPanelSlot } from './rightPanel/panelSlot.js'
import { workspaceViews } from './workspaceViews.js'

const triggerBrowserDownload = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const saveFile = async (name: string, blob: Blob) => {
  if (isDesktopApp) {
    await saveFileWithDialog(name, blob)
    return
  }
  triggerBrowserDownload(name, blob)
}

export const workspaceFiles = createWorkspaceFilesSlice({
  log: spine,
  panel: createPanelSlot('preview'),
  host: isDesktopApp ? desktopPreviewHost : null,
  loadFile,
  saveFile,
  copyText,
  views: workspaceViews,
  newId: createId,
})
