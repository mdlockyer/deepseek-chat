import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PanelLayout, PanelSlot } from '@deepseek-chat/spine/ports'
import type { BrowserControlTakenOver } from '@deepseek-chat/spine/facts/browser'
import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionHistoryReplaced,
} from '@deepseek-chat/spine/facts/session'
import { memoryStore } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  computeSomBadgeBoxes,
  createBrowserSlice,
  isHttpUrl,
  normalizeOmniboxInput,
  type BrowserHost,
  type BrowserTabStatePayload,
} from '@deepseek-chat/slice-browser'

// ---------- fakes ----------

const SNAPSHOT = {
  ok: true,
  url: 'https://example.com/',
  title: 'Example',
  readyState: 'complete',
  scroll: { x: 0, y: 0, width: 800, height: 600, viewportWidth: 800, viewportHeight: 600 },
  focused: null,
  totalInteractiveCount: 0,
  elements: [],
  pageText: 'Hello page',
}

type AsyncFn = new (body: string) => () => Promise<string>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as AsyncFn

/** Desktop host double: records what it is told; pages "load" right after navigation. */
const fakeHost = () => {
  const calls: { name: string; args: unknown[] }[] = []
  const scripts: { script: string; isolated: boolean }[] = []
  const stateHandlers = new Set<(p: BrowserTabStatePayload) => void>()
  const lastActive: { tabId: string | null; visible: boolean | null } = {
    tabId: null,
    visible: null,
  }
  const record =
    (name: string, result: unknown = undefined) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
      return Promise.resolve(result)
    }
  const host: BrowserHost = {
    setOptions: record('setOptions') as BrowserHost['setOptions'],
    createTab: record('createTab') as BrowserHost['createTab'],
    closeTab: record('closeTab') as BrowserHost['closeTab'],
    setActiveTab: (tabId, bounds, visible, zoom) => {
      calls.push({ name: 'setActiveTab', args: [tabId, bounds, visible, zoom] })
      lastActive.tabId = tabId
      lastActive.visible = visible
      return Promise.resolve()
    },
    setBounds: record('setBounds') as BrowserHost['setBounds'],
    setZoom: (tabId, zoom) => {
      calls.push({ name: 'setZoom', args: [tabId, zoom] })
      return Promise.resolve(zoom)
    },
    setVisible: (visible) => {
      calls.push({ name: 'setVisible', args: [visible] })
      lastActive.visible = visible
      return Promise.resolve()
    },
    navigate: (tabId, url, initiator) => {
      calls.push({ name: 'navigate', args: [tabId, url, initiator] })
      setTimeout(() => {
        for (const handler of stateHandlers) {
          handler({
            tabId,
            url,
            title: 'Example',
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
          })
        }
      }, 0)
      return Promise.resolve(url)
    },
    history: record('history') as BrowserHost['history'],
    getState: record('getState', {
      url: '',
      canGoBack: false,
      canGoForward: false,
    }) as BrowserHost['getState'],
    evalJs: async (_tabId, script, isolated) => {
      scripts.push({ script, isolated })
      // Page-world scripts (browser_eval) really run; driver scripts get a snapshot-shaped reply.
      return isolated ? JSON.stringify(SNAPSHOT) : new AsyncFunction(script)()
    },
    takeSnapshot: record('takeSnapshot', {
      dataUrl: 'data:image/png;base64,AA',
      width: 1,
      height: 1,
    }) as BrowserHost['takeSnapshot'],
    clearData: record('clearData') as BrowserHost['clearData'],
    openDevtools: record('openDevtools') as BrowserHost['openDevtools'],
    onState: (handler) => {
      stateHandlers.add(handler)
      return () => {
        stateHandlers.delete(handler)
      }
    },
    onNewTabRequested: () => () => {},
    onNavigationBlocked: () => () => {},
    onDownloadBlocked: () => () => {},
  }
  const named = (name: string) => calls.filter((call) => call.name === name)
  return { host, calls, scripts, lastActive, named }
}

