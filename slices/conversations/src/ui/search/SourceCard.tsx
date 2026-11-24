import clsx from 'clsx'
import { deps } from '../../env.js'
import { formatDate } from '../../format.js'
import { type Source } from '../../view.js'
import { SiteLogo } from './SiteLogo.js'
import styles from './SourceCard.module.css'

/** 显示为 YYYY/MM/DD；无法解析的日期原样显示 */
const formatPublishedAt = (value: string | null) => (value ? (formatDate(value, '/') ?? value) : '')

/**
 * 来源卡片：引用角标（可选）、真实站点图标（无图标时省略，避免空占位链接图标）、站点名、日期、标题与摘要。
 */
export const SourceCard = ({
  source,
  citationIndex,
  className,
}: {
  source: Source
  citationIndex?: number
  className?: string
}) => {
  const date = formatPublishedAt(source.publishedAt)
  return (
    <a
      className={styles.anchor}
      href={source.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        const { openInApp } = deps().ui
        if (openInApp && /^https?:\/\//i.test(source.url)) {
          event.preventDefault()
          openInApp(source.url)
        }
      }}
    >
      <div className={clsx(styles.card, className)}>
        <div className={styles.meta}>
          {citationIndex !== undefined ? (
            <span className={styles.citationBadge}>{citationIndex}</span>
          ) : null}
          {source.siteIcon ? <SiteLogo url={source.siteIcon} className={styles.siteIcon} /> : null}
          {source.siteName ? <span className={styles.siteName}>{source.siteName}</span> : null}
          {source.siteName && date ? <span className={styles.divider} /> : null}
          {date ? <span className={styles.date}>{date}</span> : null}
        </div>
        <div className={styles.title}>{source.title}</div>
        {source.snippet ? <div className={styles.snippet}>{source.snippet}</div> : null}
      </div>
    </a>
  )
}
