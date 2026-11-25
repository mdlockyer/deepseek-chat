import type { NoticePort, PanelSlot } from '@deepseek-chat/spine/ports'
import { createContext, useContext, type ComponentType } from 'react'
import type { PreviewState } from './state.js'

export type PreviewBounds = { x: number; y: number; width: number; height: number }

/**
 * The desktop host's isolated preview webview (HTML and PDF), drawn above the page like the
 * built-in browser. The web build has none and renders in an iframe / <object> instead.
 */
export type PreviewHost = {
  setContent(bytes: Uint8Array, mimeType: 'text/html' | 'application/pdf'): Promise<void>
  setBounds(bounds: PreviewBounds, zoom?: number): Promise<void>
  setVisible(visible: boolean): Promise<void>
  reload(): Promise<void>
  takeSnapshot(maxWidth?: number): Promise<{ dataUrl: string; width: number; height: number }>
  openDevtools(): Promise<void>
}

/** Renderers the app provides (Markdown, Mermaid and code highlighting live outside slices). */
export type WorkspaceViews = {
  readonly Markdown: ComponentType<{ content: string; cacheKey: string }>
  readonly Mermaid: ComponentType<{ code: string }>
  /** Highlighted HTML for `text` in the named language, or `null` to show plain text. */
  readonly useHighlight: (text: string, language: string) => string | null
  readonly FileIcon: ComponentType<{ ext: string }>
}

/** Everything the panel's components need, provided once by the panel. */
export type WorkspaceEnv = {
  readonly state: PreviewState
  readonly panel: PanelSlot
  readonly host: PreviewHost | null
  readonly views: WorkspaceViews
  readonly loadFile: (fileId: string) => Promise<Blob | undefined>
  readonly saveFile: (name: string, blob: Blob) => Promise<void>
  readonly copyText: (text: string) => Promise<boolean>
  readonly notify: NoticePort
}

const WorkspaceContext = createContext<WorkspaceEnv | null>(null)

export const WorkspaceProvider = WorkspaceContext.Provider

export const useWorkspace = (): WorkspaceEnv => {
  const env = useContext(WorkspaceContext)
  if (!env) {
    throw new Error('Workspace views must render inside the preview panel.')
  }
  return env
}