/** The app's right panel, reduced to the rules a slot sees (one kind per chat, open animation). */
const fakePanel = () => {
  const shown = new Map<string, 'browser' | 'other'>()
  let layout: PanelLayout = {
    activeSessionId: null,
    animating: false,
    resizing: false,
    overlayLocked: false,
    width: 540,
  }
  const listeners = new Set<() => void>()
  const update = (next: Partial<PanelLayout>) => {
    layout = { ...layout, ...next }
    for (const listener of [...listeners]) {
      listener()
    }
  }
  const slot: PanelSlot = {
    useStageSize: () => null,
    setStageSize: () => {},
    setResizing: (resizing) => update({ resizing }),
    isResizing: () => layout.resizing,
    isOpen: (sessionId) => sessionId !== null && shown.get(sessionId) === 'browser',
    open: (sessionId) => {
      const wasEmpty = !shown.has(sessionId)
      shown.set(sessionId, 'browser')
      update(wasEmpty && layout.activeSessionId === sessionId ? { animating: true } : {})
    },
    close: (sessionId) => {
      if (shown.get(sessionId) === 'browser') {
        shown.delete(sessionId)
        update(layout.activeSessionId === sessionId ? { animating: false } : {})
      }
    },
    setAnimating: (animating) => update({ animating }),
    getLayout: () => layout,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    useLayout: (select) => select(layout),
  }
  return {
    slot,
    setActive: (sessionId: string | null) => {
      // As the app: switching chats animates the panel when its open state changes.
      const isShown = (id: string | null) => id !== null && shown.has(id)
      const animating = isShown(layout.activeSessionId) !== isShown(sessionId)
      update({ activeSessionId: sessionId, animating })
    },
    finishAnimation: () => update({ animating: false }),
    setOverlayLocked: (overlayLocked: boolean) => update({ overlayLocked }),
    showOther: (sessionId: string) => {
      shown.set(sessionId, 'other')
      update({})
    },
  }
}

let counter = 0
const setup = (options: { desktop?: boolean; store?: ReturnType<typeof memoryStore> } = {}) => {
  const host = fakeHost()
  const panel = fakePanel()
  const log = new EventLog()
  const opened: string[] = []
  const browser = createBrowserSlice({
    log,
    host: options.desktop === false ? null : host.host,
    panel: panel.slot,
    store: options.store ?? memoryStore(),
    openExternal: async (url) => {
      opened.push(url)
    },
    newId: () => `id${++counter}`,
  })
  /** What the app does on a chat switch: the panel first, then the sticky ActiveSessionChanged fact. */
  const activate = (sessionId: string | null) => {
    panel.setActive(sessionId)
    log.publishSticky<ActiveSessionChanged>('unit', { type: 'ActiveSessionChanged', sessionId })
  }
  return { browser, host, panel, log, opened, activate }
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
const signal = () => new AbortController().signal

/** Desktop chat `s1` on screen with a loaded page, panel open and its animation finished. */
const withVisiblePage = async () => {
  const env = setup()
  env.browser.start()
  env.activate('s1')
  await env.browser.openUrl('https://example.com/', { initiator: 'model' })
  env.panel.finishAnimation()
  await settle()
  return env
}

// ---------- tests ----------

describe('browser: web build (no host)', () => {
  it('is unavailable, declares no tools, and refuses tool calls', async () => {
    const { browser } = setup({ desktop: false })

    assert.equal(browser.available, false)
    assert.deepEqual(browser.declareTools({ enabled: true }), [])
    const result = await browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })
    assert.equal(result.status, 'error')
    assert.match(result.text, /only available in the DeepSeek desktop app/)
  })
})

describe('browser: tool declaration', () => {
  it('declares all eleven browser tools only when enabled on desktop', () => {
    const { browser } = setup()
    const names = browser.declareTools({ enabled: true }).map((tool) => tool.name)

    assert.deepEqual(names.sort(), [
      'browser_click',
      'browser_eval',
      'browser_navigate',
      'browser_observe',
      'browser_press_key',
      'browser_scroll',
      'browser_select',
      'browser_set_viewport',
      'browser_tabs',
      'browser_type',
      'browser_wait',
    ])
    assert.deepEqual(browser.declareTools({ enabled: false }), [])
    assert.equal(browser.handles('browser_click'), true)
    assert.equal(browser.handles('web_search'), false)
  })
})

describe('browser: URL rules', () => {
  it('recognizes http/https URLs and rejects other schemes', () => {
    assert.equal(isHttpUrl('https://example.com'), true)
    assert.equal(isHttpUrl('http://localhost:3000/path'), true)
    assert.equal(isHttpUrl('about:blank'), false)
    assert.equal(isHttpUrl('javascript:alert(1)'), false)
    assert.equal(isHttpUrl('file:///etc/passwd'), false)
  })

  it('normalizes domains, localhost, explicit schemes, and search queries', () => {
    assert.equal(normalizeOmniboxInput(''), 'about:blank')
    assert.equal(normalizeOmniboxInput('   '), 'about:blank')
    assert.equal(normalizeOmniboxInput('https://deepseek.com/docs'), 'https://deepseek.com/docs')
    assert.equal(normalizeOmniboxInput('deepseek.com'), 'https://deepseek.com')
    assert.equal(normalizeOmniboxInput('localhost:5173/app'), 'http://localhost:5173/app')
    assert.equal(normalizeOmniboxInput('127.0.0.1:8080'), 'http://127.0.0.1:8080')
    assert.equal(
      normalizeOmniboxInput('how to use tauri webviews'),
      'https://www.google.com/search?q=how%20to%20use%20tauri%20webviews'
    )
  })
})

