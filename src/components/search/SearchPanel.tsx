import clsx from 'clsx'
import { useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { PANEL_DURATION_MS, usePresence } from '../../utils/usePresence.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import styles from './SearchPanel.module.css'

/** 右侧「搜索结果」面板 */
export const SearchPanel = () => {
  const t = useTranslate()
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  // 退场滑出期间保留最后一批结果
  const lastSourcesRef = useRef(sources)
  if (entry) {
    lastSourcesRef.current = sources
  }
  const { mounted, exiting } = usePresence(entry !== null, PANEL_DURATION_MS)
  if (!mounted) {
    return null
  }
  const shownSources = entry ? sources : lastSourcesRef.current
  return (
    <aside className={clsx(styles.panel, exiting && styles.panelExiting)}>
      <div className={styles.header}>
        <div role="heading" className={styles.title}>
          {t('searchResult')}
        </div>
        <IconButton
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={closeSearchPanel}
        />
      </div>
      <div className={styles.content}>
        {shownSources.map((source) => (
          <SourceCard key={source.url} source={source} className={styles.item} />
        ))}
      </div>
    </aside>
  )
}
