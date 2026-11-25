import type { PanelSlot } from '@deepseek-chat/spine/ports'
import type { ComponentType } from 'react'
import type { PresentedFileRef, Session } from './types.js'

/** Voice input in the composer and read-aloud on replies (the voice slice). */
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
  readonly stopReadAloud: () => void
}

/** A file shown in a chat: one a tool presented, or one the user attached. */
export type ChatFile =
  | { readonly kind: 'presented'; readonly file: PresentedFileRef }
  | { readonly kind: 'upload'; readonly fileId: string }

/** The right-hand panels other slices show for a chat. */
export type ChatPanels = {
  readonly files: {
    /** Whether the file panel currently shows this file. */
    readonly useIsShown: (sessionId: string, file: ChatFile) => boolean
    readonly open: (sessionId: string, file: ChatFile) => void
    /** The header toggle: hidden when the chat has no files and the panel was never opened. */
    readonly useToggle: (session: Session) => {
      readonly visible: boolean
      readonly open: boolean
      readonly toggle: () => void
    }
  }
  /** The built-in browser's header toggle; `null` where there is no browser (web). */
  readonly browser: {
    readonly useToggle: (sessionId: string) => {
      readonly open: boolean
      readonly toggle: () => void
    }
  } | null
  /** This slice's slot for the unified turn activity & sources inspector. */
  readonly activity: PanelSlot
}

export type SettingsSection = 'general' | 'apiKey' | 'data'

/** What the chat UI needs from the app around it. */
export type ConversationsViewDeps = {
  readonly voice: VoiceViews
  readonly panels: ChatPanels
  readonly openSettings: (section: SettingsSection) => void
  /** Opens a link inside the app (desktop: the built-in browser); `null`: ordinary links. */
  readonly openInApp: ((url: string) => void) | null
  /** Saves a file for the user (desktop: save dialog; web: download). */
  readonly saveFile: (name: string, blob: Blob) => Promise<void>
  readonly setSiderCollapsed: (collapsed: boolean) => void
}
