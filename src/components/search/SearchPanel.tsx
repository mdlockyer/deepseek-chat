import { useRef, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import panelStyles from '../sidePanel/SidePanel.module.css'
import styles from './SearchPanel.module.css'

/** 右侧「搜索结果」面板内容（托管在共享 SidePanel 壳层内） */
export const SearchPanel = ({ topActions }: { topActions?: ReactNode } = {}) => {
  const t = useTranslate()
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  // 退场滑出期间保留最后一批结果
  const lastSourcesRef = useRef(sources)
  if (entry) {
    lastSourcesRef.current = sources
  }
  const shownSources = entry ? sources : lastSourcesRef.current
  return (
    <>
      <div className={styles.header} data-tauri-drag-region>
        <div role="heading" className={styles.title} data-tauri-drag-region>
          {t('searchResult')}
        </div>
        <div className={panelStyles.topActions}>
          {topActions}
          <IconButton
            size="xs"
            icon={<IconCloseOutline16 />}
            tooltip={t('close')}
            tooltipPlacement="bottom"
            aria-label={t('close')}
            onClick={closeSearchPanel}
          />
        </div>
      </div>
      <div className={styles.content}>
        {shownSources.map((source) => (
          <SourceCard key={source.url} source={source} className={styles.item} />
        ))}
      </div>
    </>
  )
}
