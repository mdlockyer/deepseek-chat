import { useTranslate } from '../../messages.js'
import clsx from 'clsx'
import { memo, useEffect, useState, type ReactNode } from 'react'
import {
  IconBrowseOutline16,
  IconBrowserOutline14,
  IconBrowseWarningOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCheckedOutline14,
  IconCloseFill14,
  IconLinkOutline16,
  IconRightUpOutline14,
  IconSearchOutline16,
  IconSearchWarningOutline16,
  IconThinkOutline16,
} from '@deepseek-chat/spine/design'
import { formatSize, getExtension } from '../../attachments.js'
import { loadFile } from '../../db.js'
import { type AssistantMessage, type PresentedFileRef } from '../../types.js'
import { deps } from '../../env.js'
import {
  getAreaTitle,
  isDeepSearchKind,
  isImageSearchKind,
  type AskStep,
  type BrowserStep,
  type FileStep,
  type FindStep,
  type OpenStep,
  type PageItem,
  type PythonStep,
  type ReadLinkStep,
  type ReplyView,
  type SearchStep,
  type Source,
  type Step,
} from '../../view.js'
import { Tooltip } from '@deepseek-chat/spine/design'
import { FileCard } from '../files/FileCard.js'
import { ChatMarkdown as Markdown } from './ChatMarkdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import styles from './ReplyArea.module.css'
import './thinking.markdown.css'

/** 进行中时每秒刷新，用于思考用时与搜索词轮播 */
const useTicker = (active: boolean, interval: number) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setInterval(() => setTick((value) => value + 1), interval)
    return () => clearInterval(timer)
  }, [active, interval])
  return tick
}

const getAreaTitleIcon = (view: ReplyView, active: boolean): ReactNode => {
  if (!active) {
    return <IconThinkOutline16 />
  }
  const last = view.steps.at(-1)
  if (last?.type === 'search' && last.status === 'wip') {
    return <IconSearchOutline16 />
  }
  if (
    (last?.type === 'open' && last.pages.some((page) => page.status === 'wip')) ||
    (last?.type === 'find' && last.patterns.some((item) => item.status === 'wip')) ||
    (last?.type === 'file' && last.status === 'wip')
  ) {
    return <IconBrowseOutline16 />
  }
  if (last?.type === 'browser' && last.status === 'wip') {
    return <IconBrowserOutline14 />
  }
  if (last?.type === 'read_link' && last.links.some((link) => link.status === 'wip')) {
    return <IconLinkOutline16 />
  }
  return <IconThinkOutline16 />
}

/**
 * 思考与工具步骤的时间线：
 * 开启深度思考时带可折叠的标题（正在思考 / 正在搜索 / 正在浏览网页 / 已思考（用时 N 秒））；
 * 未开启时只有工具步骤（如普通搜索的「已阅读 N 个网页」）。
 */
