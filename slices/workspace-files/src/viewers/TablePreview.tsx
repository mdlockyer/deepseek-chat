import { useMemo, useState } from 'react'
import { workspaceMessages } from '../messages.js'
import { getTableDelimiter, parseDelimitedText } from '../fileKinds.js'
import styles from '../PreviewPanel.module.css'

const MAX_TABLE_ROWS = 2_000

/** CSV / TSV 表格预览：支持字段引号解析、关键字行过滤与粘性表头 */
export const TablePreview = ({
  text,
  name,
  mimeType,
}: {
  text: string
  name: string
  mimeType: string
}) => {
  const t = workspaceMessages.useTranslate()
  const [filter, setFilter] = useState('')
  const delimiter = getTableDelimiter(name, mimeType)

  const parsed = useMemo(
    () => parseDelimitedText(text, delimiter, MAX_TABLE_ROWS),
    [text, delimiter]
  )

  const visibleRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) {
      return parsed.rows
    }
    return parsed.rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(q)))
  }, [parsed.rows, filter])

  return (
    <div className={styles.tableContainer}>
      <div className={styles.tableSubbar}>
        <input
          type="search"
          className={styles.tableSearch}
          placeholder={t('previewTableFilterPlaceholder')}
          aria-label={t('previewTableFilterPlaceholder')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className={styles.tableStats}>
          {t('previewTableRowsCount', { count: visibleRows.length })}
        </span>
      </div>
      <div className={styles.tableScroll}>
        {parsed.headers.length > 0 ? (
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th className={styles.rowIndexCol}>#</th>
                {parsed.headers.map((header, idx) => (
                  <th key={idx}>{header || `Col ${idx + 1}`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <td className={styles.rowIndexCol}>{rowIndex + 1}</td>
                  {row.map((cell, colIndex) => (
                    <td key={colIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {parsed.truncated ? (
          <div className={styles.tableNotice}>
            {t('previewTableTruncated', { limit: MAX_TABLE_ROWS })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
