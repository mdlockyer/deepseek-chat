import type { DeliveredFileRef, ToolRegistry, ToolStepSummary } from '@deepseek-chat/lib-tools'
import type { Locale } from '@deepseek-chat/spine/i18n'
import { translate } from './messages.js'
import type { AssistantMessage, ThinkingPart, ToolCallPart, ToolResultPart } from './types.js'

/**
 * Pure projection of an `AssistantMessage` into Front Stage view data:
 * generic client-tool and thinking steps, answer markdown with `[citation:N]`, deduplicated
 * numbered sources, promoted delivered files, and promoted visual outputs.
 * Zero knowledge of any sibling capability slice's internal tool types.
 */

export type Source = {
  url: string
  title: string
  /** 优先使用站点名，没有时使用域名（去掉 www.） */
  siteName: string
  /** 发布时间（RFC 3339 或页面提取日期） */
  publishedAt: string | null
  /** 明文摘要与站点图标；缺少元数据时为 null */
  snippet: string | null
  siteIcon: string | null
  /** 引用角标与搜索结果列表上的编号，从 1 开始 */
  index: number
}

export type ThinkingStep = { type: 'thinking'; key: string; blocks: ThinkingPart[] }

/** 工具调用前输出的说明文字 */
export type PreambleStep = { type: 'text'; key: string; markdown: string }

/** Domain-blind client tool step summarized through the capability's `ToolStepPresenter`. */
export type ToolStep = {
  type: 'tool'
  key: string
  call: ToolCallPart
  result: ToolResultPart | null
  rawSummary?: string
  summary: ToolStepSummary | null
}

export type Step = ThinkingStep | PreambleStep | ToolStep

export type ReplyView = {
  steps: Step[]
  /** 最后一个思考或工具块之后的正文 */
  answer: { markdown: string; text: string } | null
  /** 正文引用可指向的全部来源，按编号排列 */
  sources: Source[]
  /** 正文中实际引用到的来源编号（按首次出现顺序去重） */
  citedSourceIndexes: number[]
  /** 本条回复交付的文件，回复结束后展示（同一路径只留最新版本，位置按首次出现） */
  files: DeliveredFileRef[]
  /** 无 previewImages 的工具输出图片（如图表），直接提升至正文区展示 */
  images: string[]
}

export const getSiteName = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const getStringField = (input: unknown, key: string): string => {
  if (input && typeof input === 'object' && key in input) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string') {
      return value
    }
  }
  return ''
}

