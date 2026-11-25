import { createContext, createElement, useContext, type ComponentType } from 'react'
import type { ConversationsRuntime } from './runtime.js'

const ConversationsContext = createContext<ConversationsRuntime | null>(null)

export const ConversationsProvider = ConversationsContext.Provider

export const useConversations = (): ConversationsRuntime => {
  const runtime = useContext(ConversationsContext)
  if (!runtime) {
    throw new Error('Conversations UI components must be rendered through a slice instance.')
  }
  return runtime
}

/** Wraps a view component so it always binds to its owning slice runtime instance. */
export const bindView = <P extends object>(
  runtime: ConversationsRuntime,
  Component: ComponentType<P>
): ComponentType<P> => {
  const Bound = (props: P) =>
    createElement(ConversationsProvider, { value: runtime }, createElement(Component, props))
  Bound.displayName = `Conversations(${Component.displayName ?? Component.name ?? 'View'})`
  return Bound
}
