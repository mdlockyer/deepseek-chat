import {
  IconCheckOutline16,
  IconCopyOutline16,
  SegmentedControl,
  copyText,
  useUiNotice,
} from '@deepseek-chat/lib-ui'
import { memo, useState } from 'react'
import { useHighlightedHtml } from './highlight.js'
import { markdownMessages } from './messages.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import styles from './CodeBlock.module.css'

const CodeInfoRow = ({
  code,
  infostring,
  showDiagram,
  onToggleDiagram,
}: {
  code: string
  infostring: string
  showDiagram: boolean
  onToggleDiagram?: () => void
}) => {
  const t = markdownMessages.useTranslate()
  const notice = useUiNotice()
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.container}>
      {onToggleDiagram ? (
        <SegmentedControl
          ariaLabel={t('mermaidSwitchLabel')}
          value={showDiagram ? 'diagram' : 'code'}
          options={[
            { value: 'diagram', label: t('mermaidDiagram') },
            { value: 'code', label: t('mermaidCode') },
          ]}
          onChange={(mode) => {
            if ((mode === 'diagram') !== showDiagram) {
              onToggleDiagram()
            }
          }}
        />
      ) : (
        <span className={styles.name}>{infostring}</span>
      )}
      <button
        type="button"
        className={styles.button}
        onClick={async () => {
          if (!(await copyText(code))) {
            notice.show({ text: markdownMessages.lazy('copyFailed') })
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        <span>{t(copied ? 'copied' : 'copy')}</span>
      </button>
    </div>
  )
}

export const CodeBlock = memo(function CodeBlock({
  code,
  infostring,
  loading = false,
}: {
  code: string
  infostring: string
  loading?: boolean
}) {
  const isMermaid = infostring.toLowerCase() === 'mermaid'
  const [showDiagram, setShowDiagram] = useState(true)
  const renderedHtml = useHighlightedHtml(code, infostring) ?? ''
  return (
    <div className="md-code-block">
      <div className="md-code-block-banner">
        <CodeInfoRow
          code={code}
          infostring={infostring}
          showDiagram={showDiagram}
          onToggleDiagram={isMermaid ? () => setShowDiagram((show) => !show) : undefined}
        />
      </div>
      {isMermaid && showDiagram ? (
        <MermaidDiagram code={code} loading={loading} />
      ) : (
        <pre dangerouslySetInnerHTML={{ __html: renderedHtml }}></pre>
      )}
    </div>
  )
})
