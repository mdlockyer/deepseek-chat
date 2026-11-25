import type {
  ServerToolKind,
  TextCitation,
  WebFetchToolResultBlock,
  WebSearchResult,
  WebSearchToolResultBlock,
} from '@deepseek-chat/lib-agent'
import type { DeliveredFileRef, ToolRegistry, ToolStepSummary } from '@deepseek-chat/lib-tools'
import { translate } from './messages.js'
import type { AssistantMessage, ThinkingPart, ToolCallPart, ToolResultPart } from './types.js'

/**
 * Pure projection of an `AssistantMessage` into Front Stage view data:
 * generic tool/server/thinking steps, answer markdown with `[citation:N]`, deduplicated numbered
 * sources, promoted delivered files, and promoted visual outputs.
 * Zero knowledge of any sibling capability slice's internal tool types.
 */

export type Source = {
  url: string
  title: string
  /** 优先使用服务端站点名，没有时使用域名（去掉 www.） */
  siteName: string
  /** 搜索结果为 RFC 3339，阅读链接为爬虫提取的原始日期 */
  publishedAt: string | null
  /** 明文摘要与站点图标；缺少元数据时为 null */
  snippet: string | null
  siteIcon: string | null
  /** 引用角标与搜索结果列表上的编号，从 1 开始 */
  index: number
}

export type ToolStatus = 'wip' | 'done' | 'failed'

export const isDeepSearchKind = (kind: ServerToolKind) =>
  kind === 'deep_search' || kind === 'deep_image_search'

export const isImageSearchKind = (kind: ServerToolKind) =>
  kind === 'image_search' || kind === 'deep_image_search'

export type ServerSearchStep = {
  type: 'search'
  key: string
  kind: ServerToolKind
  queries: string[]
  results: Source[]
  status: ToolStatus
}

export type PageItem = {
  id: string
  url: string
  title: string
  status: ToolStatus
}

export type ServerOpenStep = { type: 'open'; pages: PageItem[] }

export type ServerFindStep = {
  type: 'find'
  patterns: { id: string; pattern: string; status: ToolStatus }[]
}

export type ServerReadLinkStep = { type: 'read_link'; links: PageItem[] }

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

export type Step =
  | ServerSearchStep
  | ServerOpenStep
  | ServerFindStep
  | ServerReadLinkStep
  | ThinkingStep
  | PreambleStep
  | ToolStep

