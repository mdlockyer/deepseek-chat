import { memo, useMemo, type ReactElement, type ReactNode } from 'react'
import { CitationContext, type CitationSource, type RenderCitation } from './context.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { toMdAst } from './parse.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

export type MarkdownProps<S extends CitationSource> = {
  content: string
  /** 内容仍在流式生成：节流渲染，图表不显示错误 */
  loading: boolean
  cacheKey: string
  className?: string
  /** 链接只保留文字 */
  disableLink: boolean
  /** 传入时把正文里的 [citation:N] 换成对应来源的角标，找不到来源的去掉 */
  sources?: readonly S[]
  /** 角标的渲染方式；应保持引用稳定 */
  renderCitation?: (source: S) => ReactNode
  /** 每次渲染内容更新后调用（例如滚到底部）；应保持引用稳定 */
  onRendered?: () => void
}

const noop = () => {}

/**
 * 渲染链路：节流 → 解析 AST → 渲染。
 * 传入 sources 时把正文里的 [citation:N] 渲染为角标。
 */
const MarkdownImpl = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink,
  sources,
  renderCitation,
  onRendered,
}: MarkdownProps<CitationSource>) {
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const ast = useMemo(
    () => (throttledMarkdown ? toMdAst(throttledMarkdown, { sources, disableLink }) : null),
    [throttledMarkdown, sources, disableLink]
  )
  return ast ? (
    <CitationContext.Provider value={(renderCitation as RenderCitation | undefined) ?? null}>
      <MarkdownAstRenderer
        key={cacheKey}
        className={className}
        ast={ast}
        loading={loading}
        onUpdate={onRendered ?? noop}
      />
    </CitationContext.Provider>
  ) : null
})

export const Markdown = MarkdownImpl as <S extends CitationSource>(
  props: MarkdownProps<S>
) => ReactElement | null
