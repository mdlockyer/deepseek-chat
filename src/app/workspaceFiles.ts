/**
 * workspace-files slice instance. Kept apart from composition.ts because its view slots reach
 * Markdown/Mermaid, which import the composition root themselves.
 */
import { createWorkspaceFilesSlice } from '@deepseek-chat/slice-workspace-files'
import { desktopPreviewHost, isDesktopApp, saveFileWithDialog } from '../platform/desktop.js'
import { loadFile } from '../services/chat/db.js'
import { copyText } from '../utils/clipboard.js'
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
