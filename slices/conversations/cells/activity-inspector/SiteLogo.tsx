import { IconLinkOutline14 } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import type { CSSProperties } from 'react'
import { FallbackImage } from './FallbackImage.js'
import styles from './SiteLogo.module.css'

export const SiteLogo = ({
  url,
  className,
  style,
}: {
  url: string | null
  className?: string
  style?: CSSProperties
}) => (
  <FallbackImage
    key={url ?? ''}
    src={url ?? ''}
    fallback={<IconLinkOutline14 />}
    className={clsx(styles.logo, className)}
    imgClassName={styles.img}
    skeletonClassName={styles.placeholder}
    fallbackClassName={clsx(styles.placeholder, styles.fallback)}
    style={style}
  />
)
