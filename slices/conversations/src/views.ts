import type { DeliveredFileRef } from '@deepseek-chat/lib-tools'
import type { ComponentType } from 'react'

/** Voice input in the composer and read-aloud on replies (optional: null when voice slice is unmounted). */
export type VoiceViews = {
  readonly useVoiceInput: (onTranscript: (text: string) => void) => {
    readonly status: 'idle' | 'recording' | 'transcribing'
    readonly seconds: number
    readonly available: boolean
    readonly getAnalyser: () => AnalyserNode | null
    readonly toggle: () => Promise<void> | void
    readonly cancel: () => void
  }
  readonly VoiceButton: ComponentType<{
    status: 'idle' | 'recording' | 'transcribing'
    disabled?: boolean
    seconds: number
    onClick: () => void
  }>
  readonly Spectrum: ComponentType<{ getAnalyser: () => AnalyserNode | null }>
  readonly ReadAloudButton: ComponentType<{ messageId: string; text: string }>
}

/** A file shown in a chat: one a tool delivered, or one the user attached. */
export type ChatFile =
  | { readonly kind: 'delivered'; readonly file: DeliveredFileRef }
  | { readonly kind: 'upload'; readonly fileId: string }

export type InspectionTarget = {
  readonly sessionId: string
  readonly messageId: string
  readonly tab: 'activity' | 'sources'
}

export type SettingsSection = 'general' | 'apiKey' | 'data'

/** What the chat UI needs from the app shell around it. Optional ports degrade cleanly when omitted. */
export type ConversationsViewDeps = {
  readonly voice: VoiceViews | null
  /** Optional header toggle buttons contributed by mounted slices (e.g. files, browser). */
  readonly headerActions?: readonly ComponentType<{ readonly sessionId: string }>[]
  /** Optional interactive dock rendered in place of the composer when active (e.g. ask-user). */
  readonly composerDock?: ComponentType<{
    readonly sessionId: string
    readonly onStopReply: () => void
  }>
  readonly useHasComposerDock?: (sessionId: string) => boolean
  /** Optional preview opener for delivered/uploaded files; falls back to `saveFile` when absent. */
  readonly openFile?: (sessionId: string, file: ChatFile) => void
  readonly useIsFileShown?: (sessionId: string, file: ChatFile) => boolean
  /** Optional reactive readout of the active inspector target so triggers can show pressed state. */
  readonly useActiveInspectionTarget?: () => InspectionTarget | null
  readonly openSettings: (section: SettingsSection) => void
  /** Opens a link inside the app (desktop: built-in browser); `null`: ordinary links. */
  readonly openInApp: ((url: string) => void) | null
  /** Saves a file for the user (desktop: save dialog; web: download). */
  readonly saveFile: (name: string, blob: Blob) => Promise<void>
  readonly setSiderCollapsed: (collapsed: boolean) => void
}