describe('browser: per-chat ownership and tabs', () => {
  it('cannot open the panel or create tabs on the new-chat screen', async () => {
    const { browser, activate } = setup()
    activate(null)

    assert.equal(await browser.openPanel(), false)
    await assert.rejects(() => browser.tabs.create('about:blank'))
  })

  it('keeps tabs, open state, and active tab separate per chat', async () => {
    const { browser, activate } = setup()
    activate('a')
    assert.equal(await browser.openPanel('a'), true)
    const firstA = browser.getSession('a').tabs[0]
    assert.ok(firstA, 'opening an empty panel creates a blank tab')
    const secondA = await browser.tabs.create('about:blank', { sessionId: 'a', activate: true })

    activate('b')
    assert.deepEqual(browser.getSession('b'), { panelOpen: false, tabs: [], activeTabId: null })
    assert.equal(browser.getSession('a').panelOpen, true)
    assert.equal(browser.getSession('a').tabs.length, 2)
    assert.equal(browser.getSession('a').activeTabId, secondA.id)

    await browser.openPanel('b')
    assert.notEqual(browser.getSession('b').tabs[0]?.id, firstA.id)
  })

  it('activates the neighbour when the active tab closes, and closes the panel with the last tab', async () => {
    const { browser, activate } = setup()
    activate('s')
    await browser.openPanel('s')
    const first = browser.getSession('s').tabs[0]
    assert.ok(first)
    const second = await browser.tabs.create('about:blank', { sessionId: 's', activate: true })

    await browser.tabs.close(second.id)
    assert.equal(browser.getSession('s').activeTabId, first.id)
    assert.equal(browser.getSession('s').panelOpen, true)

    await browser.tabs.close(first.id)
    assert.deepEqual(browser.getSession('s'), { panelOpen: false, tabs: [], activeTabId: null })
  })

  it("activates the tab that takes the closed active tab's place", async () => {
    const { browser, activate } = setup()
    activate('s')
    await browser.openPanel('s')
    const middle = await browser.tabs.create('about:blank', { sessionId: 's', activate: true })
    const last = await browser.tabs.create('about:blank', { sessionId: 's', activate: false })

    // Tabs: [blank, middle (active), last]; closing middle puts last at its index.
    await browser.tabs.close(middle.id)
    assert.equal(browser.getSession('s').activeTabId, last.id)
  })
})

describe('browser: native webview visibility', () => {
  it('shows the page once the panel is open, settled, and showing a loaded tab', async () => {
    const { host } = await withVisiblePage()
    assert.equal(host.lastActive.visible, true)
  })

  it('hides while the panel opens (animates) and shows when it settles', async () => {
    const env = setup()
    env.browser.start()
    env.activate('s1')
    await env.browser.openUrl('https://example.com/', { initiator: 'model' })
    await settle()
    assert.equal(env.host.lastActive.visible, false, 'still animating open')

    env.panel.finishAnimation()
    await settle()
    assert.equal(env.host.lastActive.visible, true)
  })

  it('hides while the panel is resized', async () => {
    const { host, panel } = await withVisiblePage()
    panel.slot.setResizing(true)
    await settle()
    assert.equal(host.lastActive.visible, false)
    panel.slot.setResizing(false)
    await settle()
    assert.equal(host.lastActive.visible, true)
  })

  it('hides under panel overlay lock (capturing a snapshot on lock) and shows again when released', async () => {
    const { host, panel } = await withVisiblePage()
    const snapshotsBefore = host.named('takeSnapshot').length

    panel.setOverlayLocked(true)
    await settle()
    assert.equal(host.lastActive.visible, false)
    assert.ok(
      host.named('takeSnapshot').length > snapshotsBefore,
      'captures a still snapshot when an overlay opens over a visible webview'
    )

    panel.setOverlayLocked(false)
    await settle()
    assert.equal(host.lastActive.visible, true)
  })

  it('publishes BrowserControlTakenOver when the user takes over control', () => {
    const { browser, log } = setup()
    const takenOver: string[] = []
    log.subscribe<BrowserControlTakenOver>('BrowserControlTakenOver', ({ fact }) => {
      takenOver.push(fact.sessionId)
    })

    browser.takeOver('s1')
    assert.deepEqual(takenOver, ['s1'])
    browser.dispose()
  })

  it('hides when the user leaves the chat, and when the panel shows something else', async () => {
    const env = await withVisiblePage()
    env.activate(null)
    await settle()
    assert.equal(env.host.lastActive.visible, false)

    env.activate('s1')
    await settle()
    assert.equal(env.host.lastActive.visible, false, 'panel animates back in')
    env.panel.finishAnimation()
    await settle()
    assert.equal(env.host.lastActive.visible, true)

    env.panel.showOther('s1')
    await settle()
    assert.equal(env.host.lastActive.visible, false)
    assert.equal(env.browser.getSession('s1').panelOpen, false, 'replaced panel counts as closed')
  })
})

