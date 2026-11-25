import type { CSSProperties } from 'react'
import clsx from 'clsx'
import { IconLinkOutline14 } from '@deepseek-chat/lib-ui'
import { FallbackImage } from './FallbackImage.js'
import styles from './SiteLogo.module.css'

/** 站点图标：加载中显示骨架，加载失败时显示链接图标 */
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