export const ReplyArea = memo(function ReplyArea({
  message,
  view,
  streaming,
  hasResponse,
}: {
  message: AssistantMessage
  view: ReplyView
  streaming: boolean
  hasResponse: boolean
}) {
  useTranslate()
  const [open, setOpen] = useState(false)
  const titleActive = streaming && !hasResponse
  useTicker(titleActive, 1000)
  if (view.steps.length === 0 && !(message.thinking && streaming)) {
    return null
  }
  // 未记录请求开关时，按是否有思考内容显示标题。
  const thinking = message.thinking ?? view.steps.some((step) => step.type === 'thinking')
  const title = thinking ? getAreaTitle(view, streaming, Date.now(), hasResponse) : null
  const stopped = !streaming && !hasResponse
  const visibleSteps =
    open || !title
      ? view.steps
      : view.steps.filter((step) => step.type !== 'thinking' && step.type !== 'text')
  return (
    <div className={styles.area}>
      {title ? (
        <div className={styles.title} onClick={() => setOpen((value) => !value)}>
          <span className={clsx(styles.titleIcon, stopped && styles.stoppedIcon)}>
            {getAreaTitleIcon(view, titleActive)}
          </span>
          <span className={clsx(styles.titleText, titleActive && styles.shimmer)}>{title}</span>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </div>
      ) : null}
      {visibleSteps.length > 0 ? (
        <div className={styles.steps}>
          {visibleSteps.map((step, index) => (
            <StepItem
              key={stepKey(step, index)}
              step={step}
              message={message}
              sources={view.sources}
              streaming={streaming}
              isLast={index === visibleSteps.length - 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
})

const stepKey = (step: Step, index: number) =>
  step.type === 'thinking' ||
  step.type === 'text' ||
  step.type === 'search' ||
  step.type === 'python' ||
  step.type === 'browser' ||
  step.type === 'file' ||
  step.type === 'ask'
    ? step.key
    : `${step.type}-${index}`

const StepItem = ({
  step,
  message,
  sources,
  streaming,
  isLast,
}: {
  step: Step
  message: AssistantMessage
  sources: Source[]
  streaming: boolean
  isLast: boolean
}) => {
  switch (step.type) {
    case 'thinking': {
      const lastBlock = step.blocks.at(-1)
      const thinking =
        streaming && lastBlock?.startedAt !== undefined && lastBlock.endedAt === undefined
      return (
        <ContentItem isLast={isLast} active={thinking}>
          <Markdown
            content={step.blocks.map((block) => block.thinking).join('')}
            loading={thinking}
            cacheKey={`${message.id}-${step.key}`}
            disableLink
          />
        </ContentItem>
      )
    }
    case 'text':
      return (
        <ContentItem isLast={isLast} active={false}>
          <Markdown
            content={step.markdown}
            loading={streaming && isLast}
            cacheKey={`${message.id}-${step.key}`}
            disableLink={false}
            sources={sources}
          />
        </ContentItem>
      )
    case 'search':
      return <SearchRow step={step} message={message} streaming={streaming} isLast={isLast} />
    case 'open':
      return <OpenRow step={step} sources={sources} isLast={isLast} />
    case 'find':
      return <FindRow step={step} isLast={isLast} />
    case 'read_link':
      return <ReadLinkRow step={step} isLast={isLast} />
    case 'python':
      return <PythonRow step={step} message={message} streaming={streaming} isLast={isLast} />
    case 'browser':
      return <BrowserRow step={step} isLast={isLast} />
    case 'file':
      return <FileRow step={step} isLast={isLast} />
    case 'ask':
      return <AskRow step={step} isLast={isLast} />
    default:
      return null
  }
}

/** 思考或过程性文字：左侧圆点 + 竖线，小号 markdown */
const ContentItem = ({
  children,
  active,
  isLast,
}: {
  children: ReactNode
  active: boolean
  isLast: boolean
}) => (
  <div className={clsx(styles.content, 'ds-think-content', isLast && styles.lastItem)}>
    <span className={styles.dot}>
      <span className={clsx(styles.dotInner, !active && styles.inactive)} />
    </span>
    {children}
  </div>
)

/** 搜索：普通搜索为「已阅读 N 个网页」，边想边搜为「搜索到 N 个网页」，点击打开搜索结果 */
const SearchRow = ({
  step,
  message,
  streaming,
  isLast,
}: {
  step: SearchStep
  message: AssistantMessage
  streaming: boolean
  isLast: boolean
}) => {
  const t = useTranslate()
  const entry = useSearchPanel((state) => state.entry)
  const wip = step.status === 'wip'
  const tick = useTicker(wip && step.queries.length > 1, 2000)
  const count = step.results.length
  const clickable = !wip && count > 0
  const panelEntry = `${message.id}-search-${step.key}`
  const failed = step.status === 'failed'
  const interrupted = failed && !streaming && message.status === 'stopped'

  let body: ReactNode
  if (wip) {
    body = step.summary ? (
      <span className={clsx(styles.query, styles.shimmer)}>{step.summary}</span>
    ) : step.queries.length > 0 ? (
      <>
        <span className={styles.prefix}>{t('toolSearchIntro')}</span>
        <span className={styles.query} key={tick}>
          {step.queries[tick % step.queries.length]}
        </span>
      </>
    ) : (
      <span>{t(isImageSearchKind(step.kind) ? 'imageSearching' : 'messageSearching')}</span>
    )
  } else if (interrupted) {
    body = <span>{t('searchStopped')}</span>
  } else if (failed) {
    body = <span>{t('toolSearchFail')}</span>
  } else if (count === 0) {
    body = (
      <span>{t(isDeepSearchKind(step.kind) ? 'toolSearchNoResult' : 'messageSearchNoResult')}</span>
    )
  } else {
    const text = t(
      isDeepSearchKind(step.kind)
        ? count === 1
          ? 'toolSearch1Result'
          : 'toolSearchResults'
        : count === 1
          ? 'messageSearchResult'
          : 'messageSearchResults',
      { count }
    )
    body = (
      <>
        <span className={styles.summary}>{text}</span>
        <SiteThumbnails sources={step.results} />
      </>
    )
  }
  const showSummary = !wip && !!step.summary
  return (
    <div className={clsx(styles.searchStep, !isLast && styles.withLine)}>
      <div
        className={clsx(
          styles.row,
          clickable && styles.clickable,
          entry === panelEntry && styles.active
        )}
        onClick={clickable ? () => toggleSearchPanel(panelEntry, step.results) : undefined}
      >
        <span className={styles.rowIcon}>
          {failed ? <IconSearchWarningOutline16 /> : <IconSearchOutline16 />}
        </span>
        {body}
      </div>
      {showSummary ? <div className={styles.searchSummary}>{step.summary}</div> : null}
    </div>
  )
}

/** 工具行外壳：左侧图标，右侧可换行的内容 */
const ToolRow = ({
  icon,
  children,
  isLast,
}: {
  icon: ReactNode
  children: ReactNode
  isLast: boolean
}) => (
  <div className={clsx(styles.tool, !isLast && styles.withLine)}>
    <span className={clsx(styles.rowIcon, styles.toolIcon)}>{icon}</span>
    <div className={styles.toolBody}>{children}</div>
  </div>
)

const PageLink = ({ page, failedTip }: { page: PageItem; failedTip?: string }) => (
  <span
    className={clsx(styles.page, page.status === 'failed' ? styles.pageFailed : styles.pageDone)}
  >
    {page.status === 'failed' ? (
      <Tooltip content={failedTip}>
        <span className={styles.pageText}>{page.title}</span>
      </Tooltip>
    ) : (
      <a className={styles.pageText} href={page.url} target="_blank" rel="noreferrer">
        {page.title}
      </a>
    )}
    <span className={styles.pageIcon}>
      <IconRightUpOutline14 />
    </span>
  </span>
)

/** 边想边搜打开的网页：「浏览 N 个页面」+ 最多 5 个页面 */
const OpenRow = ({
  step,
  sources,
  isLast,
}: {
  step: OpenStep
  sources: Source[]
  isLast: boolean
}) => {
  const t = useTranslate()
  const allFailed = step.pages.every((page) => page.status === 'failed')
  const count = step.pages.length
  const intro = t(count === 1 ? 'toolOpenOneIntro' : 'toolOpensIntro', { count })
  const panelEntry = `open-${step.pages[0]?.id}`
  const summary = [...step.pages].reverse().find((page) => page.summary)?.summary
  return (
    <ToolRow
      icon={allFailed ? <IconBrowseWarningOutline16 /> : <IconBrowseOutline16 />}
      isLast={isLast}
    >
      {allFailed ? (
        t('toolOpenFail')
      ) : (
        <>
          <span className={styles.intro}>{intro}</span>
          {step.pages.slice(0, 5).map((page) => (
            <PageLink key={page.id} page={page} failedTip={t('toolOpenFailTooltip')} />
          ))}
          {count > 5 ? (
            <span
              className={styles.chip}
              onClick={() =>
                toggleSearchPanel(
                  panelEntry,
                  sources.filter((source) => step.pages.some((page) => page.url === source.url))
                )
              }
            >
              {t('toolOpenViewAll')}
            </span>
          ) : null}
          {summary ? <div className={styles.stepSummary}>{summary}</div> : null}
        </>
      )}
    </ToolRow>
  )
}

/** 边想边搜的页内查找：「查找关键词」+ 关键词标签 */
const FindRow = ({ step, isLast }: { step: FindStep; isLast: boolean }) => {
  const t = useTranslate()
  const allFailed = step.patterns.every((item) => item.status === 'failed')
  return (
    <ToolRow
      icon={allFailed ? <IconBrowseWarningOutline16 /> : <IconBrowseOutline16 />}
      isLast={isLast}
    >
      {allFailed ? (
        t('toolFindFail')
      ) : (
        <>
          <span className={styles.intro}>{t('toolFindIntro')}</span>
          {step.patterns.map((item) => (
            <Tooltip
              key={item.id}
              content={item.status === 'failed' ? t('toolFindFailTooltip') : null}
            >
              <span className={clsx(styles.chip, item.status === 'failed' && styles.chipFailed)}>
                {item.status === 'wip' ? null : (
                  <span className={styles.chipIcon}>
                    {item.status === 'failed' ? <IconCloseFill14 /> : <IconCheckedOutline14 />}
                  </span>
                )}
                <span className={styles.chipText}>{item.pattern}</span>
              </span>
            </Tooltip>
          ))}
        </>
      )}
    </ToolRow>
  )
}

/** 阅读用户消息中的链接：视图只保留仍在读取的链接。 */
const ReadLinkRow = ({ step, isLast }: { step: ReadLinkStep; isLast: boolean }) => {
  const t = useTranslate()
  return (
    <ToolRow icon={<IconLinkOutline16 />} isLast={isLast}>
      <span className={clsx(styles.intro, styles.shimmer)}>{t('readingLink')}</span>
      {step.links.map((link) => (
        <PageLink key={link.id} page={link} />
      ))}
    </ToolRow>
  )
}

/** 用不与内容冲突的围栏包裹代码，交给 Markdown 高亮 */
const fence = (lang: string, body: string) => {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

/** 内置浏览器操作时间线：折叠展示步数与状态，展开显示动作记录、页面链接与截图 */
const BrowserRow = ({ step, isLast }: { step: BrowserStep; isLast: boolean }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const running = step.status === 'wip'
  const lastAction = step.actions.at(-1)
  const totalMs = step.actions.reduce((acc, item) => acc + (item.durationMs ?? 0), 0)
  const label = running
    ? lastAction?.summary || t('browserStepRunning')
    : step.actions.length === 1
      ? lastAction?.summary || t('browserStepOne')
      : t('browserStepMany', { count: step.actions.length })
  const seconds = !running && totalMs > 0 ? ` · ${(totalMs / 1000).toFixed(1)}s` : ''
  const screenshots = step.actions.flatMap((action) => action.images ?? [])

  return (
    <ToolRow icon={<IconBrowserOutline14 />} isLast={isLast}>
      <div style={{ width: '100%', minWidth: 0 }}>
        <span
          className={styles.intro}
          style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={clsx(running && styles.shimmer)}>
            {label}
            {seconds}
          </span>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
        {!open && !running && step.actions.length > 1 && lastAction?.summary ? (
          <div className={styles.stepSummary}>{lastAction.summary}</div>
        ) : null}
        {open ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {step.actions.map((action, index) => (
              <div
                key={action.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  fontSize: 13,
                  lineHeight: '18px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ opacity: 0.6 }}>{index + 1}.</span>
                  <span>{action.summary}</span>
                  {action.url && /^https?:\/\//i.test(action.url)
                    ? (() => {
                        const targetUrl = action.url
                        return (
                          <a
                            href={targetUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              color: 'var(--dsw-alias-brand-text)',
                              textDecoration: 'underline',
                              textDecorationStyle: 'dotted',
                              maxWidth: '100%',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            onClick={(event) => {
                              const { openInApp } = deps().ui
                              if (openInApp) {
                                event.preventDefault()
                                openInApp(targetUrl)
                              }
                            }}
                          >
                            {action.title || targetUrl}
                          </a>
                        )
                      })()
                    : null}
                </div>
                {action.output ? (
                  <div style={{ color: 'var(--dsw-alias-label-danger)', paddingLeft: 16 }}>
                    {action.output}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {screenshots.map((src, index) => (
          <img
            key={index}
            src={src}
            alt=""
            style={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: 280,
              marginTop: 8,
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
            }}
          />
        ))}
      </div>
    </ToolRow>
  )
}

/** 文件呈现与编辑步骤：只展示状态与错误；产出的文件卡片随正文展示（ReplyView.files） */
const FileRow = ({ step, isLast }: { step: FileStep; isLast: boolean }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const running = step.status === 'wip'
  const lastAction = step.actions.at(-1)
  const describeItem = (action: FileStep['actions'][number]) => {
    const name = action.title || action.path
    if (action.status === 'wip') {
      return action.tool === 'edit_file'
        ? t('previewToolEditing', { name })
        : action.tool === 'read_file'
          ? t('previewToolReading', { name })
          : t('previewToolPresenting', { name })
    }
    if (action.status === 'failed') {
      return action.tool === 'edit_file'
        ? t('previewToolEditFailed', { name })
        : action.tool === 'read_file'
          ? t('previewToolReadFailed', { name })
          : t('previewToolPresentFailed', { name })
    }
    if (action.tool === 'edit_file') {
      return t('previewToolEdit', { name, version: action.version ?? 2 })
    }
    if (action.tool === 'read_file') {
      return t('previewToolRead', { name })
    }
    return t('previewToolPresent', { name })
  }
  const errors = step.actions.filter((action) => action.error)
  const summaryLabel = lastAction ? describeItem(lastAction) : t('previewPanelTitle')

  return (
    <ToolRow icon={<IconBrowseOutline16 />} isLast={isLast}>
      <div style={{ width: '100%', minWidth: 0 }}>
        {step.actions.length > 1 ? (
          <span
            className={styles.intro}
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => setOpen((value) => !value)}
          >
            <span className={clsx(running && styles.shimmer)}>{summaryLabel}</span>
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        ) : (
          <span className={clsx(styles.intro, running && styles.shimmer)}>{summaryLabel}</span>
        )}
        {!open && lastAction?.summary ? (
          <div className={styles.stepSummary}>{lastAction.summary}</div>
        ) : null}
        {open && step.actions.length > 1 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
            {step.actions.map((action, index) => (
              <div key={action.id} style={{ fontSize: 13, lineHeight: '18px' }}>
                <span style={{ opacity: 0.6 }}>{index + 1}. </span>
                <span>{describeItem(action)}</span>
                {action.summary ? <div className={styles.stepSummary}>{action.summary}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
        {errors.map((action) => (
          <div
            key={action.id}
            style={{ color: 'var(--dsw-alias-label-danger)', fontSize: 13, marginTop: 4 }}
          >
            {action.error}
          </div>
        ))}
      </div>
    </ToolRow>
  )
}

/** 浏览器内 Python：标题行显示状态与用时，点击展开代码、输出与图像 */
const PythonRow = ({
  step,
  message,
  streaming,
  isLast,
}: {
  step: PythonStep
  message: AssistantMessage
  streaming: boolean
  isLast: boolean
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const status = step.result?.status ?? (streaming ? 'running' : 'notRun')
  const running = status === 'running'
  useTicker(running, 1000)
  const label =
    status === 'running'
      ? step.result?.phase === 'installing'
        ? t('pythonInstalling')
        : step.result?.phase === 'starting'
          ? t('pythonStarting')
          : t('pythonRunning')
      : status === 'error'
        ? t('pythonFailed')
        : status === 'aborted'
          ? t('pythonStopped')
          : status === 'notRun'
            ? t('pythonNotRun')
            : t('pythonRan')
  const seconds =
    step.result?.durationMs !== undefined
      ? ` · ${(step.result.durationMs / 1000).toFixed(1)}s`
      : running && step.result?.startedAt !== undefined
        ? ` · ${Math.floor((Date.now() - step.result.startedAt) / 1000)}s`
        : ''
  const headline = step.summary
    ? status === 'error' || status === 'aborted'
      ? `${step.summary} (${label})`
      : step.summary
    : label
  const images = step.result?.images ?? []
  return (
    <ToolRow icon={<IconThinkOutline16 />} isLast={isLast}>
      <div style={{ width: '100%', minWidth: 0 }}>
        <span
          className={styles.intro}
          style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setOpen((value) => !value)}
        >
          {/* 微光效果会把文字颜色设为透明，只加在文字上，箭头保持可见 */}
          <span className={clsx(running && styles.shimmer)}>
            {headline}
            {seconds}
          </span>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
        {open ? (
          <div style={{ marginTop: 6 }}>
            <Markdown
              content={fence('python', step.code)}
              loading={false}
              cacheKey={`${message.id}-${step.key}-code`}
              disableLink
            />
            {step.result && step.result.content ? (
              <Markdown
                content={fence('text', step.result.content)}
                loading={false}
                cacheKey={`${message.id}-${step.key}-out-${step.result.status}`}
                disableLink
              />
            ) : null}
          </div>
        ) : null}
        {images.map((src, index) => (
          <img
            key={index}
            src={src}
            alt=""
            style={{ display: 'block', maxWidth: '100%', marginTop: 8, borderRadius: 8 }}
          />
        ))}
      </div>
    </ToolRow>
  )
}

/** 澄清提问步骤：等待中展示提示，已回答时以紧凑标签展示每题选择 */
const AskRow = ({ step, isLast }: { step: AskStep; isLast: boolean }) => {
  const t = useTranslate()
  const waiting = step.status === 'wip'
  const ask = step.askAction
  const answeredItems =
    ask?.status === 'answered'
      ? ask.items.filter((item) =>
          Array.isArray(item.answer) ? item.answer.length > 0 : Boolean(item.answer)
        )
      : []
  const headline = waiting
    ? step.summary || t('askWaiting')
    : ask?.status === 'skipped'
      ? t('askSkipped')
      : step.summary || t('askAnswered')

  return (
    <ToolRow icon={<IconCheckedOutline14 />} isLast={isLast}>
      <div style={{ width: '100%', minWidth: 0 }}>
        <span className={clsx(styles.intro, waiting && styles.shimmer)}>{headline}</span>
        {!waiting && answeredItems.length > 0 ? (
          <div className={styles.askChips}>
            {answeredItems.map((item) => (
              <span key={item.id} className={styles.askChip}>
                <span className={styles.askChipKey}>{item.header}:</span>{' '}
                <span>{Array.isArray(item.answer) ? item.answer.join(', ') : item.answer}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </ToolRow>
  )
}

/** 从 IndexedDB 读取原件交给应用保存（桌面端保存对话框，网页端下载）；原件缺失时返回 false */
const downloadStoredFile = async (file: PresentedFileRef): Promise<boolean> => {
  const blob = await loadFile(file.id)
  if (!blob) {
    return false
  }
  // 用户取消保存不算文件缺失
  await deps().ui.saveFile(file.name, blob)
  return true
}

/** 统一的可预览与下载文件卡片：点击在右侧文件面板预览，右侧按钮可直接保存 */
export const PresentedFileCard = ({
  sessionId,
  file,
}: {
  sessionId: string
  file: PresentedFileRef
}) => {
  const t = useTranslate()
  const [missing, setMissing] = useState(false)
  const { files } = deps().ui.panels
  const shownFile = { kind: 'presented', file } as const
  const isOpen = files.useIsShown(sessionId, shownFile)

  const ext = getExtension(file.name)
  const versionTag = file.version !== undefined && file.version > 1 ? `v${file.version}` : undefined
  const subtitle = [ext, formatSize(file.size), versionTag].filter(Boolean).join(' · ')

  return (
    <FileCard
      name={file.name}
      title={file.title}
      size={file.size}
      subtitle={missing ? t('pythonFileMissing') : subtitle}
      status={missing ? 'error' : 'done'}
      error={missing ? t('pythonFileMissing') : undefined}
      active={isOpen}
      onOpen={() => files.open(sessionId, shownFile)}
      onDownload={() => {
        void downloadStoredFile(file).then(
          (ok) => setMissing(!ok),
          () => setMissing(true)
        )
      }}
    />
  )
}
