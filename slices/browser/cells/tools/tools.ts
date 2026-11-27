import {
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_EVAL_TOOL_NAME,
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_OBSERVE_TOOL_NAME,
  BROWSER_PRESS_KEY_TOOL_NAME,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_SELECT_TOOL_NAME,
  BROWSER_SET_VIEWPORT_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME,
  BROWSER_WAIT_TOOL_NAME,
  describeAction,
  getSessionTabs,
  isHttpUrl,
  NO_HOST,
  type BrowserController,
  type BrowserHost,
  type BrowserToolRunResult,
} from '../../kernel/index.js'
import { createAgentCursor } from './agentCursor.js'
import {
  buildClickScript,
  buildPageEvalScript,
  buildPressKeyScript,
  buildScrollScript,
  buildSelectScript,
  buildSnapshotScript,
  buildTypeScript,
  buildWaitProbeScript,
} from './driver.js'
import { composeSomBadgesOnScreenshot } from './somOverlay.js'
import { resolveViewportRequest } from './viewportRequest.js'

const MAX_TOOL_TEXT_CHARS = 24_000
const MAX_DELTA_TEXT_CHARS = 4_000
const POST_TYPE_SUBMIT_DELAY_MS = 150
const POST_LOAD_SETTLE_MS = 180

type DomElementEntry = {
  ref: string
  role: string
  label: string
  inView: boolean
  noBadge?: boolean
  value?: string
  checked?: boolean
  disabled?: boolean
  expanded?: boolean
  href?: string
  options?: { value: string; text: string; selected: boolean }[]
  totalOptions?: number
  scroll?: {
    x: number
    y: number
    width: number
    height: number
    clientWidth: number
    clientHeight: number
  }
  rect: { x: number; y: number; w: number; h: number }
}

type DomIframeEntry = {
  src: string
  title: string
  inView: boolean
  rect: { x: number; y: number; w: number; h: number }
}

type DomSnapshotPayload = {
  ok: boolean
  error?: string
  url: string
  title: string
  readyState: string
  scroll: {
    x: number
    y: number
    width: number
    height: number
    viewportWidth: number
    viewportHeight: number
  }
  focused: { tag: string; label: string } | null
  totalInteractiveCount: number
  elements: DomElementEntry[]
  iframes?: DomIframeEntry[]
  pageText: string
  pageTextTotalChars?: number
}

type StaleRefInfo = {
  readonly ref: string
  readonly role: string | null
  readonly label: string | null
}

class DriverScriptError extends Error {
  readonly staleRef?: StaleRefInfo
  constructor(message: string, staleRef?: StaleRefInfo) {
    super(message)
    this.name = 'DriverScriptError'
    this.staleRef = staleRef
  }
}

type PageTextMode = 'full' | 'delta' | 'omit'

type PageTextView =
  | { readonly kind: 'omit' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'full'; readonly text: string }

const wrapUntrustedWebpageContent = (
  url: string,
  body: string,
  maxTotalChars = MAX_TOOL_TEXT_CHARS
): string => {
  const openTag = `<untrusted_webpage_content url="${url.replace(/"/g, '%22')}">`
  const closeTag = '</untrusted_webpage_content>'
  const wrapperOverhead = openTag.length + closeTag.length + 2
  const maxBodyChars = Math.max(0, maxTotalChars - wrapperOverhead)
  if (body.length <= maxBodyChars) {
    return `${openTag}\n${body}\n${closeTag}`
  }
  const suffix = `\n\n[Truncated after ${maxTotalChars.toLocaleString()} characters]`
  const sliceLen = Math.max(0, maxBodyChars - suffix.length)
  return `${openTag}\n${body.slice(0, sliceLen)}${suffix}\n${closeTag}`
}

const computePageTextDelta = (prevText: string, nextText: string): PageTextView => {
  if (prevText === nextText) {
    return { kind: 'unchanged' }
  }
  const toLines = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  const prevLines = toLines(prevText)
  const nextLines = toLines(nextText)
  if (nextLines.length === 0) {
    return { kind: 'unchanged' }
  }
  const prevCounts = new Map<string, number>()
  for (const line of prevLines) {
    prevCounts.set(line, (prevCounts.get(line) ?? 0) + 1)
  }
  const addedLines: string[] = []
  for (const line of nextLines) {
    const remaining = prevCounts.get(line) ?? 0
    if (remaining > 0) {
      prevCounts.set(line, remaining - 1)
    } else {
      addedLines.push(line)
    }
  }
  if (addedLines.length === 0) {
    return {
      kind: 'delta',
      text: '(Some page text was removed; call browser_observe to re-read full text)',
    }
  }
  const joined = addedLines.join('\n')
  if (
    addedLines.length <= Math.max(8, Math.floor(nextLines.length * 0.5)) &&
    joined.length <= MAX_DELTA_TEXT_CHARS
  ) {
    return { kind: 'delta', text: joined }
  }
  return { kind: 'full', text: nextText }
}

const stripUrlHash = (url: string): string => {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    const idx = url.indexOf('#')
    return idx >= 0 ? url.slice(0, idx) : url
  }
}

const formatElementLine = (el: DomElementEntry): string => {
  const attrs: string[] = []
  if (el.label) {
    attrs.push(JSON.stringify(el.label))
  }
  if (el.value !== undefined && el.value !== '') {
    attrs.push(`value=${JSON.stringify(el.value)}`)
  }
  if (el.checked !== undefined) {
    attrs.push(`checked=${el.checked}`)
  }
  if (el.expanded !== undefined) {
    attrs.push(`expanded=${el.expanded}`)
  }
  if (el.disabled) {
    attrs.push('disabled')
  }
  if (el.href) {
    attrs.push(`href=${JSON.stringify(el.href)}`)
  }
  if (el.options && el.options.length > 0) {
    const extra =
      el.totalOptions && el.totalOptions > el.options.length
        ? `, ... (+${el.totalOptions - el.options.length} more)`
        : ''
    attrs.push(
      `options=[${el.options.map((o) => `${JSON.stringify(o.value)}:${JSON.stringify(o.text)}${o.selected ? '*' : ''}`).join(', ')}${extra}]`
    )
  }
  if (el.scroll) {
    attrs.push(`scroll=(${el.scroll.x},${el.scroll.y})/${el.scroll.width}x${el.scroll.height}`)
  }
  if (!el.inView) {
    attrs.push('(offscreen)')
  }
  return `[${el.ref}] ${el.role}${attrs.length ? ' ' + attrs.join(' ') : ''}`
}