describe('browser: lifecycle facts', () => {
  it('drops a deleted chat and closes its native tabs; history replacement drops all', async () => {
    const env = await withVisiblePage()
    await env.browser.openPanel('s2')
    await env.browser.openUrl('https://two.example/', { sessionId: 's2', initiator: 'model' })
    await settle()
    const tabOne = env.browser.getSession('s1').tabs[0]?.id

    env.log.publish<SessionDeleted>({ type: 'SessionDeleted', sessionId: 's1' })
    await settle()
    assert.deepEqual(env.browser.getSession('s1').tabs, [])
    assert.ok(env.host.named('closeTab').some((call) => call.args[0] === tabOne))
    assert.equal(env.browser.getSession('s2').tabs.length, 1)

    env.log.publish<SessionHistoryReplaced>({ type: 'SessionHistoryReplaced' })
    await settle()
    assert.deepEqual(env.browser.getSession('s2').tabs, [])
  })
})

describe('browser: links and preferences', () => {
  it('opens links externally on the new-chat screen', async () => {
    const { browser, opened, activate } = setup()
    activate(null)
    assert.equal(await browser.openUrl('https://example.com/'), null)
    assert.deepEqual(opened, ['https://example.com/'])
  })

  it('sends the saved localhost choice to the host on start', async () => {
    const store = memoryStore({ 'chat-demo:browser-allow-localhost': 'true' })
    const { browser, host } = setup({ store })
    browser.start()
    await settle()
    assert.deepEqual(
      host.named('setOptions').map((call) => call.args[0]),
      [true]
    )
  })
})

