import { translate } from './messages.js'
import { deps } from './env.js'
import type {
  ServerToolKind,
  TextCitation,
  WebFetchToolResultBlock,
  WebSearchResult,
  WebSearchToolResultBlock,
} from './api/types.js'
import type { AssistantMessage, PresentedFileRef, ThinkingPart, ToolResultPart } from './types.js'

/**
 * 由回复的内容块推导界面需要的结构：思考与工具步骤的时间线、带引用角标的正文、可引用的来源列表。
 * 只做纯计算，不改动内容块（内容块要原样回传）。
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

export type SearchStep = {
  type: 'search'
  /** 该步骤首次调用的 ID，空查询的图搜也有稳定标识 */
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

export type OpenStep = { type: 'open'; pages: PageItem[] }

export type FindStep = {
  type: 'find'
  patterns: { id: string; pattern: string; status: ToolStatus }[]
}

export type ReadLinkStep = { type: 'read_link'; links: PageItem[] }

export type ThinkingStep = { type: 'thinking'; key: string; blocks: ThinkingPart[] }

/** 工具调用前输出的说明文字 */
export type PreambleStep = { type: 'text'; key: string; markdown: string }

/** 浏览器内执行的 Python 代码及结果；没有结果时为进行中（或被中止） */
export type PythonStep = {
  type: 'python'
  key: string
  code: string
  result: ToolResultPart | null
}

export type BrowserActionItem = {
  id: string
  tool: string
  summary: string
  url?: string
  title?: string | null
  images?: string[]
  status: ToolStatus
  durationMs?: number
  output?: string
}

export type BrowserStep = {
  type: 'browser'
  key: string
  actions: BrowserActionItem[]
  status: ToolStatus
}

export type FileActionItem = {
  id: string
  tool: 'present_file' | 'edit_file' | 'read_file'
  path: string
  title?: string
  version?: number
  files?: PresentedFileRef[]
  status: ToolStatus
  durationMs?: number
  error?: string
}

export type FileStep = {
  type: 'file'
  key: string
  actions: FileActionItem[]
  status: ToolStatus
}

export type Step =
  | SearchStep
  | OpenStep
  | FindStep
  | ReadLinkStep
  | ThinkingStep
  | PreambleStep
  | PythonStep
  | BrowserStep
  | FileStep

export type ReplyView = {
  steps: Step[]
  /** 最后一个思考或工具块之后的正文；markdown 里在引用处插入了 [citation:N] */
  answer: { markdown: string; text: string } | null
  /** 正文引用可指向的全部来源，按编号排列 */
  sources: Source[]
  /** 搜索到的网页（去重），用于底部汇总与搜索结果列表 */
  searchResults: Source[]
}

export const getSiteName = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const getStatus = (
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

const getClientToolStatus = (
  result: ToolResultPart | undefined,
  streaming: boolean
): ToolStatus => {
  if (!result || result.status === 'running') {
    return streaming ? 'wip' : 'failed'
  }
  return result.status === 'ok' ? 'done' : 'failed'
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
    const siteName = metadata?.site_name?.trim() || getSiteName(url)
    const snippet = metadata?.snippet?.trim() || null
    const siteIcon = metadata?.site_icon?.trim() || null
    const existing = this.byUrl.get(url)
    if (existing) {
      // 同一网页可能先被打开，或先返回不完整元数据；后续结果补齐，不覆盖已有正文信息。
      if (existing.title === url && title) {
        existing.title = title
      }
      if (existing.siteName === getSiteName(url)) {
        existing.siteName = siteName
      }
      existing.publishedAt ||= publishedAt
      existing.snippet ||= snippet
      existing.siteIcon ||= siteIcon
      return existing
    }
    const source: Source = {
      url,
      title: title || url,
      siteName,
      publishedAt,
      snippet,
      siteIcon,
      index: this.list.length + 1,
    }
    this.list.push(source)
    this.byUrl.set(url, source)
    return source
  }
}

/**
 * 文本块拼成一份 markdown：服务端在挂过引用的块之后另起新块，引用位置即块尾。
 * 引用之后的空白（含换行）仍留在被引用的块里，所以 [citation:N] 插在块尾空白之前。
 */
