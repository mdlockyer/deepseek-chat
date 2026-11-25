import { HoverCard, type HoverCardTrigger } from '@deepseek-chat/lib-ui'
import type { MouseEvent } from 'react'
import { useConversations } from '../../context.js'
import { formatDate } from '../../format.js'
import { type Source } from '../../view.js'
import styles from './CitationLink.module.css'

/**
 * 正文里 [citation:N] 的数字角标：悬停预览来源，点击打开来源页面。
 * 角标使用带 link 角色的 span，可嵌入链接文字。样式由 .ds-markdown-cite 提供。
 */
export const CitationLink = ({ source }: { source: Source }) => {
  const { deps } = useConversations()
  const open = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const { openInApp } = deps.ui
    if (openInApp) {
      openInApp(source.url)
      return
    }
    window.open(source.url, '_blank', 'noopener,noreferrer')
  }
  const renderTrigger: HoverCardTrigger = ({ domRef, domProps }) => (
    <span ref={domRef} className="ds-markdown-cite" {...domProps} role="link" onClick={open}>
      {source.index}
    </span>
  )
  const date = source.publishedAt ? (formatDate(source.publishedAt, '/') ?? source.publishedAt) : ''
  return (
    <HoverCard renderTrigger={renderTrigger}>
      <a
        className={styles.anchor}
        href={source.url}
        target="_blank"
        rel="noreferrer"
        onClick={open}
      >
        <div className={styles.card}>
          <div className={styles.meta}>
            {source.siteName ? <span className={styles.siteName}>{source.siteName}</span> : null}
            {source.siteName && date ? <span className={styles.divider} /> : null}
            {date ? <span className={styles.date}>{date}</span> : null}
          </div>
          <div className={styles.title}>{source.title}</div>
          {source.snippet ? <div className={styles.snippet}>{source.snippet}</div> : null}
        </div>
      </a>
    </HoverCard>
  )
}
