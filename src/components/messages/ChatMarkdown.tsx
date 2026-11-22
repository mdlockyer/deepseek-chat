import { Markdown } from '@deepseek-chat/lib-markdown'
import type { Source } from '../../services/chat/view.js'
import { CitationLink } from '../search/CitationLink.js'
import { useScrollToBottom } from './scrollContext.js'

const renderCitation = (source: Source) => <CitationLink source={source} />

/** 聊天中的 Markdown：内容更新后请求滚到底部，[citation:N] 渲染为来源角标 */
export const ChatMarkdown = (props: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) => <Markdown {...props} renderCitation={renderCitation} onRendered={useScrollToBottom()} />