describe('browser: tool runs', () => {
  it('returns page text wrapped as untrusted content', async () => {
    const { browser } = await withVisiblePage()
    const result = await browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })

    assert.equal(result.status, 'ok')
    assert.match(
      result.text,
      /<untrusted_webpage_content[^>]*>[\s\S]*Hello page[\s\S]*<\/untrusted_webpage_content>/
    )
    assert.equal(result.meta.tool, 'browser_observe')
  })

  it('evaluates page scripts and wraps the value; script errors become tool errors', async () => {
    const { browser } = await withVisiblePage()
    const run = (script: string) =>
      browser.run('browser_eval', { script }, { signal: signal(), sessionId: 's1' })

    const ok = await run('40 + 2')
    assert.equal(ok.status, 'ok')
    assert.equal(
      ok.text,
      '<untrusted_webpage_content url="https://example.com/">\n42\n</untrusted_webpage_content>'
    )

    const failed = await run('throw new Error("boom")')
    assert.equal(failed.status, 'error')
    assert.match(failed.text, /boom/)
  })

  it('sends only well-formed page scripts, and snapshots redact password values', async () => {
    const env = await withVisiblePage()
    const run = (name: string, input: unknown) =>
      env.browser.run(name, input, { signal: signal(), sessionId: 's1' })
    await run('browser_observe', { screenshot: true })
    await run('browser_click', { ref: 'e1' })
    await run('browser_click', { x: 120, y: 240, button: 'right', double_click: true })
    await run('browser_type', { ref: 'e2', text: 'hello "world"', clear: true, submit: true })
    await run('browser_press_key', { key: 'Enter', modifiers: ['meta', 'shift'] })
    await run('browser_scroll', { direction: 'down', amount: 400 })
    await run('browser_select', { ref: 'e3', values: ['US', 'CA'] })
    await run('browser_wait', { selector: '.ready', timeout_ms: 1 })

    const isolated = env.host.scripts.filter((s) => s.isolated).map((s) => s.script)
    assert.ok(isolated.length >= 9)
    for (const script of isolated) {
      assert.doesNotThrow(() => new Function(script))
    }
    const snapshotScript = isolated.find((s) => s.includes('[REDACTED]'))
    assert.ok(snapshotScript, 'the snapshot script redacts')
    assert.match(snapshotScript, /el\.type === 'password'/)
  })

  it('runs one call at a time in call order', async () => {
    const env = await withVisiblePage()
    const order: string[] = []
    const run = (script: string) =>
      env.browser.run('browser_eval', { script }, { signal: signal(), sessionId: 's1' })
    const a = run('await new Promise((r) => setTimeout(r, 20)); return "a"').then((r) =>
      order.push(r.text.split('\n')[1] ?? '?')
    )
    const b = run('"b"').then((r) => order.push(r.text.split('\n')[1] ?? '?'))
    await Promise.all([a, b])
    assert.deepEqual(order, ['a', 'b'])
  })

  it('resolves a call aborted while queued as aborted, without running it', async () => {
    const env = await withVisiblePage()
    const before = env.host.scripts.length
    const slow = env.browser.run(
      'browser_eval',
      { script: 'await new Promise((r) => setTimeout(r, 20)); return 1' },
      { signal: signal(), sessionId: 's1' }
    )
    const controller = new AbortController()
    const queued = env.browser.run(
      'browser_eval',
      { script: '2' },
      { signal: controller.signal, sessionId: 's1' }
    )
    controller.abort()

    assert.equal((await queued).status, 'aborted')
    await slow
    assert.equal(env.host.scripts.length, before + 1, 'only the first call reached the page')
  })

  it('passes initiator="model" when browser_tabs opens a new tab, and drops the tab if the host blocks it', async () => {
    const env = await withVisiblePage()
    const baseCreateTab = env.host.host.createTab
    env.host.host.createTab = async (opts) => {
      await baseCreateTab(opts)
      if (opts.initiator === 'model' && opts.url.includes('127.0.0.1')) {
        throw new Error('Model navigation to localhost/private network addresses is disabled.')
      }
    }
    const beforeTabs = env.browser.getSession('s1').tabs.length

    const blocked = await env.browser.run(
      'browser_tabs',
      { action: 'new', url: 'http://127.0.0.1:8080/secret' },
      { signal: signal(), sessionId: 's1' }
    )

    assert.equal(blocked.status, 'error')
    assert.match(blocked.text, /localhost\/private network/)
    const lastCreate = env.host.named('createTab').at(-1)?.args[0] as
      | { url: string; initiator?: string }
      | undefined
    assert.equal(lastCreate?.initiator, 'model')
    assert.equal(env.browser.getSession('s1').tabs.length, beforeTabs)
  })

  it('stores a viewport per tab and zooms it to fit the stage', async () => {
    const { browser } = setup()
    browser.setStageSize({ width: 520, height: 660 })
    const tabA = await browser.tabs.create('about:blank', { sessionId: 'v', activate: true })
    const tabB = await browser.tabs.create('about:blank', { sessionId: 'v', activate: false })

    // 1280×720 into 520×660 is width-bound: zoom = 520 / 1280.
    const fit = await browser.tabs.setViewport(tabA.id, {
      width: 1280,
      height: 720,
      preset: 'desktop',
    })

    const [a, b] = browser.getSession('v').tabs
    assert.equal(a?.viewport?.width, 1280)
    assert.ok(Math.abs((a?.zoom ?? 0) - 520 / 1280) < 0.001)
    assert.equal(fit.zoom, a?.zoom)
    assert.equal(b?.id, tabB.id)
    assert.equal(b?.viewport, null)
    assert.equal(b?.zoom, 1)
  })

  it('resolves browser_set_viewport tool requests across presets, aspect ratios, clamps, auto, and errors', async () => {
    const env = await withVisiblePage()
    env.browser.setStageSize({ width: 520, height: 660 })

    const mobile = await env.browser.run(
      'browser_set_viewport',
      { preset: 'mobile' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(mobile.status, 'ok')
    assert.deepEqual(env.browser.getSession('s1').tabs[0]?.viewport, {
      width: 390,
      height: 844,
      preset: 'mobile',
      aspectRatio: null,
    })

    const ratio = await env.browser.run(
      'browser_set_viewport',
      { aspect_ratio: '4:3', width: 800 },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(ratio.status, 'ok')
    assert.deepEqual(env.browser.getSession('s1').tabs[0]?.viewport, {
      width: 800,
      height: 600,
      preset: null,
      aspectRatio: '4:3',
    })

    const clamped = await env.browser.run(
      'browser_set_viewport',
      { width: 100, height: 4000 },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(clamped.status, 'ok')
    assert.deepEqual(env.browser.getSession('s1').tabs[0]?.viewport, {
      width: 320,
      height: 2560,
      preset: null,
      aspectRatio: null,
    })

    const reset = await env.browser.run(
      'browser_set_viewport',
      { preset: 'auto' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(reset.status, 'ok')
    assert.equal(env.browser.getSession('s1').tabs[0]?.viewport, null)

    const invalid = await env.browser.run(
      'browser_set_viewport',
      { aspect_ratio: 'wide' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(invalid.status, 'error')
  })
})

describe('browser: ToolCapability, toggle, presenter, and archive serialization', () => {
  it('exposes toggle on desktop only, persists chat-demo:browser, and serializes actions', async () => {
    const webOnly = setup({ desktop: false })
    assert.equal(webOnly.browser.capability.toggle, undefined)
    assert.deepEqual(
      webOnly.browser.capability.declareTools({
        questionText: '',
        enabledCapabilities: { browser: true },
        declaredToolsSoFar: [],
      }),
      []
    )

    const store = memoryStore()
    const env = setup({ desktop: true, store })
    const toggle = env.browser.capability.toggle
    assert.ok(toggle)
    assert.equal(toggle.isEnabled(), false)
    toggle.setEnabled(true)
    assert.equal(toggle.isEnabled(), true)
    assert.equal(store.get('chat-demo:browser'), 'true')

    assert.equal(
      env.browser.capability.declareTools({
        questionText: '',
        enabledCapabilities: { browser: true },
        declaredToolsSoFar: [],
      }).length,
      11
    )

    env.browser.start()
    env.activate('s1')
    const ctx = {
      sessionId: 's1',
      replyId: 'r1',
      signal: signal(),
      caller: { kind: 'reply' as const },
      citedUrls: new Map<string, number>(),
      isActive: () => true,
      onProgress: () => {},
      readReplyState: () => undefined,
      writeReplyState: () => {},
    }
    const nav = await env.browser.capability.run(
      { id: 'b1', name: 'browser_navigate', input: { url: 'https://example.com/' } },
      ctx
    )
    assert.equal(nav.status, 'ok')
    const navArchive = env.browser.capability.serializeForArchive?.(
      { id: 'b1', name: 'browser_navigate', input: { url: 'https://example.com/' } },
      { tool_use_id: 'b1', content: nav.content, status: 'ok', payload: nav.payload }
    )
    assert.equal(navArchive?.[0]?.type, 'TOOL_OPEN')

    const summary = env.browser.capability.presenter?.summarize(
      { id: 'b1', name: 'browser_navigate', input: { url: 'https://example.com/' } },
      { tool_use_id: 'b1', content: nav.content, status: 'ok', payload: nav.payload },
      { streaming: false }
    )
    assert.equal(summary?.lane, 'browser')
    env.browser.dispose()
  })
})

describe('browser: bounds sync, stable refs, and SoM screenshot badges', () => {
  it('applies fresh bounds and zoom after resize without stale-closure clobbering', async () => {
    const env = await withVisiblePage()
    const baseSetActiveTab = env.host.host.setActiveTab
    const pendingActive: (() => void)[] = []
    let interceptNext = false

    env.host.host.setActiveTab = (tabId, bounds, visible, zoom) => {
      const p = baseSetActiveTab(tabId, bounds, visible, zoom)
      if (interceptNext) {
        interceptNext = false
        return new Promise<void>((resolve) => {
          pendingActive.push(() => void p.then(resolve))
        })
      }
      return p
    }

    // 1. During panel resize, bounds/zoom update in state without firing native setBounds.
    const boundsBeforeDrag = env.host.named('setBounds').length
    env.panel.slot.setResizing(true)
    await settle()
    const mobileBounds = { x: 740, y: 106, width: 328, height: 710 }
    env.browser.setPanelBounds(mobileBounds, 0.84)
    await settle()
    assert.equal(
      env.host.named('setBounds').length,
      boundsBeforeDrag,
      'no native setBounds while resizing'
    )

    // 2. When resizing ends, setActiveTab receives the fresh bounds & zoom atomically.
    // Even if a newer bounds update arrives while setActiveTab is in flight, it wins afterward.
    interceptNext = true
    env.panel.slot.setResizing(false)
    await Promise.resolve()
    const settledBounds = { x: 760, y: 106, width: 328, height: 710 }
    env.browser.setPanelBounds(settledBounds, 0.78)
    const release = pendingActive.shift()
    assert.ok(release, 'intercepted in-flight setActiveTab')
    release()
    await settle()

    const activeCall = env.host.named('setActiveTab').at(-1)
    assert.deepEqual(activeCall?.args[1], mobileBounds)
    assert.equal(activeCall?.args[2], true)
    assert.equal(activeCall?.args[3], 0.84)

    const finalBoundsCall = env.host.named('setBounds').at(-1)
    assert.deepEqual(finalBoundsCall?.args[0], settledBounds)
    assert.equal(finalBoundsCall?.args[1], 0.78)

    // 3. Forced sync (e.g. window resize with unchanged CSS rect) still calls native setBounds.
    const countBeforeForce = env.host.named('setBounds').length
    env.browser.setPanelBounds(settledBounds, 0.78, { force: true })
    await settle()
    assert.equal(env.host.named('setBounds').length, countBeforeForce + 1)

    // 4. Hover snapshot started just before drag is preserved when resizing begins mid-capture.
    const pendingSnaps: ((v: { dataUrl: string; width: number; height: number }) => void)[] = []
    env.host.host.takeSnapshot = () =>
      new Promise((resolve) => {
        pendingSnaps.push(resolve)
      })
    const snapPromise = env.browser.refreshSnapshot()
    env.panel.slot.setResizing(true)
    const resolveSnap = pendingSnaps.shift()
    assert.ok(resolveSnap)
    resolveSnap({ dataUrl: 'data:image/jpeg;base64,FRESH', width: 328, height: 710 })
    await snapPromise
    assert.equal(env.browser.getSession('s1').tabs[0]?.snapshotUrl, 'data:image/jpeg;base64,FRESH')
    env.browser.dispose()
  })

  it('keeps element refs stable across scroll and DOM insertions, and rejects detached refs', async () => {
    class FakeElement {
      tagName: string
      attrs = new Map<string, string>()
      children: FakeElement[] = []
      isConnected = true
      innerText: string
      rect: {
        left: number
        top: number
        right: number
        bottom: number
        width: number
        height: number
      }
      constructor(tag: string, label: string, top: number) {
        this.tagName = tag.toUpperCase()
        this.innerText = label
        this.rect = { left: 10, top, right: 110, bottom: top + 30, width: 100, height: 30 }
      }
      getAttribute(name: string) {
        return this.attrs.get(name) ?? null
      }
      hasAttribute(name: string) {
        return this.attrs.has(name)
      }
      getBoundingClientRect() {
        return this.rect
      }
      scrollIntoView() {}
      focus() {}
      click() {}
      dispatchEvent() {
        return true
      }
    }
    class FakeHTMLElement extends FakeElement {}
    class FakeSVGElement extends FakeElement {}
    class FakeInput extends FakeHTMLElement {
      type = 'text'
      value = ''
      disabled = false
      labels: FakeElement[] = []
    }
    class FakeTextarea extends FakeHTMLElement {
      value = ''
      disabled = false
      labels: FakeElement[] = []
    }
    class FakeSelect extends FakeHTMLElement {
      value = ''
      disabled = false
      options: FakeElement[] = []
      labels: FakeElement[] = []
    }
    class FakeAnchor extends FakeHTMLElement {
      href = ''
    }

    const body = new FakeHTMLElement('body', 'Form page', 0)
    const btnA = new FakeHTMLElement('button', 'First', 20)
    const btnB = new FakeHTMLElement('button', 'Second', 80)
    const btnC = new FakeHTMLElement('button', 'Third', 140)
    body.children = [btnA, btnB, btnC]

    const fakeWindow: Record<PropertyKey, unknown> = {
      innerWidth: 800,
      innerHeight: 600,
      scrollX: 0,
      scrollY: 0,
      scrollBy: () => {},
      scrollTo: () => {},
    }
    const fakeDocument = {
      body,
      documentElement: {
        clientWidth: 800,
        clientHeight: 600,
        scrollWidth: 800,
        scrollHeight: 1200,
        appendChild: () => {},
      },
      title: 'Test Form',
      readyState: 'complete',
      activeElement: body,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => new FakeHTMLElement('div', '', 0),
    }

    class FakeEvent {
      type: string
      constructor(type: string) {
        this.type = type
      }
    }

    const runInFakeDom = (script: string): string => {
      const fn = new Function(
        'window',
        'document',
        'location',
        'getComputedStyle',
        'Element',
        'HTMLElement',
        'SVGElement',
        'HTMLInputElement',
        'HTMLTextAreaElement',
        'HTMLSelectElement',
        'HTMLAnchorElement',
        'PointerEvent',
        'MouseEvent',
        script
      )
      return fn(
        fakeWindow,
        fakeDocument,
        { href: 'https://example.com/' },
        () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
        FakeElement,
        FakeHTMLElement,
        FakeSVGElement,
        FakeInput,
        FakeTextarea,
        FakeSelect,
        FakeAnchor,
        FakeEvent,
        FakeEvent
      ) as string
    }

    const env = await withVisiblePage()
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? runInFakeDom(script) : JSON.stringify({ ok: true, value: null })

    const first = await env.browser.run(
      'browser_observe',
      {},
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(first.status, 'ok')
    assert.match(first.text, /\[e1\] button "First"/)
    assert.match(first.text, /\[e2\] button "Second"/)
    assert.match(first.text, /\[e3\] button "Third"/)

    // Scroll btnA out of view and prepend a brand-new button btnD before btnB.
    btnA.rect = { left: 10, top: -120, right: 110, bottom: -90, width: 100, height: 30 }
    const btnD = new FakeHTMLElement('button', 'Inserted', 40)
    body.children = [btnA, btnD, btnB, btnC]

    const second = await env.browser.run(
      'browser_scroll',
      { direction: 'down', amount: 120 },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(second.status, 'ok')
    assert.match(second.text, /\[e1\] button "First" \(offscreen\)/)
    assert.match(second.text, /\[e2\] button "Second"/)
    assert.match(second.text, /\[e3\] button "Third"/)
    assert.match(second.text, /\[e4\] button "Inserted"/)

    // Detach btnB: clicking e2 must fail as stale rather than targeting another element.
    btnB.isConnected = false
    body.children = [btnA, btnD, btnC]
    await env.browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })
    const staleClick = await env.browser.run(
      'browser_click',
      { ref: 'e2' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(staleClick.status, 'error')
    assert.match(staleClick.text, /stale/)
    env.browser.dispose()
  })

  it('computes SoM badge geometry accurately and composites badges onto model screenshots while keeping preview clean', async () => {
    // 1. Pure layout mapping across Retina/zoom scaling, edge clamping, offscreen filtering, and collision nudging.
    const layout = computeSomBadgeBoxes(
      [
        { ref: 'e1', inView: true, rect: { x: 10, y: 20, w: 100, h: 32 } },
        { ref: 'e2', inView: true, rect: { x: 10, y: 20, w: 100, h: 32 } },
        { ref: 'e3', inView: true, rect: { x: 385, y: 840, w: 20, h: 20 } },
        { ref: 'e4', inView: false, rect: { x: 10, y: 1200, w: 100, h: 32 } },
      ],
      { width: 390, height: 844 },
      { width: 780, height: 1688 }
    )
    assert.equal(layout.badges.length, 3)
    assert.equal(layout.badges[0]?.ref, 'e1')
    assert.equal(layout.badges[0]?.x, 20)
    assert.equal(layout.badges[0]?.y, 40)
    assert.ok(
      (layout.badges[1]?.x ?? 0) > (layout.badges[0]?.x ?? 0),
      'overlapping badge nudges right'
    )
    assert.ok(
      (layout.badges[2]?.x ?? 0) + (layout.badges[2]?.w ?? 0) <= 780 - 2 &&
        (layout.badges[2]?.y ?? 0) + (layout.badges[2]?.h ?? 0) <= 1688 - 2,
      'edge badge stays clamped inside image'
    )

    // 2. End-to-end browser_observe({ screenshot: true }) produces clean previewImages and badged images in one capture.
    const drawnRefs: string[] = []
    const prevDocument = globalThis.document
    const prevImage = globalThis.Image
    const fakeCtx = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      textAlign: '',
      textBaseline: '',
      shadowColor: '',
      shadowBlur: 0,
      shadowOffsetY: 0,
      drawImage: () => {},
      measureText: (text: string) => ({ width: text.length * 8 }),
      save: () => {},
      restore: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      fillText: (text: string) => {
        drawnRefs.push(text)
      },
    }
    ;(globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => {
        assert.equal(tag, 'canvas')
        return {
          width: 0,
          height: 0,
          getContext: () => fakeCtx,
          toDataURL: () => 'data:image/jpeg;base64,BADGED',
        }
      },
    }
    ;(globalThis as Record<string, unknown>).Image = class FakeImage {
      naturalWidth = 800
      naturalHeight = 600
      width = 800
      height = 600
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }

    try {
      const env = await withVisiblePage()
      env.host.host.evalJs = async () =>
        JSON.stringify({
          ...SNAPSHOT,
          totalInteractiveCount: 2,
          elements: [
            {
              ref: 'e1',
              role: 'button',
              label: 'Submit',
              inView: true,
              rect: { x: 20, y: 40, w: 90, h: 32 },
            },
            {
              ref: 'e2',
              role: 'link',
              label: 'Help',
              inView: true,
              rect: { x: 140, y: 40, w: 60, h: 24 },
            },
          ],
        })
      const snapshotsBefore = env.host.named('takeSnapshot').length
      const observed = await env.browser.run(
        'browser_observe',
        { screenshot: true },
        { signal: signal(), sessionId: 's1' }
      )
      assert.equal(observed.status, 'ok')
      assert.equal(
        env.host.named('takeSnapshot').length,
        snapshotsBefore + 1,
        'takes a single native screenshot per observe'
      )
      assert.deepEqual(observed.previewImages, ['data:image/png;base64,AA'])
      assert.deepEqual(observed.images, ['data:image/jpeg;base64,BADGED'])
      assert.deepEqual(drawnRefs, ['e1', 'e2'])
      env.browser.dispose()
    } finally {
      ;(globalThis as Record<string, unknown>).document = prevDocument
      ;(globalThis as Record<string, unknown>).Image = prevImage
    }
  })
})
