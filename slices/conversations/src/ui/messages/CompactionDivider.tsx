import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconPanelContractOutline14,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { memo, useState } from 'react'
import { computeCompactionPolicy } from '../../compaction/budget.js'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'
import type { CompactionCheckpoint } from '../../types.js'
import { ChatMarkdown as Markdown } from './ChatMarkdown.js'
import styles from './CompactionDivider.module.css'

export const formatCompactTokenCount = (tokens: number): string =>
  tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(Math.max(0, Math.round(tokens)))

/** Quiet horizontal transcript divider marking a branch-anchored compaction checkpoint. */
export const CompactionDivider = memo(function CompactionDivider({
  checkpoint,
}: {
  checkpoint: CompactionCheckpoint
}) {
  const t = useTranslate()
  const { provider } = useConversations()
  const [expanded, setExpanded] = useState(false)

  const policy = computeCompactionPolicy(provider.modelSpec(provider.defaultModel))
  const line = formatCompactTokenCount(policy.line)
  const before = formatCompactTokenCount(checkpoint.tokensBefore)
  const after = formatCompactTokenCount(checkpoint.tokensAfter)

  const descriptionKey =
    checkpoint.trigger === 'manual'
      ? 'compactionDividerSummaryManual'
      : checkpoint.trigger === 'betweenRounds'
        ? 'compactionDividerSummaryBetweenRounds'
        : checkpoint.trigger === 'fit'
          ? 'compactionDividerSummaryFit'
          : checkpoint.trigger === 'overflow'
            ? 'compactionDividerSummaryOverflow'
            : 'compactionDividerSummaryAuto'

  return (
    <div className={styles.wrapper} data-compaction-divider={checkpoint.id}>
      <div className={styles.header}>
        <span className={styles.rule} aria-hidden="true" />
        <button
          type="button"
          className={clsx(styles.toggle, expanded && styles.toggleExpanded)}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className={styles.icon} aria-hidden="true">
            <IconPanelContractOutline14 />
          </span>
          <span className={styles.label}>{t('contextCompacted')}</span>
          <span className={styles.chevron} aria-hidden="true">
            {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </button>
        <span className={styles.rule} aria-hidden="true" />
      </div>

      {expanded ? (
        <div className={styles.panel}>
          <p className={styles.meta}>{t(descriptionKey, { line, before, after })}</p>
          <div className={styles.summary}>
            <Markdown
              content={checkpoint.summary}
              loading={false}
              cacheKey={`checkpoint-${checkpoint.id}`}
              disableLink={false}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
})
