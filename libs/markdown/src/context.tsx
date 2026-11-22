import { createContext, useContext, type ReactNode } from 'react'

/** A numbered source a `[citation:N]` marker in the text refers to. */
export type CitationSource = { readonly index: number }

export type RenderCitation = (source: CitationSource) => ReactNode

/** 文档级设置：图表主题；由应用在根部提供 */
const ThemeContext = createContext<{ dark: boolean }>({ dark: false })

/** Wraps the app so diagrams follow its theme. */
export const MarkdownTheme = ({ dark, children }: { dark: boolean; children: ReactNode }) => (
  <ThemeContext.Provider value={dark ? DARK : LIGHT}>{children}</ThemeContext.Provider>
)

const DARK = { dark: true }
const LIGHT = { dark: false }

export const useMarkdownDark = () => useContext(ThemeContext).dark

/** 单个文档内的角标渲染方式（由 Markdown 的 renderCitation 提供） */
export const CitationContext = createContext<RenderCitation | null>(null)