export type ReplyView = {
  steps: Step[]
  /** 最后一个思考或工具块之后的正文；markdown 里在引用处插入了 [citation:N] */
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

const getServerStatus = (
  result: WebSearchToolResultBlock | WebFetchToolResultBlock | undefined,
  streaming: boolean
): ToolStatus => {
  if (!result) {
    return streaming ? 'wip' : 'failed'
  }
  if (result.type === 'web_search_tool_result') {
    return result.content.some((item) => item.type === 'web_search_tool_result_error')
      ? 'failed'
      : 'done'
  }
  return result.content.type === 'web_fetch_result' ? 'done' : 'failed'
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

const mergeStatus = (statuses: ToolStatus[]): ToolStatus =>
  statuses.includes('wip') ? 'wip' : statuses.every((s) => s === 'failed') ? 'failed' : 'done'

/** 来源登记：同一 URL 只编号一次，编号按首次出现的顺序 */
class SourceRegistry {
  readonly list: Source[] = []
  private byUrl = new Map<string, Source>()

  add(
    url: string,
    title: string | null,
    publishedAt: string | null,
    metadata?: Pick<WebSearchResult, 'snippet' | 'site_icon' | 'site_name'>
  ): Source {
    const trimmed = url.trim()
    const siteName = metadata?.site_name?.trim() || getSiteName(trimmed)
    const snippet = metadata?.snippet?.trim() || null
    const siteIcon = metadata?.site_icon?.trim() || null
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

const joinTextBlocks = (
  blocks: { text: string; citations?: TextCitation[] }[],
  registry: SourceRegistry
) => {
  let markdown = ''
  let text = ''
  for (const block of blocks) {
    text += stripPlainCitations(block.text)
    const indexes = new Set<number>()
    for (const citation of block.citations ?? []) {
      indexes.add(registry.add(citation.url, citation.title, null).index)
    }
    const body = indexes.size > 0 ? block.text.trimEnd() : block.text
    markdown += body
    for (const index of indexes) {
      markdown += `[citation:${index}]`
    }
    markdown += block.text.slice(body.length)
  }
  return { markdown, text }
}

export const buildReplyView = (
  reply: AssistantMessage,
  streaming: boolean,
  tools?: ToolRegistry
): ReplyView => {
  const results = new Map<string, WebSearchToolResultBlock | WebFetchToolResultBlock>()
  const toolResults = new Map<string, ToolResultPart>()
  for (const block of reply.blocks) {
    if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
      results.set(block.tool_use_id, block)
    } else if (block.type === 'tool_result') {
      toolResults.set(block.tool_use_id, block)
    }
  }

  const registry = new SourceRegistry()
  const steps: Step[] = []
  const mergedSearch = new Map<ServerToolKind, ServerSearchStep>()
  let mergedThinking: ThinkingStep | null = null
  let pendingText: { index: number; text: string; citations?: TextCitation[] }[] = []

  // First pass: register all citable sources in call order (matches `collectCitedUrls`).
  for (const block of reply.blocks) {
    if (block.type === 'tool_use') {
      const result = toolResults.get(block.id)
      for (const item of result?.sources ?? []) {
        if (item.url.trim()) {
          registry.add(item.url, item.title, item.publishedAt, {
            snippet: item.snippet,
            site_name: item.siteName,
            site_icon: null,
          })
        }
      }
      continue
    }
    if (block.type !== 'server_tool_use') {
      continue
    }
    const result = results.get(block.id)
    if (result?.type === 'web_search_tool_result') {
      for (const item of result.content) {
        if (item.type === 'web_search_result') {
          registry.add(item.url, item.title, item.page_age, item)
        }
      }
    } else if (
      result?.type === 'web_fetch_tool_result' &&
      result.content.type === 'web_fetch_result' &&
      block.kind === 'deep_search'
    ) {
      registry.add(result.content.url, result.content.content.title, result.content.published_at)
    }
  }

  const flushPreamble = () => {
    if (pendingText.length === 0) {
      return
    }
    const { markdown } = joinTextBlocks(pendingText, registry)
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
      pendingText.push({ index, text: block.text, citations: block.citations })
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
        ? presenter.summarize(block, toolResult, { streaming, capabilityState })
        : null
      steps.push({
        type: 'tool',
        key: block.id,
        call: block,
        result: toolResult ?? null,
        ...(rawSummary ? { rawSummary } : {}),
        summary,
      })
      return
    }
    if (block.type !== 'server_tool_use') {
      return
    }
    const result = results.get(block.id)
    if (
      block.input.action === 'read_link' &&
      !block.input.url &&
      !(
        result?.type === 'web_fetch_tool_result' &&
        result.content.type === 'web_fetch_result' &&
        result.content.url
      )
    ) {
      return
    }
    flushPreamble()
    const { kind, input } = block
    const status = getServerStatus(result, streaming)
    const last = steps.at(-1)

    if (input.action === 'search') {
      const { queries } = input
      const found =
        result?.type === 'web_search_tool_result'
          ? result.content.flatMap((item) =>
              item.type === 'web_search_result'
                ? [registry.add(item.url, item.title, item.page_age, item)]
                : []
            )
          : []
      const target = isDeepSearchKind(kind)
        ? last?.type === 'search' && last.kind === kind
          ? last
          : null
        : mergedSearch.get(kind)
      if (target) {
        target.queries.push(...queries)
        target.results.push(...found.filter((source) => !target.results.includes(source)))
        target.status = mergeStatus([target.status, status])
      } else {
        const step: ServerSearchStep = {
          type: 'search',
          key: block.id,
          kind,
          queries: [...queries],
          results: found,
          status,
        }
        steps.push(step)
        if (!isDeepSearchKind(kind)) {
          mergedSearch.set(kind, step)
        }
      }
      return
    }

    const fetched = result?.type === 'web_fetch_tool_result' ? result.content : null
    const page: PageItem = {
      id: block.id,
      url: input.url || (fetched?.type === 'web_fetch_result' ? fetched.url : ''),
      title: (fetched?.type === 'web_fetch_result' ? fetched.content.title : null) || input.url,
      status,
    }
    if (input.action === 'read_link') {
      if (status !== 'wip') {
        return
      }
      if (last?.type === 'read_link') {
        last.links.push(page)
      } else {
        steps.push({ type: 'read_link', links: [page] })
      }
    } else if (input.action === 'open_page') {
      if (last?.type === 'open') {
        last.pages.push(page)
      } else {
        steps.push({ type: 'open', pages: [page] })
      }
    } else {
      const item = { id: block.id, pattern: input.pattern, status }
      if (last?.type === 'find') {
        last.patterns.push(item)
      } else {
        steps.push({ type: 'find', patterns: [item] })
      }
    }
  })

  const answer = pendingText.length > 0 ? joinTextBlocks(pendingText, registry) : null
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
    case 'search':
      return step.status === 'wip'
    case 'open':
      return step.pages.some((page) => page.status === 'wip')
    case 'read_link':
      return step.links.some((link) => link.status === 'wip')
    case 'find':
      return step.patterns.some((item) => item.status === 'wip')
    case 'tool':
      return step.summary
        ? Boolean(step.summary.stillRunning)
        : step.result === null || step.result.status === 'running'
    case 'thinking':
    case 'text':
      return false
  }
}

/** 折叠区标题（纯函数，完全基于通用 `ToolStepSummary` 与服务端步骤） */
export const getAreaTitle = (
  view: ReplyView,
  streaming: boolean,
  now: number,
  hasResponse = view.answer !== null
) => {
  if (hasResponse) {
    const count = getTotalThinkingSeconds(view.steps, now)
    if (count === null) {
      return translate('thinkingSwitch')
    }
    return translate(count === 1 ? 'messageThinkDuration' : 'messageThinkDurationPlural', { count })
  }
  if (!streaming) {
    return translate('messageThinkStopped')
  }
  const last = view.steps.at(-1)
  if (last?.type === 'search' && last.status === 'wip') {
    return translate(isImageSearchKind(last.kind) ? 'imageSearching' : 'deepSearchSearching')
  }
  if (last?.type === 'open' && last.pages.some((page) => page.status === 'wip')) {
    return translate('groupTitleToolOpen')
  }
  if (last?.type === 'find' && last.patterns.some((item) => item.status === 'wip')) {
    return translate('groupTitleToolOpen')
  }
  if (last?.type === 'read_link' && last.links.some((link) => link.status === 'wip')) {
    return translate('readingLink')
  }
  if (last?.type === 'tool' && showsRunning(last)) {
    return last.rawSummary || last.summary?.detail || last.summary?.liveVerb || last.call.name
  }
  return translate('messageThinking')
}

/** 生成中的回复停顿时，是否需要显示「仍在处理」 */
export const needsWorkingIndicator = (view: ReplyView): boolean => {
  const last = view.steps.at(-1)
  if (!last) {
    return view.answer !== null
  }
  return view.answer !== null || !showsRunning(last)
}