const formatInteractiveElements = (snap: DomSnapshotPayload, maxChars?: number): string[] => {
  const formattedLines = snap.elements.map(formatElementLine)
  const iframeLines =
    snap.iframes && snap.iframes.length > 0
      ? [
          '',
          'Cross-origin iframes (isolated by same-origin policy; open src in a tab if standalone):',
          ...snap.iframes.map((frame) => {
            const parts: string[] = []
            if (frame.title) {
              parts.push(JSON.stringify(frame.title))
            }
            if (frame.src) {
              parts.push(`src=${JSON.stringify(frame.src)}`)
            }
            parts.push(`(${frame.rect.w}x${frame.rect.h})`)
            if (!frame.inView) {
              parts.push('(offscreen)')
            }
            return `- iframe ${parts.join(' ')}`
          }),
        ]
      : []

  if (formattedLines.length === 0) {
    return ['Interactive elements: (none visible)', ...iframeLines]
  }

  let includedLines = formattedLines
  let omittedForBudget = 0
  if (typeof maxChars === 'number' && maxChars > 0) {
    const iframeReserve = iframeLines.length > 0 ? iframeLines.join('\n').length + 1 : 0
    const overheadReserve = 220
    const budgetForItems = Math.max(256, maxChars - iframeReserve - overheadReserve)
    const picked: string[] = []
    let used = 0
    for (const line of formattedLines) {
      const nextUsed = used + line.length + (picked.length > 0 ? 1 : 0)
      if (picked.length > 0 && nextUsed > budgetForItems) {
        break
      }
      picked.push(line)
      used = nextUsed
    }
    if (picked.length < formattedLines.length) {
      omittedForBudget = formattedLines.length - picked.length
      includedLines = picked
    }
  }

  const shownCount = includedLines.length
  const totalCount = Math.max(snap.totalInteractiveCount, snap.elements.length)
  const header =
    totalCount > shownCount
      ? `Interactive elements (showing ${shownCount} of ${totalCount}, in-viewport first; existing [eN] refs stay valid):`
      : `Interactive elements (showing ${shownCount} of ${totalCount}):`

  const lines = [header, ...includedLines]
  if (omittedForBudget > 0) {
    lines.push(
      `... (${omittedForBudget} more interactive elements omitted to preserve page text; scroll or pass selector to inspect more)`
    )
  }
  lines.push(...iframeLines)
  return lines
}

const formatPageTextSection = (text: string, totalChars: number, maxChars: number): string => {
  const effectiveTotal = Math.max(totalChars, text.length)
  const makeNotice = (shown: number) =>
    `\n[Page text truncated: showing ${shown.toLocaleString()} of ${effectiveTotal.toLocaleString()} chars; use browser_observe with selector or browser_eval to read other sections]`

  if (text.length <= maxChars && effectiveTotal <= text.length) {
    return text
  }
  if (effectiveTotal > text.length) {
    const notice = makeNotice(text.length)
    if (text.length + notice.length <= maxChars) {
      return `${text}${notice}`
    }
  }
  const probeNotice = makeNotice(Math.max(0, maxChars))
  const sliceLen = Math.max(0, maxChars - probeNotice.length)
  const notice = makeNotice(sliceLen)
  const finalSlice = Math.max(0, maxChars - notice.length)
  return `${text.slice(0, finalSlice)}${makeNotice(finalSlice)}`
}