const joinTextBlocks = (
  blocks: { text: string; citations?: TextCitation[] }[],
  registry: SourceRegistry
) => {
  let markdown = ''
  let text = ''
  for (const block of blocks) {
    text += block.text
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

export const buildReplyView = (reply: AssistantMessage, streaming: boolean): ReplyView => {
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
  const searchResults: Source[] = []
  const steps: Step[] = []
  const mergedSearch = new Map<ServerToolKind, SearchStep>()
  let mergedThinking: ThinkingStep | null = null
  let pendingText: { index: number; text: string; citations?: TextCitation[] }[] = []

  const { kindOf } = deps().tools

  // 来源编号按搜索结果、打开的网页在回复中出现的顺序，与正文引用无关
  for (const block of reply.blocks) {
    if (block.type === 'tool_use') {
      const result = toolResults.get(block.id)
      const kind = kindOf(block.name)
      if (kind === 'web_search' && result?.searchResults) {
        for (const item of result.searchResults) {
          const source = registry.add(item.url, item.title, item.publishedAt, {
            snippet: item.snippet,
            site_name: item.siteName,
            site_icon: null,
          })
          if (!searchResults.includes(source)) {
            searchResults.push(source)
          }
        }
      } else if (kind === 'web_scrape' && result?.scrapedPage) {
        registry.add(result.scrapedPage.url, result.scrapedPage.title, null)
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
          const source = registry.add(item.url, item.title, item.page_age, item)
          if (!searchResults.includes(source)) {
            searchResults.push(source)
          }
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
    // 模板统一由 describeReply 展示，不能混入模型正文或工具步骤前的说明文字。
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
      // 相邻思考块沿用同一个圆点和 Markdown；原始块与签名不变。
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
      const toolKind = kindOf(block.name)
      if (toolKind === 'web_search') {
        const query = getPartialStringField(block.input, block.inputJson, 'query')
        const kind: ServerToolKind = reply.thinking ? 'deep_search' : 'search'
        const status = getClientToolStatus(toolResult, streaming)
        const found = (toolResult?.searchResults ?? []).map((item) =>
          registry.add(item.url, item.title, item.publishedAt, {
            snippet: item.snippet,
            site_name: item.siteName,
            site_icon: null,
          })
        )
        const last = steps.at(-1)
        const target = isDeepSearchKind(kind)
          ? last?.type === 'search' && last.kind === kind
            ? last
            : null
          : mergedSearch.get(kind)
        if (target) {
          if (query) {
            target.queries.push(query)
          }
          target.results.push(...found.filter((source) => !target.results.includes(source)))
          target.status = mergeStatus([target.status, status])
        } else {
          const step: SearchStep = {
            type: 'search',
            key: block.id,
            kind,
            queries: query ? [query] : [],
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
      if (toolKind === 'web_scrape') {
        const url =
          toolResult?.scrapedPage?.url || getPartialStringField(block.input, block.inputJson, 'url')
        const title = toolResult?.scrapedPage?.title || url
        const status = getClientToolStatus(toolResult, streaming)
        const page: PageItem = { id: block.id, url, title, status }
        const last = steps.at(-1)
        if (last?.type === 'open') {
          last.pages.push(page)
        } else {
          steps.push({ type: 'open', pages: [page] })
        }
        return
      }
      if (toolKind === 'browser') {
        const status = getClientToolStatus(toolResult, streaming)
        const meta = toolResult?.browserAction
        const url =
          meta?.url ?? (getPartialStringField(block.input, block.inputJson, 'url') || undefined)
        const fallbackSummary = (() => {
          switch (block.name) {
            case 'browser_navigate':
              return url ? `Opening ${url}` : 'Navigating browser'
            case 'browser_observe':
              return 'Reading page'
            case 'browser_click':
              return 'Clicking element'
            case 'browser_type':
              return 'Typing text'
            case 'browser_press_key':
              return 'Pressing key'
            case 'browser_scroll':
              return 'Scrolling page'
            case 'browser_select':
              return 'Selecting option'
            case 'browser_wait':
              return 'Waiting for page'
            case 'browser_eval':
              return 'Running page script'
            case 'browser_tabs':
              return 'Managing tabs'
            case 'browser_set_viewport':
              return 'Setting viewport'
            default:
              return block.name
          }
        })()
        const item: BrowserActionItem = {
          id: block.id,
          tool: block.name,
          summary: meta?.summary ?? fallbackSummary,
          url,
          title: meta?.title,
          images: toolResult?.images,
          status,
          durationMs: toolResult?.durationMs,
          output: toolResult?.status === 'error' ? toolResult.content : undefined,
        }
        const last = steps.at(-1)
        if (last?.type === 'browser') {
          last.actions.push(item)
          last.status = mergeStatus([last.status, status])
        } else {
          steps.push({ type: 'browser', key: block.id, actions: [item], status })
        }
        return
      }
      if (toolKind === 'present_file' || toolKind === 'edit_file' || toolKind === 'read_file') {
        const status = getClientToolStatus(toolResult, streaming)
        const meta = toolResult?.fileAction
        const fileTool = meta?.tool ?? toolKind
        const path =
          meta?.path || getPartialStringField(block.input, block.inputJson, 'path') || 'file'
        const title =
          meta?.title || getPartialStringField(block.input, block.inputJson, 'title') || undefined
        const item: FileActionItem = {
          id: block.id,
          tool: fileTool,
          path,
          ...(title ? { title } : {}),
          ...(meta?.version !== undefined ? { version: meta.version } : {}),
          ...(toolResult?.files?.length ? { files: toolResult.files } : {}),
          status,
          durationMs: toolResult?.durationMs,
          ...(toolResult?.status === 'error' ? { error: toolResult.content } : {}),
        }
        const last = steps.at(-1)
        if (last?.type === 'file') {
          last.actions.push(item)
          last.status = mergeStatus([last.status, status])
        } else {
          steps.push({ type: 'file', key: block.id, actions: [item], status })
        }
        return
      }
      const input = block.input as { code?: unknown } | null
      steps.push({
        type: 'python',
        key: block.id,
        code: typeof input?.code === 'string' ? input.code : (block.inputJson ?? ''),
        result: toolResult ?? null,
      })
      return
    }
    if (block.type !== 'server_tool_use') {
      return
    }
    const result = results.get(block.id)
    // 只有签名、没有明文 URL 的网页仍用于请求，但没有可展示的链接。
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
    const status = getStatus(result, streaming)
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
      // 普通搜索按种类聚合到首次出现的位置；边想边搜只合并相邻、同种类的调用。
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
        const step: SearchStep = {
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
      // 阅读链接仅展示进行态；成功、失败或中止后隐藏，原始结果仍保留用于后续请求。
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
  return {
    steps,
    answer: answer && answer.text ? answer : null,
    sources: registry.list,
    searchResults,
  }
}

/** 思考总用时（秒）：各思考块用时之和，至少 1 秒；有块缺少用时时返回 null。 */
export const getTotalThinkingSeconds = (steps: Step[], now: number) => {
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

/** 折叠区标题 */
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
  if (
    (last?.type === 'open' && last.pages.some((page) => page.status === 'wip')) ||
    (last?.type === 'find' && last.patterns.some((item) => item.status === 'wip'))
  ) {
    return translate('groupTitleToolOpen')
  }
  if (last?.type === 'read_link' && last.links.some((link) => link.status === 'wip')) {
    return translate('readingLink')
  }
  if (last?.type === 'python' && (!last.result || last.result.status === 'running')) {
    return translate('pythonRunning')
  }
  if (last?.type === 'browser' && last.status === 'wip') {
    return translate('groupTitleToolOpen')
  }
  if (last?.type === 'file' && last.status === 'wip') {
    const lastAction = last.actions.at(-1)
    const name = lastAction?.title || lastAction?.path || ''
    if (lastAction?.tool === 'edit_file') {
      return translate('previewToolEditing', { name })
    }
    if (lastAction?.tool === 'read_file') {
      return translate('previewToolReading', { name })
    }
    return translate('previewToolPresenting', { name })
  }
  return translate('messageThinking')
}

/** 该步骤自身已显示进行中（工具行的进行态、正在输出的思考），无需另行提示仍在处理 */
const showsRunning = (step: Step): boolean => {
  switch (step.type) {
    case 'search':
    case 'browser':
    case 'file':
      return step.status === 'wip'
    case 'open':
      return step.pages.some((page) => page.status === 'wip')
    case 'read_link':
      return step.links.some((link) => link.status === 'wip')
    case 'find':
      return step.patterns.some((item) => item.status === 'wip')
    case 'python':
      return step.result === null || step.result.status === 'running'
    case 'thinking': {
      const last = step.blocks.at(-1)
      return last?.startedAt !== undefined && last.endedAt === undefined
    }
    case 'text':
      return false
  }
}

/**
 * 生成中的回复一段时间没有新内容时（服务端可能整块缓冲工具调用），是否需要显示「仍在处理」：
 * 回复已有内容，且最后一个步骤自身没有显示进行中。
 */
export const needsWorkingIndicator = (view: ReplyView): boolean => {
  const last = view.steps.at(-1)
  if (!last) {
    return view.answer !== null
  }
  return view.answer !== null || !showsRunning(last)
}