const getPartialStringField = (input: unknown, inputJson: string | undefined, key: string) => {
  const direct = getStringField(input, key)
  if (direct) {
    return direct
  }
  if (!inputJson) {
    return ''
  }
  try {
    return getStringField(JSON.parse(inputJson) as unknown, key)
  } catch {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`(?:^|[{,])\\s*"${escaped}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(
      inputJson
    )
    if (!match) {
      return ''
    }
    try {
      const decoded: unknown = JSON.parse(`"${match[1]}"`)
      return typeof decoded === 'string' ? decoded : ''
    } catch {
      return ''
    }
  }
}

export const getToolSummary = (
  input: unknown,
  inputJson: string | undefined
): string | undefined => {
  const raw = getPartialStringField(input, inputJson, 'summary').replace(/\s+/g, ' ').trim()
  return raw || undefined
}

type SourceMetadata = {
  readonly snippet?: string | null
  readonly siteIcon?: string | null
  readonly siteName?: string | null
}

/** 来源登记：同一 URL 只编号一次，编号按首次出现的顺序 */
class SourceRegistry {
  readonly list: Source[] = []
  private byUrl = new Map<string, Source>()

  add(
    url: string,
    title: string | null,
    publishedAt: string | null,
    metadata?: SourceMetadata
  ): Source {
    const trimmed = url.trim()
    const siteName = metadata?.siteName?.trim() || getSiteName(trimmed)
    const snippet = metadata?.snippet?.trim() || null
    const siteIcon = metadata?.siteIcon?.trim() || null
    const existing = this.byUrl.get(trimmed)
    if (existing) {
      if (existing.title === trimmed && title) {
        existing.title = title
      }
      if (existing.siteName === getSiteName(trimmed)) {
        existing.siteName = siteName
      }
      existing.publishedAt ||= publishedAt
      existing.snippet ||= snippet
      existing.siteIcon ||= siteIcon
      return existing
    }
    const source: Source = {
      url: trimmed,
      title: title || trimmed,
      siteName,
      publishedAt,
      snippet,
      siteIcon,
      index: this.list.length + 1,
    }
    this.list.push(source)
    this.byUrl.set(trimmed, source)
    return source
  }
}

const stripPlainCitations = (value: string) =>
  value.replace(
    /([ \t]*)((?:\[(?:citation|ref):\d+\][ \t]*)+)/g,
    (full, leadingSpace: string, run: string, offset: number, src: string) => {
      const after = src.slice(offset + full.length)
      const hasTrailingSpace = /[ \t]$/.test(run)
      if (after.length === 0 || /^[.,;:!?)\]}，。；：！？）》】]/.test(after)) {
        return ''
      }
      return leadingSpace || hasTrailingSpace ? ' ' : ''
    }
  )

const joinTextBlocks = (blocks: { text: string }[]) => {
  let markdown = ''
  let text = ''
  for (const block of blocks) {
    text += stripPlainCitations(block.text)
    markdown += block.text
  }
  return { markdown, text }
}

export const buildReplyView = (
  reply: AssistantMessage,
  streaming: boolean,
  tools?: ToolRegistry,
  locale?: Locale
): ReplyView => {
  const toolResults = new Map<string, ToolResultPart>()
  for (const block of reply.blocks) {
    if (block.type === 'tool_result') {
      toolResults.set(block.tool_use_id, block)
    }
  }

  const registry = new SourceRegistry()
  const steps: Step[] = []
  let mergedThinking: ThinkingStep | null = null
  let pendingText: { index: number; text: string }[] = []

  // First pass: register all citable sources in call order (matches `collectCitedUrls`).
  for (const block of reply.blocks) {
    if (block.type !== 'tool_use') {
      continue
    }
    const result = toolResults.get(block.id)
    for (const item of result?.sources ?? []) {
      if (item.url.trim()) {
        registry.add(item.url, item.title, item.publishedAt, {
          snippet: item.snippet,
          siteName: item.siteName,
          siteIcon: null,
        })
      }
    }
  }

  const flushPreamble = () => {
    if (pendingText.length === 0) {
      return
    }
    const { markdown } = joinTextBlocks(pendingText)
    if (markdown.trim()) {
      steps.push({ type: 'text', key: `text-${pendingText[0].index}`, markdown })
    }
    pendingText = []
  }

  reply.blocks.forEach((block, index) => {
    if (block.type === 'text' && block.isTemplate) {
      return
    }
    if (block.type !== 'thinking') {
      mergedThinking = null
    }
    if (block.type === 'text') {
      pendingText.push({ index, text: block.text })
      return
    }
    if (block.type === 'thinking') {
      if (mergedThinking) {
        mergedThinking.blocks.push(block)
      } else if (block.thinking) {
        flushPreamble()
        mergedThinking = { type: 'thinking', key: `thinking-${index}`, blocks: [block] }
        steps.push(mergedThinking)
      }
      return
    }
    if (block.type === 'tool_use') {
      flushPreamble()
      const toolResult = toolResults.get(block.id)
      const rawSummary = getToolSummary(block.input, block.inputJson)
      const capabilityId = toolResult?.capability ?? tools?.capabilityIdOf(block.name) ?? undefined
      const presenter = tools?.presenterFor(capabilityId, block.name) ?? null
      const capabilityState =
        capabilityId && reply.capabilityState && Object.hasOwn(reply.capabilityState, capabilityId)
          ? reply.capabilityState[capabilityId]
          : undefined
      const summary = presenter
        ? presenter.summarize(block, toolResult, { streaming, capabilityState, locale })
        : null
      steps.push({
        type: 'tool',
        key: block.id,
        call: block,
        result: toolResult ?? null,
        ...(rawSummary ? { rawSummary } : {}),
        summary,
      })
    }
  })

  const answer = pendingText.length > 0 ? joinTextBlocks(pendingText) : null
  const citedSourceIndexes: number[] = []
  if (answer?.markdown) {
    const seenCited = new Set<number>()
    const maxIndex = registry.list.length
    for (const match of answer.markdown.matchAll(/\[(?:citation|ref):(\d+)\]/g)) {
      const idx = Number(match[1])
      if (idx >= 1 && idx <= maxIndex && !seenCited.has(idx)) {
        seenCited.add(idx)
        citedSourceIndexes.push(idx)
      }
    }
  }

  const files = new Map<string, DeliveredFileRef>()
  const images: string[] = []
  const seenImages = new Set<string>()
  for (const block of reply.blocks) {
    if (block.type !== 'tool_result') {
      continue
    }
    for (const file of block.files ?? []) {
      files.set(file.path ?? file.name, file)
    }
    // Images without separate clean `previewImages` (e.g. charts/figures) promote to Front Stage.
    if (!block.previewImages?.length) {
      for (const img of block.images ?? []) {
        if (img && !seenImages.has(img)) {
          seenImages.add(img)
          images.push(img)
        }
      }
    }
  }

  return {
    steps,
    answer: answer && answer.text ? answer : null,
    sources: registry.list,
    citedSourceIndexes,
    files: streaming ? [] : [...files.values()],
    images,
  }
}

/** 思考总用时（秒）：各思考块用时之和，至少 1 秒；有块缺少用时时返回 null。 */
export const getTotalThinkingSeconds = (steps: readonly Step[], now: number) => {
  let total = 0
  for (const step of steps) {
    if (step.type === 'thinking') {
      for (const block of step.blocks) {
        if (block.elapsedSeconds !== undefined) {
          total += block.elapsedSeconds * 1000
          continue
        }
        if (block.startedAt === undefined) {
          return null
        }
        total += (block.endedAt ?? now) - block.startedAt
      }
    }
  }
  return Math.max(1, Math.round(total / 1000))
}

/** 该步骤自身已显示进行中，无需另行提示仍在处理。 */
export const showsRunning = (step: Step): boolean => {
  switch (step.type) {
    case 'tool':
      return step.summary
        ? Boolean(step.summary.stillRunning)
        : step.result === null || step.result.status === 'running'
    case 'thinking':
    case 'text':
      return false
  }
}

/** 折叠区标题（纯函数，完全基于通用 `ToolStepSummary`） */
export const getAreaTitle = (
  view: ReplyView,
  streaming: boolean,
  now: number,
  hasResponse = view.answer !== null,
  locale?: Locale
) => {
  if (hasResponse) {
    const count = getTotalThinkingSeconds(view.steps, now)
    if (count === null) {
      return translate(locale, 'thinkingSwitch')
    }
    return translate(locale, count === 1 ? 'messageThinkDuration' : 'messageThinkDurationPlural', {
      count,
    })
  }
  if (!streaming) {
    return translate(locale, 'messageThinkStopped')
  }
  const last = view.steps.at(-1)
  if (last?.type === 'tool' && showsRunning(last)) {
    return last.rawSummary || last.summary?.detail || last.summary?.liveVerb || last.call.name
  }
  return translate(locale, 'messageThinking')
}

/** 生成中的回复停顿时，是否需要显示「仍在处理」 */
/** How long text after a tool call streams before it counts as the answer. */
export const NARRATION_HOLD_MS = 1200
/** Text this long, or with a paragraph break, is the answer at once. */
export const NARRATION_MAX_CHARS = 280

/**
 * Whether a reply's trailing text should still be held back as likely narration. In a reply that
 * has used tools, text after the latest tool call is usually a line like "That didn't work. Let me
 * check…" that folds into the steps as soon as the next call starts; shown as the answer, it
 * flashes in and out. While the reply streams, such text is held until it reaches
 * `NARRATION_MAX_CHARS`, has a paragraph break, or has streamed for `NARRATION_HOLD_MS`.
 */
export const holdsNarration = (
  view: ReplyView,
  streaming: boolean,
  streamedMs: number
): boolean => {
  const text = view.answer?.text.trim() ?? ''
  if (!streaming || !text || !view.steps.some((step) => step.type === 'tool')) {
    return false
  }
  if (text.length >= NARRATION_MAX_CHARS || /\n\s*\n/.test(text)) {
    return false
  }
  return streamedMs < NARRATION_HOLD_MS
}

export const needsWorkingIndicator = (view: ReplyView): boolean => {
  const last = view.steps.at(-1)
  if (!last) {
    return view.answer !== null
  }
  return view.answer !== null || !showsRunning(last)
}
