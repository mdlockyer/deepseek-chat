import { createContext, useContext, type ReactNode } from 'react'

/** A numbered source a `[citation:N]` marker in the text refers to. */
export type CitationSource = { readonly index: number }

export type RenderCitation = (source: CitationSource) => ReactNode

const ThemeContext = createContext<{ dark: boolean }>({ dark: false })

const DARK = { dark: true }
const LIGHT = { dark: false }

/** Wraps the app so diagrams and code syntax highlighting follow its theme. */
export const MarkdownTheme = ({ dark, children }: { dark: boolean; children: ReactNode }) => (
  <ThemeContext.Provider value={dark ? DARK : LIGHT}>
    <div data-markdown-theme={dark ? 'dark' : 'light'} style={{ display: 'contents' }}>
      {children}
    </div>
  </ThemeContext.Provider>
)

export const useMarkdownDark = () => useContext(ThemeContext).dark

/** Per-document citation renderer provided by `Markdown`. */
export const CitationContext = createContext<RenderCitation | null>(null)
