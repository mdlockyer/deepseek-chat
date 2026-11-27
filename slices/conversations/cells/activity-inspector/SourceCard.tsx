import clsx from 'clsx'
import type { MouseEvent } from 'react'
import { SiteLogo } from './SiteLogo.js'
import type { ActivitySource } from './types.js'
import styles from './SourceCard.module.css'

const formatPublishedAt = (value: string | null): string => {
  if (!value) {
    return ''
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return value
  }
  const date = new Date(parsed)
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
}

export const SourceCard = ({
  source,
  citationIndex,
  className,
  onOpenLink,
}: {
  source: ActivitySource
  citationIndex?: number
  className?: string
  onOpenLink?: (event: MouseEvent, url: string) => void
}) => {
  const date = formatPublishedAt(source.publishedAt)
  return (
    <a
      className={styles.anchor}
      href={source.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => onOpenLink?.(event, source.url)}
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