const delay = (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const formatSnapshot = (
  snap: DomSnapshotPayload,
  options: {
    actionNote?: string
    textView: PageTextView
    screenshotSize?: { width: number; height: number }
  }
): string => {
  const headerLines: string[] = []
  if (options.actionNote) {
    headerLines.push(options.actionNote, '')
  }
  headerLines.push(`URL: ${snap.url}`)
  headerLines.push(`Title: ${snap.title || '(untitled)'}`)
  headerLines.push(
    `Viewport: ${snap.scroll.viewportWidth}x${snap.scroll.viewportHeight} CSS px, Scroll: (${snap.scroll.x}, ${snap.scroll.y}) of ${snap.scroll.width}x${snap.scroll.height}, State: ${snap.readyState}`
  )
  if (
    options.screenshotSize &&
    options.screenshotSize.width > 0 &&
    options.screenshotSize.height > 0
  ) {
    const { width: imgW, height: imgH } = options.screenshotSize
    const { viewportWidth: vpW, viewportHeight: vpH } = snap.scroll
    if (imgW === vpW && imgH === vpH) {
      headerLines.push(`Screenshot: ${imgW}x${imgH}px (1x CSS viewport)`)
    } else if (vpW > 0) {
      const scale = Number((imgW / vpW).toFixed(2))
      headerLines.push(
        `Screenshot: ${imgW}x${imgH}px (${scale}x vs CSS viewport; browser_click/browser_type x,y use CSS viewport px)`
      )
    } else {
      headerLines.push(`Screenshot: ${imgW}x${imgH}px`)
    }
  }
  if (snap.focused) {
    headerLines.push(
      `Focused: <${snap.focused.tag}>${snap.focused.label ? ` "${snap.focused.label}"` : ''}`
    )
  }

  const header = headerLines.join('\n')
  const remainingForWrapper = Math.max(512, MAX_TOOL_TEXT_CHARS - header.length - 2)
  const openTagLen = `<untrusted_webpage_content url="${snap.url.replace(/"/g, '%22')}">`.length
  const closeTagLen = '</untrusted_webpage_content>'.length
  const maxInnerChars = Math.max(256, remainingForWrapper - (openTagLen + closeTagLen + 2))

  const { textView } = options
  let innerLines: string[]
  if (textView.kind === 'full' && textView.text) {
    const totalTextChars = Math.max(
      snap.pageTextTotalChars ?? textView.text.length,
      textView.text.length
    )
    const sectionPrefix = '\n\nPage text:\n'
    const minReservedForText = Math.min(
      textView.text.length + 180 + sectionPrefix.length,
      Math.floor(maxInnerChars * 0.52)
    )
    const elementBudget = Math.max(1024, maxInnerChars - minReservedForText)
    innerLines = formatInteractiveElements(snap, elementBudget)
    const usedByElements = innerLines.join('\n').length
    const textBudget = Math.max(256, maxInnerChars - usedByElements - sectionPrefix.length)
    innerLines.push(
      '',
      'Page text:',
      formatPageTextSection(textView.text, totalTextChars, textBudget)
    )
  } else if (textView.kind === 'delta' && textView.text) {
    const sectionPrefix = '\n\nPage text changes:\n'
    const reservedForDelta = Math.min(
      textView.text.length + sectionPrefix.length,
      Math.floor(maxInnerChars * 0.35)
    )
    const elementBudget = Math.max(1024, maxInnerChars - reservedForDelta)
    innerLines = formatInteractiveElements(snap, elementBudget)
    innerLines.push('', 'Page text changes:', textView.text)
  } else {
    innerLines = formatInteractiveElements(snap, maxInnerChars)
    if (textView.kind === 'unchanged') {
      innerLines.push('', 'Page text: (unchanged; call browser_observe to re-read)')
    }
  }

  const wrapped = wrapUntrustedWebpageContent(snap.url, innerLines.join('\n'), remainingForWrapper)
  return `${header}\n\n${wrapped}`
}

/** Runs the browser tools against the slice's controller and the desktop host (one call at a time). */
export const createBrowserTools = (controller: BrowserController, host: BrowserHost | null) => {
  const desktop = host !== null
  const native = host ?? NO_HOST
  const {
    beginNavigationWatch,
    closeBrowserTab,
    createBrowserTab,
    ensureNativeTab,
    getActiveBrowserTab,
    getState,
    isTabOnScreen,
    navigateBrowserTab,
    setAgentAddress,
    revealBrowserPanel,
    runBrowserHistory,
    setBrowserControlling,
    setBrowserTabViewport,
    switchBrowserTab,
    syncNativeVisibility,
    waitForNavigation,
    waitForTabLoad,
  } = controller

  const lastObservedText = new Map<string, { url: string; text: string }>()

  const evalDriverJson = async <T extends { ok: boolean; error?: string; staleRef?: StaleRefInfo }>(
    tabId: string,
    script: string,
    isolatedWorld = true,
    timeoutMs = 15_000
  ): Promise<T> => {
    const raw = await native.evalJs(tabId, script, isolatedWorld, timeoutMs)
    let parsed: T
    try {
      parsed = JSON.parse(raw) as T
    } catch {
      throw new Error(`Unexpected response from browser script: ${raw.slice(0, 300)}`)
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.ok) {
      throw new DriverScriptError(
        parsed?.error || 'Browser script execution failed.',
        parsed?.staleRef
      )
    }
    return parsed
  }

  const cursor = createAgentCursor({
    evalJson: (tabId, script, timeoutMs) => evalDriverJson(tabId, script, true, timeoutMs),
    isTabOnScreen,
    setAddressText: setAgentAddress,
    delay,
  })

  const formatStaleRefRecovery = async (
    tabId: string,
    err: DriverScriptError,
    toolName: string,
    summary: string,
    startedAt: number
  ): Promise<BrowserToolRunResult> => {
    const stale = err.staleRef
    try {
      const snap = await evalDriverJson<DomSnapshotPayload>(
        tabId,
        buildSnapshotScript({ includeText: false }),
        true
      )
      const innerLines: string[] = []
      if (stale?.label) {
        const needle = stale.label.toLowerCase()
        const exact = snap.elements.filter(
          (el) => el.label.toLowerCase() === needle && (!stale.role || el.role === stale.role)
        )
        const byLabel =
          exact.length > 0 ? exact : snap.elements.filter((el) => el.label.toLowerCase() === needle)
        if (byLabel.length > 0) {
          innerLines.push(
            'Possible replacement element(s):',
            ...byLabel.slice(0, 5).map(formatElementLine),
            ''
          )
        }
      }
      innerLines.push(...formatInteractiveElements(snap))
      const header = `${err.message} Refreshed interactive elements are included below; retry with a current [eN] ref.`
      const wrapped = wrapUntrustedWebpageContent(
        snap.url,
        innerLines.join('\n'),
        Math.max(512, MAX_TOOL_TEXT_CHARS - header.length - 2)
      )
      return {
        status: 'error',
        text: `${header}\n\n${wrapped}`,
        images: [],
        meta: { tool: toolName, summary, url: snap.url, title: snap.title },
        durationMs: Date.now() - startedAt,
      }
    } catch {
      return {
        status: 'error',
        text: err.message,
        images: [],
        meta: { tool: toolName, summary },
        durationMs: Date.now() - startedAt,
      }
    }
  }

  const resolveWorkingTab = async (sessionId: string, requestedTabId?: string): Promise<string> => {
    await revealBrowserPanel(sessionId)
    const session = getSessionTabs(getState(), sessionId)
    if (requestedTabId) {
      const found = session.tabs.find((t) => t.id === requestedTabId)
      if (!found) {
        throw new Error(`Unknown browser tab in this session: ${requestedTabId}`)
      }
      if (session.activeTabId !== found.id) {
        await switchBrowserTab(found.id)
      }
      return found.id
    }
    const active = getActiveBrowserTab(sessionId)
    if (active) {
      return active.id
    }
    const created = await createBrowserTab('about:blank', { sessionId, activate: true })
    return created.id
  }

  const captureSnapshotAndOptionalImage = async (
    sessionId: string,
    tabId: string,
    options: {
      includeScreenshot?: boolean
      textMode?: PageTextMode
      selector?: string
      actionNote?: string
    }
  ): Promise<{
    text: string
    images: string[]
    previewImages: string[]
    url: string
    title: string
  }> => {
    const tab = getSessionTabs(getState(), sessionId).tabs.find((t) => t.id === tabId)
    if (!tab || !isHttpUrl(tab.url)) {
      return {
        text: `${options.actionNote ? options.actionNote + '\n\n' : ''}The active browser tab is blank (about:blank). Call browser_navigate with an http:// or https:// URL first.`,
        images: [],
        previewImages: [],
        url: 'about:blank',
        title: 'New tab',
      }
    }
    await ensureNativeTab(tabId)
    const textMode = options.textMode ?? 'full'
    const includeText = textMode !== 'omit'
    const snap = await evalDriverJson<DomSnapshotPayload>(
      tabId,
      buildSnapshotScript({
        includeText,
        selector: options.selector,
        hideCursor: options.includeScreenshot === true,
      }),
      true
    )
    const normalizedSnapUrl = stripUrlHash(snap.url)
    let textView: PageTextView
    if (textMode === 'omit') {
      textView = { kind: 'omit' }
    } else if (textMode === 'delta') {
      const prev = lastObservedText.get(tabId)
      textView =
        prev && prev.url === normalizedSnapUrl
          ? computePageTextDelta(prev.text, snap.pageText)
          : { kind: 'full', text: snap.pageText }
      if (!options.selector) {
        lastObservedText.set(tabId, { url: normalizedSnapUrl, text: snap.pageText })
      }
    } else {
      textView = { kind: 'full', text: snap.pageText }
      if (!options.selector) {
        lastObservedText.set(tabId, { url: normalizedSnapUrl, text: snap.pageText })
      }
    }
    const images: string[] = []
    const previewImages: string[] = []
    let screenshotSize: { width: number; height: number } | undefined
    if (options.includeScreenshot) {
      // Capture one clean screenshot for the user-facing transcript, then composite `[eN]` SoM
      // badges deterministically onto a copy for the model (no page DOM mutation or paint race).
      const cleanShot = await native
        .takeSnapshot(tabId, 1280)
        // The snapshot script hid the agent cursor so the capture stays clean; bring it back.
        .finally(() => cursor.restoreAfterCapture(tabId))
      previewImages.push(cleanShot.dataUrl)
      const shotW = cleanShot.pixelWidth ?? cleanShot.width
      const shotH = cleanShot.pixelHeight ?? cleanShot.height
      if (shotW > 0 && shotH > 0) {
        screenshotSize = { width: shotW, height: shotH }
      }
      const badgeElements = snap.elements.filter((el) => !el.noBadge)
      const annotated = await composeSomBadgesOnScreenshot(cleanShot.dataUrl, badgeElements, {
        width: snap.scroll.viewportWidth,
        height: snap.scroll.viewportHeight,
      })
      images.push(annotated)
    }
    return {
      text: formatSnapshot(snap, {
        actionNote: options.actionNote,
        textView,
        screenshotSize,
      }),
      images,
      previewImages,
      url: snap.url,
      title: snap.title,
    }
  }

  let browserQueue: Promise<void> = Promise.resolve()

  const runBrowserTool = (
    toolName: string,
    rawInput: unknown,
    signal: AbortSignal,
    sessionId?: string
  ): Promise<BrowserToolRunResult> => {
    const startedAt = Date.now()
    if (!desktop) {
      return Promise.resolve({
        status: 'error',
        text: 'The built-in browser is only available in the DeepSeek desktop app.',
        images: [],
        meta: { tool: toolName, summary: toolName },
        durationMs: 0,
      })
    }
    if (signal.aborted) {
      return Promise.resolve({
        status: 'aborted',
        text: 'Aborted by user.',
        images: [],
        meta: { tool: toolName, summary: toolName },
        durationMs: 0,
      })
    }
    return new Promise((resolve) => {
      let started = false
      const onQueuedAbort = () => {
        if (!started) {
          resolve({
            status: 'aborted',
            text: 'Aborted by user.',
            images: [],
            meta: { tool: toolName, summary: toolName },
            durationMs: Date.now() - startedAt,
          })
        }
      }
      signal.addEventListener('abort', onQueuedAbort, { once: true })
      const task = browserQueue.then(async () => {
        signal.removeEventListener('abort', onQueuedAbort)
        if (signal.aborted) {
          return {
            status: 'aborted' as const,
            text: 'Aborted by user.',
            images: [],
            meta: { tool: toolName, summary: toolName },
            durationMs: Date.now() - startedAt,
          }
        }
        started = true
        return executeBrowserTool(toolName, rawInput, signal, startedAt, sessionId)
      })
      browserQueue = task.then(
        () => {},
        () => {}
      )
      void task.then(resolve)
    })
  }

  const executeBrowserTool = async (
    toolName: string,
    rawInput: unknown,
    signal: AbortSignal,
    startedAt: number,
    sessionId?: string
  ): Promise<BrowserToolRunResult> => {
    const input =
      rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : {}
    const targetSessionId = sessionId ?? getState().activeSessionId
    if (!targetSessionId) {
      return {
        status: 'error',
        text: 'Start or select a chat session before using the built-in browser.',
        images: [],
        meta: { tool: toolName, summary: describeAction(toolName, input) },
        durationMs: Date.now() - startedAt,
      }
    }
    const summary = describeAction(toolName, input)
    setBrowserControlling(true, summary, targetSessionId)

    try {
      switch (toolName) {
        case BROWSER_TABS_TOOL_NAME: {
          const action = typeof input.action === 'string' ? input.action : ''
          await revealBrowserPanel(targetSessionId)
          if (action === 'list') {
            const { tabs, activeTabId } = getSessionTabs(getState(), targetSessionId)
            const text = tabs
              .map(
                (t) =>
                  `${t.id === activeTabId ? '* ' : '  '}${t.id}: ${t.title || '(untitled)'} — ${t.url}`
              )
              .join('\n')
            return {
              status: 'ok',
              text: text || 'No open tabs.',
              images: [],
              meta: { tool: toolName, summary: 'Listed browser tabs' },
              durationMs: Date.now() - startedAt,
            }
          }
          const shownTabId = getActiveBrowserTab(targetSessionId)?.id ?? null
          if (action === 'new') {
            const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : ''
            if (shownTabId) {
              await cursor.pressChrome(shownTabId, 'new-tab', signal)
            }
            const tab = await createBrowserTab(url || 'about:blank', {
              sessionId: targetSessionId,
              activate: true,
              initiator: 'model',
            })
            if (url && isHttpUrl(tab.url)) {
              await waitForTabLoad(tab.id, signal, 15_000)
              await delay(POST_LOAD_SETTLE_MS, signal)
            }
            const observed = await captureSnapshotAndOptionalImage(targetSessionId, tab.id, {
              actionNote: `Opened new tab ${tab.id}.`,
            })
            return {
              status: 'ok',
              text: observed.text,
              images: observed.images,
              meta: {
                tool: toolName,
                summary: `Opened tab ${tab.id}`,
                url: observed.url,
                title: observed.title,
              },
              durationMs: Date.now() - startedAt,
            }
          }
          if (action === 'switch') {
            const tabId = typeof input.tab_id === 'string' ? input.tab_id : ''
            if (!tabId) {
              throw new Error('tab_id is required when action is "switch".')
            }
            const sessionTabs = getSessionTabs(getState(), targetSessionId).tabs
            if (!sessionTabs.some((t) => t.id === tabId)) {
              throw new Error(`Unknown browser tab in this session: ${tabId}`)
            }
            if (shownTabId) {
              await cursor.pressChrome(shownTabId, `tab:${tabId}`, signal)
            }
            await switchBrowserTab(tabId)
            const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
              textMode: 'omit',
              actionNote: `Switched to tab ${tabId}.`,
            })
            return {
              status: 'ok',
              text: observed.text,
              images: observed.images,
              meta: {
                tool: toolName,
                summary: `Switched to ${tabId}`,
                url: observed.url,
                title: observed.title,
              },
              durationMs: Date.now() - startedAt,
            }
          }
          if (action === 'close') {
            const tabId =
              typeof input.tab_id === 'string' && input.tab_id
                ? input.tab_id
                : (getActiveBrowserTab(targetSessionId)?.id ?? '')
            const sessionTabs = getSessionTabs(getState(), targetSessionId).tabs
            if (!tabId || !sessionTabs.some((t) => t.id === tabId)) {
              throw new Error('No matching tab in this session to close.')
            }
            lastObservedText.delete(tabId)
            if (shownTabId) {
              await cursor.pressChrome(shownTabId, `close:${tabId}`, signal)
            }
            cursor.forgetTab(tabId)
            await closeBrowserTab(tabId)
            const afterSession = getSessionTabs(getState(), targetSessionId)
            const nextActive = afterSession.tabs.find((t) => t.id === afterSession.activeTabId)
            const closeText = nextActive
              ? `Closed tab ${tabId}. Active tab is now ${nextActive.id}: ${nextActive.title || '(untitled)'} (${nextActive.url}).`
              : `Closed tab ${tabId}. No tabs remain; browser panel closed.`
            return {
              status: 'ok',
              text: closeText,
              images: [],
              meta: {
                tool: toolName,
                summary: `Closed tab ${tabId}`,
                ...(nextActive ? { url: nextActive.url, title: nextActive.title } : {}),
              },
              durationMs: Date.now() - startedAt,
            }
          }
          throw new Error(`Invalid browser_tabs action: ${action}`)
        }

        case BROWSER_NAVIGATE_TOOL_NAME: {
          const action =
            typeof input.action === 'string' ? input.action : input.url ? 'goto' : 'reload'
          const tabId = await resolveWorkingTab(
            targetSessionId,
            typeof input.tab_id === 'string' ? input.tab_id : undefined
          )
          if (action === 'goto') {
            const url = typeof input.url === 'string' ? input.url.trim() : ''
            if (!url) {
              throw new Error('url is required when action is "goto".')
            }
            await cursor.pressChrome(tabId, 'address', signal)
            try {
              await cursor.typeAddress(tabId, url, signal)
              await navigateBrowserTab(tabId, url, 'model')
              await waitForTabLoad(tabId, signal, 15_000)
            } finally {
              setAgentAddress(tabId, null)
            }
            await delay(POST_LOAD_SETTLE_MS, signal)
          } else if (action === 'reload') {
            await cursor.pressChrome(tabId, 'reload', signal)
            await runBrowserHistory(tabId, action)
            await waitForTabLoad(tabId, signal, 15_000)
            await delay(POST_LOAD_SETTLE_MS, signal)
          } else if (action === 'back' || action === 'forward') {
            const currentTab = getSessionTabs(getState(), targetSessionId).tabs.find(
              (t) => t.id === tabId
            )
            const expectsNav =
              action === 'back' ? Boolean(currentTab?.canGoBack) : Boolean(currentTab?.canGoForward)
            await cursor.pressChrome(tabId, action, signal)
            const navWatch = beginNavigationWatch(tabId)
            await runBrowserHistory(tabId, action)
            const { navigated } = await waitForNavigation(navWatch, {
              expectsNavigation: expectsNav,
              settleMs: 250,
              loadTimeoutMs: 15_000,
              signal,
            })
            if (navigated) {
              await delay(POST_LOAD_SETTLE_MS, signal)
            }
          } else {
            throw new Error(`Invalid navigation action: ${action}`)
          }
          const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
            includeScreenshot: input.screenshot === true,
            textMode: input.text === false ? 'omit' : 'full',
            actionNote:
              action === 'goto' ? `Navigated to ${String(input.url)}.` : `Performed ${action}.`,
          })
          return {
            status: 'ok',
            text: observed.text,
            images: observed.images,
            ...(observed.previewImages.length > 0 ? { previewImages: observed.previewImages } : {}),
            meta: {
              tool: toolName,
              summary,
              url: observed.url,
              title: observed.title,
            },
            durationMs: Date.now() - startedAt,
          }
        }

        case BROWSER_OBSERVE_TOOL_NAME: {
          const tabId = await resolveWorkingTab(
            targetSessionId,
            typeof input.tab_id === 'string' ? input.tab_id : undefined
          )
          const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
            includeScreenshot: input.screenshot === true,
            textMode: input.text === false ? 'omit' : 'full',
            selector: typeof input.selector === 'string' ? input.selector : undefined,
          })
          return {
            status: 'ok',
            text: observed.text,
            images: observed.images,
            ...(observed.previewImages.length > 0 ? { previewImages: observed.previewImages } : {}),
            meta: {
              tool: toolName,
              summary,
              url: observed.url,
              title: observed.title,
            },
            durationMs: Date.now() - startedAt,
          }
        }

        case BROWSER_CLICK_TOOL_NAME: {
          const tabId = await resolveWorkingTab(targetSessionId)
          const active = getSessionTabs(getState(), targetSessionId).tabs.find(
            (t) => t.id === tabId
          )
          if (!active || !isHttpUrl(active.url)) {
            throw new Error('No page is loaded in the active browser tab.')
          }
          await ensureNativeTab(tabId)
          await cursor.toTarget(
            tabId,
            {
              ref: typeof input.ref === 'string' ? input.ref : undefined,
              x: typeof input.x === 'number' ? input.x : undefined,
              y: typeof input.y === 'number' ? input.y : undefined,
            },
            signal
          )
          const navWatch = beginNavigationWatch(tabId)
          let clickRes: {
            ok: boolean
            tag?: string
            text?: string
            href?: string
            expectsNavigation?: boolean
          }
          try {
            clickRes = await evalDriverJson(
              tabId,
              buildClickScript({
                ref: typeof input.ref === 'string' ? input.ref : undefined,
                x: typeof input.x === 'number' ? input.x : undefined,
                y: typeof input.y === 'number' ? input.y : undefined,
                button:
                  input.button === 'right' || input.button === 'middle' ? input.button : 'left',
                doubleClick: input.double_click === true,
              }),
              true
            )
          } catch (err) {
            if (err instanceof DriverScriptError && err.staleRef) {
              return formatStaleRefRecovery(tabId, err, toolName, summary, startedAt)
            }
            throw err
          }
          const { navigated } = await waitForNavigation(navWatch, {
            expectsNavigation: Boolean(clickRes.expectsNavigation),
            settleMs: 250,
            loadTimeoutMs: 10_000,
            signal,
          })
          if (navigated) {
            await delay(POST_LOAD_SETTLE_MS, signal)
          }
          const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
            includeScreenshot: input.screenshot === true,
            textMode: navigated ? 'full' : 'delta',
            actionNote: `Clicked <${clickRes.tag ?? 'element'}>${clickRes.text ? ` "${clickRes.text}"` : ''}.`,
          })
          return {
            status: 'ok',
            text: observed.text,
            images: observed.images,
            ...(observed.previewImages.length > 0 ? { previewImages: observed.previewImages } : {}),
            meta: {
              tool: toolName,
              summary,
              url: observed.url,
              title: observed.title,
            },
            durationMs: Date.now() - startedAt,
          }
        }

        case BROWSER_TYPE_TOOL_NAME: {
          const tabId = await resolveWorkingTab(targetSessionId)
          const text = typeof input.text === 'string' ? input.text : null
          if (text === null) {
            throw new Error('text (string) is required for browser_type.')
          }
          const shouldSubmit = input.submit === true
          const ref = typeof input.ref === 'string' ? input.ref : undefined
          await ensureNativeTab(tabId)
          await cursor.toTarget(
            tabId,
            {
              ref,
              x: typeof input.x === 'number' ? input.x : undefined,
              y: typeof input.y === 'number' ? input.y : undefined,
            },
            signal
          )
          try {
            await evalDriverJson(
              tabId,
              buildTypeScript({
                ref,
                x: typeof input.x === 'number' ? input.x : undefined,
                y: typeof input.y === 'number' ? input.y : undefined,
                text,
                clear: input.clear !== false,
                emitChange: !shouldSubmit,
              }),
              true
            )
          } catch (err) {
            if (err instanceof DriverScriptError && err.staleRef) {
              return formatStaleRefRecovery(tabId, err, toolName, summary, startedAt)
            }
            throw err
          }
          let navigated = false
          if (shouldSubmit) {
            await delay(POST_TYPE_SUBMIT_DELAY_MS, signal)
            const navWatch = beginNavigationWatch(tabId)
            const pressRes = await evalDriverJson<{
              ok: boolean
              expectsNavigation?: boolean
            }>(tabId, buildPressKeyScript({ key: 'Enter', fallbackRef: ref }), true)
            const waited = await waitForNavigation(navWatch, {
              expectsNavigation: Boolean(pressRes.expectsNavigation),
              settleMs: 300,
              loadTimeoutMs: 10_000,
              signal,
            })
            navigated = waited.navigated
            if (navigated) {
              await delay(POST_LOAD_SETTLE_MS, signal)
            }
          } else {
            await delay(120, signal)
          }
          const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
            textMode: navigated ? 'full' : 'delta',
            actionNote: `Typed ${text.length} characters${shouldSubmit ? ' and submitted' : ''}.`,
          })
          return {
            status: 'ok',
            text: observed.text,
            images: observed.images,
            meta: {
              tool: toolName,
              summary,
              url: observed.url,
              title: observed.title,
            },
            durationMs: Date.now() - startedAt,
          }
        }

        case BROWSER_PRESS_KEY_TOOL_NAME: {
          const tabId = await resolveWorkingTab(targetSessionId)
          const key = typeof input.key === 'string' ? input.key : ''
          if (!key) {
            throw new Error('key is required for browser_press_key.')
          }
          const modifiers = Array.isArray(input.modifiers)
            ? input.modifiers.filter((m): m is 'meta' | 'ctrl' | 'alt' | 'shift' =>
                ['meta', 'ctrl', 'alt', 'shift'].includes(String(m))
              )
            : undefined
          await ensureNativeTab(tabId)
          // The cursor goes to the focused element (or stays where it is) and presses with the key.
          await cursor.toTarget(tabId, {}, signal)
          await cursor.pressInPage(tabId)
          const navWatch = beginNavigationWatch(tabId)
          const pressRes = await evalDriverJson<{ ok: boolean; expectsNavigation?: boolean }>(
            tabId,
            buildPressKeyScript({ key, modifiers }),
            true
          )
          const { navigated } = await waitForNavigation(navWatch, {
            expectsNavigation: Boolean(pressRes.expectsNavigation),
            settleMs: 180,
            loadTimeoutMs: 8_000,
            signal,
          })
          if (navigated) {
            await delay(POST_LOAD_SETTLE_MS, signal)
          }
          const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
            textMode: navigated ? 'full' : 'delta',
            actionNote: `Pressed key "${key}".`,
          })
          return {
            status: 'ok',
            text: observed.text,
            images: observed.images,
            meta: { tool: toolName, summary, url: observed.url, title: observed.title },
            durationMs: Date.now() - startedAt,
          }
        }

        case BROWSER_SCROLL_TOOL_NAME: {
          const tabId = await resolveWorkingTab(targetSessionId)
          await ensureNativeTab(tabId)
          const direction =
            input.direction === 'up' ||
            input.direction === 'down' ||
            input.direction === 'left' ||
            input.direction === 'right'
              ? input.direction
              : 'down'
          const to = input.to === 'top' || input.to === 'bottom' ? input.to : undefined
          const ref =
            typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : undefined
          // The cursor rides along where it is (or comes to the middle of the page) while it scrolls.
          await cursor.toTarget(tabId, { stay: true }, signal)
          let scrollRes: {
            ok: boolean
            isContainer?: boolean
            scrollX?: number
            scrollY?: number
            scrollWidth?: number
            scrollHeight?: number
          }
          try {
            scrollRes = await evalDriverJson(
              tabId,
              buildScrollScript({
                direction,
                amount: typeof input.amount === 'number' ? input.amount : undefined,
                ref,
                to,
              }),
              true
            )
          } catch (err) {
            if (err instanceof DriverScriptError && err.staleRef) {
              return formatStaleRefRecovery(tabId, err, toolName, summary, startedAt)
            }
            throw err
          }
          await delay(100, signal)
          const actionNote =
            scrollRes.isContainer && ref
              ? to
                ? `Scrolled [${ref.replace(/^@/, '')}] to ${to} (${scrollRes.scrollX ?? 0}, ${scrollRes.scrollY ?? 0}) of ${scrollRes.scrollWidth ?? 0}x${scrollRes.scrollHeight ?? 0}.`
                : `Scrolled [${ref.replace(/^@/, '')}] ${direction} to (${scrollRes.scrollX ?? 0}, ${scrollRes.scrollY ?? 0}) of ${scrollRes.scrollWidth ?? 0}x${scrollRes.scrollHeight ?? 0}.`
              : to
                ? `Scrolled to ${to}.`
                : `Scrolled ${direction}.`
          const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
            textMode: input.text === true ? 'full' : 'omit',
            actionNote,
          })
          return {
            status: 'ok',
            text: observed.text,
            images: observed.images,
            meta: { tool: toolName, summary, url: observed.url, title: observed.title },
            durationMs: Date.now() - startedAt,
          }
        }

        case BROWSER_SELECT_TOOL_NAME: {
          const tabId = await resolveWorkingTab(targetSessionId)
          const ref = typeof input.ref === 'string' ? input.ref : ''
          const values = Array.isArray(input.values) ? input.values.map(String) : []
          if (!ref || values.length === 0) {
            throw new Error('ref and values[] are required for browser_select.')
          }
          await ensureNativeTab(tabId)
          await cursor.toTarget(tabId, { ref }, signal)
          const navWatch = beginNavigationWatch(tabId)
          try {
            await evalDriverJson(tabId, buildSelectScript({ ref, values }), true)
          } catch (err) {
            if (err instanceof DriverScriptError && err.staleRef) {
              return formatStaleRefRecovery(tabId, err, toolName, summary, startedAt)
            }
            throw err
          }
          const { navigated } = await waitForNavigation(navWatch, {
            expectsNavigation: false,
            settleMs: 120,
            loadTimeoutMs: 8_000,
            signal,
          })
          const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
            textMode: navigated ? 'full' : 'delta',
            actionNote: `Selected ${values.join(', ')} on [${ref}].`,
          })
          return {
            status: 'ok',
            text: observed.text,
            images: observed.images,
            meta: { tool: toolName, summary, url: observed.url, title: observed.title },
            durationMs: Date.now() - startedAt,
          }
        }

        case BROWSER_WAIT_TOOL_NAME: {
          const tabId = await resolveWorkingTab(targetSessionId)
          await ensureNativeTab(tabId)
          const fixedMs =
            typeof input.ms === 'number' && input.ms > 0 ? Math.min(input.ms, 10_000) : 0
          if (fixedMs > 0) {
            await delay(fixedMs, signal)
          }
          const selector = typeof input.selector === 'string' ? input.selector : undefined
          const text = typeof input.text === 'string' ? input.text : undefined
          const urlContains =
            typeof input.url_contains === 'string' ? input.url_contains : undefined
          if (selector || text || urlContains) {
            const timeoutMs =
              typeof input.timeout_ms === 'number' && input.timeout_ms > 0
                ? Math.min(input.timeout_ms, 15_000)
                : 10_000
            const deadline = Date.now() + timeoutMs
            let matched = false
            while (!matched && Date.now() < deadline) {
              signal.throwIfAborted()
              const probe = await evalDriverJson<{ ok: boolean; matched: boolean }>(
                tabId,
                buildWaitProbeScript({ selector, text, urlContains }),
                true
              )
              if (probe.matched) {
                matched = true
                break
              }
              await delay(250, signal)
            }
            if (!matched) {
              throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`)
            }
          }
          const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
            textMode: 'full',
            actionNote: 'Wait condition satisfied.',
          })
          return {
            status: 'ok',
            text: observed.text,
            images: observed.images,
            meta: { tool: toolName, summary, url: observed.url, title: observed.title },
            durationMs: Date.now() - startedAt,
          }
        }

        case BROWSER_EVAL_TOOL_NAME: {
          const tabId = await resolveWorkingTab(targetSessionId)
          const script = typeof input.script === 'string' ? input.script : ''
          if (!script.trim()) {
            throw new Error('script is required for browser_eval.')
          }
          await ensureNativeTab(tabId)
          const raw = await native.evalJs(tabId, buildPageEvalScript(script), false, 15_000)
          let parsed: { ok: boolean; value?: unknown; error?: string }
          try {
            parsed = JSON.parse(raw) as { ok: boolean; value?: unknown; error?: string }
          } catch {
            parsed = { ok: true, value: raw }
          }
          if (!parsed.ok) {
            throw new Error(parsed.error || 'JavaScript evaluation failed.')
          }
          const formatted =
            typeof parsed.value === 'string'
              ? parsed.value
              : (JSON.stringify(parsed.value, null, 2) ?? 'null')
          const active = getSessionTabs(getState(), targetSessionId).tabs.find(
            (t) => t.id === tabId
          )
          return {
            status: 'ok',
            text: wrapUntrustedWebpageContent(active?.url ?? '', formatted),
            images: [],
            meta: { tool: toolName, summary, url: active?.url, title: active?.title },
            durationMs: Date.now() - startedAt,
          }
        }

        case BROWSER_SET_VIEWPORT_TOOL_NAME: {
          const tabId = await resolveWorkingTab(
            targetSessionId,
            typeof input.tab_id === 'string' ? input.tab_id : undefined
          )
          const stateBefore = getState()
          const currentTab = getSessionTabs(stateBefore, targetSessionId).tabs.find(
            (t) => t.id === tabId
          )
          const spec = resolveViewportRequest(
            {
              preset: typeof input.preset === 'string' ? input.preset : undefined,
              width: typeof input.width === 'number' ? input.width : undefined,
              height: typeof input.height === 'number' ? input.height : undefined,
              aspect_ratio: typeof input.aspect_ratio === 'string' ? input.aspect_ratio : undefined,
            },
            currentTab?.viewport ?? stateBefore.stageSize
          )
          const fit = await setBrowserTabViewport(tabId, spec)
          await delay(120, signal)
          await syncNativeVisibility()
          const latestTab = getSessionTabs(getState(), targetSessionId).tabs.find(
            (t) => t.id === tabId
          )
          const effectiveZoom = latestTab?.zoom ?? fit.zoom
          const pct = Math.round(effectiveZoom * 100)
          const note = spec
            ? `Viewport set to ${spec.width}x${spec.height} (fitted inside panel at ${pct}% scale${fit.clipped ? '; clamped at 25% minimum zoom' : ''}).`
            : 'Viewport reset to fit panel (100% scale).'
          const observed = await captureSnapshotAndOptionalImage(targetSessionId, tabId, {
            includeScreenshot: input.screenshot === true,
            textMode: 'omit',
            actionNote: note,
          })
          return {
            status: 'ok',
            text: observed.text,
            images: observed.images,
            ...(observed.previewImages.length > 0 ? { previewImages: observed.previewImages } : {}),
            meta: {
              tool: toolName,
              summary: spec
                ? `Viewport ${spec.width}×${spec.height} (${pct}%)`
                : 'Viewport Fit panel',
              url: observed.url,
              title: observed.title,
            },
            durationMs: Date.now() - startedAt,
          }
        }

        default:
          throw new Error(`Unknown browser tool: ${toolName}`)
      }
    } catch (error) {
      if (signal.aborted) {
        return {
          status: 'aborted',
          text: 'Aborted by user.',
          images: [],
          meta: { tool: toolName, summary },
          durationMs: Date.now() - startedAt,
        }
      }
      return {
        status: 'error',
        text: error instanceof Error ? error.message : String(error),
        images: [],
        meta: { tool: toolName, summary },
        durationMs: Date.now() - startedAt,
      }
    } finally {
      setBrowserControlling(false)
    }
  }

  return {
    runBrowserTool,
    /** Puts the agent cursor away in a chat's tabs (its reply finished, or the reader took over). */
    hideCursor: (sessionId: string) => {
      cursor.hide(getSessionTabs(getState(), sessionId).tabs.map((t) => t.id))
    },
    dispose: () => {
      lastObservedText.clear()
      cursor.dispose()
    },
  }
}
