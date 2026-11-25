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
  const emitState = (payload: BrowserTabStatePayload) => {
    for (const handler of stateHandlers) {
      handler(payload)
    }
  }
  const named = (name: string) => calls.filter((call) => call.name === name)
  return { host, calls, scripts, lastActive, named, emitState }
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
    reveal: (sessionId) => {
      if (shown.has(sessionId)) {
        return
      }
      shown.set(sessionId, 'browser')
      update(layout.activeSessionId === sessionId ? { animating: true } : {})
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

    // Subsequent browser tool calls run cleanly in the background without stealing the right panel.
    const bgObserve = await env.browser.run(
      'browser_observe',
      {},
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(bgObserve.status, 'ok')
    assert.equal(env.panel.slot.isOpen('s1'), false, 'other panel was not hijacked')
    assert.equal(env.host.lastActive.visible, false, 'native webview stays hidden while displaced')
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
      {
        id: 'b1',
        name: 'browser_navigate',
        input: {
          summary: 'Loading example.com to test basic navigation',
          url: 'https://example.com/',
        },
      },
      {
        tool_use_id: 'b1',
        content: nav.content,
        status: 'ok',
        payload: nav.payload,
        previewImages: ['data:image/jpeg;base64,AA=='],
      },
      { streaming: false }
    )
    assert.equal(summary?.lane, 'browser')
    assert.equal(summary?.detail, 'Loading example.com to test basic navigation')
    assert.equal(summary?.visuals?.length, 1)
    assert.ok(
      summary?.visuals?.[0]?.alt && summary.visuals[0].alt.length > 0,
      'screenshot visual artifacts carry descriptive alt text'
    )
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

describe('browser: navigation settling, async form submit, stale-ref recovery, and snapshot framing', () => {
  const createInteractiveDom = (initialUrl: string, initialTitle: string) => {
    class SimEvent {
      type: string
      bubbles: boolean
      cancelable: boolean
      defaultPrevented = false
      key?: string
      code?: string
      shiftKey = false
      metaKey = false
      ctrlKey = false
      altKey = false
      target: unknown = null
      constructor(type: string, init: Record<string, unknown> = {}) {
        this.type = type
        this.bubbles = Boolean(init.bubbles)
        this.cancelable = Boolean(init.cancelable)
        if (typeof init.key === 'string') {
          this.key = init.key
        }
        if (typeof init.code === 'string') {
          this.code = init.code
        }
        this.shiftKey = Boolean(init.shiftKey)
        this.metaKey = Boolean(init.metaKey)
        this.ctrlKey = Boolean(init.ctrlKey)
        this.altKey = Boolean(init.altKey)
      }
      preventDefault() {
        if (this.cancelable) {
          this.defaultPrevented = true
        }
      }
    }

    type Listener = { fn: (ev: SimEvent) => void; once: boolean }

    class SimElement {
      tagName: string
      attrs = new Map<string, string>()
      children: SimElement[] = []
      parentElement: SimElement | null = null
      ownerDocument: unknown = null
      isConnected = true
      innerText: string
      style: Record<string, string> = {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        overflowX: 'visible',
        overflowY: 'visible',
        cssText: '',
      }
      rect = { left: 10, top: 20, right: 130, bottom: 52, width: 120, height: 32 }
      scrollLeft = 0
      scrollTop = 0
      scrollWidth = 120
      scrollHeight = 32
      clientWidth = 120
      clientHeight = 32
      clientLeft = 0
      clientTop = 0
      scrollIntoViewCalls = 0
      listeners = new Map<string, Listener[]>()
      onClickAction: ((ev: SimEvent) => void) | null = null

      constructor(tag: string, label: string, top = 20) {
        this.tagName = tag.toUpperCase()
        this.innerText = label
        this.rect = { left: 10, top, right: 130, bottom: top + 32, width: 120, height: 32 }
      }
      get textContent(): string {
        return this.innerText || this.children.map((c) => c.textContent).join(' ')
      }
      append(child: SimElement) {
        child.parentElement = this
        child.isConnected = this.isConnected
        if (!child.ownerDocument && this.ownerDocument) {
          child.ownerDocument = this.ownerDocument
        }
        this.children.push(child)
        return child
      }
      appendChild(child: SimElement) {
        return this.append(child)
      }
      remove() {
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((c) => c !== this)
          this.parentElement = null
        }
        this.isConnected = false
      }
      getAttribute(name: string) {
        return this.attrs.get(name) ?? null
      }
      setAttribute(name: string, value: string) {
        this.attrs.set(name, value)
      }
      hasAttribute(name: string) {
        return this.attrs.has(name)
      }
      getBoundingClientRect() {
        return this.rect
      }
      scrollIntoView() {
        this.scrollIntoViewCalls += 1
      }
      focus() {
        const doc = (this.ownerDocument as { activeElement?: unknown } | null) ?? simDocument
        doc.activeElement = this
      }
      addEventListener(type: string, fn: (ev: SimEvent) => void, opts?: { once?: boolean }) {
        const list = this.listeners.get(type) ?? []
        list.push({ fn, once: Boolean(opts?.once) })
        this.listeners.set(type, list)
      }
      removeEventListener(type: string, fn: (ev: SimEvent) => void) {
        const list = this.listeners.get(type)
        if (!list) {
          return
        }
        this.listeners.set(
          type,
          list.filter((entry) => entry.fn !== fn)
        )
      }
      dispatchEvent(ev: SimEvent): boolean {
        ev.target = this
        for (const cur of ancestorsOf(this)) {
          const list = [...(cur.listeners.get(ev.type) ?? [])]
          for (const entry of list) {
            if (entry.once) {
              cur.removeEventListener(ev.type, entry.fn)
            }
            entry.fn(ev)
          }
          if (!ev.bubbles) {
            break
          }
        }
        if (ev.bubbles) {
          const docList = [...(docListeners.get(ev.type) ?? [])]
          for (const entry of docList) {
            if (entry.once) {
              simDocument.removeEventListener(ev.type, entry.fn)
            }
            entry.fn(ev)
          }
        }
        return !ev.defaultPrevented
      }
      click() {
        const ev = new SimEvent('click', { bubbles: true, cancelable: true })
        const notPrevented = this.dispatchEvent(ev)
        if (notPrevented) {
          for (const cur of ancestorsOf(this)) {
            if (cur.onClickAction) {
              cur.onClickAction(ev)
              break
            }
          }
        }
      }
      closest(selector: string): SimElement | null {
        for (const cur of ancestorsOf(this)) {
          if (
            (selector === 'a[href]' && cur.tagName === 'A' && cur.hasAttribute('href')) ||
            (selector === 'form' && cur.tagName === 'FORM') ||
            (selector === 'button, input[type="submit"], input[type="image"]' &&
              (cur.tagName === 'BUTTON' ||
                (cur.tagName === 'INPUT' &&
                  (cur.getAttribute('type') === 'submit' || cur.getAttribute('type') === 'image'))))
          ) {
            return cur
          }
        }
        return null
      }
      querySelectorAll(selector: string): SimElement[] {
        const out: SimElement[] = []
        const walk = (node: SimElement) => {
          for (const child of node.children) {
            if (
              selector === '*' ||
              (selector === '[data-ds-overlay="1"]' &&
                child.getAttribute('data-ds-overlay') === '1')
            ) {
              out.push(child)
            }
            walk(child)
          }
        }
        walk(this)
        return out
      }
    }

    const ancestorsOf = (start: SimElement): SimElement[] => {
      const chain: SimElement[] = []
      let cur: SimElement | null = start
      while (cur) {
        chain.push(cur)
        cur = cur.parentElement
      }
      return chain
    }

    class SimHTMLElement extends SimElement {}
    class SimSVGElement extends SimElement {}
    class SimForm extends SimHTMLElement {
      onSubmitAction: (() => void) | null = null
      constructor() {
        super('form', '', 20)
      }
      requestSubmit() {
        const ev = new SimEvent('submit', { bubbles: true, cancelable: true })
        if (this.dispatchEvent(ev)) {
          this.onSubmitAction?.()
        }
      }
      submit() {
        this.onSubmitAction?.()
      }
    }
    class SimInput extends SimHTMLElement {
      type = 'text'
      private _value = ''
      checked = false
      disabled = false
      labels: SimElement[] = []
      form: SimForm | null = null
      constructor(label: string, top = 20) {
        super('input', '', top)
        this.setAttribute('aria-label', label)
      }
      get value() {
        return this._value
      }
      set value(v: string) {
        this._value = v
      }
      override click() {
        if (this.type === 'checkbox') {
          this.checked = !this.checked
        }
        super.click()
      }
    }
    class SimTextarea extends SimHTMLElement {
      value = ''
      disabled = false
      labels: SimElement[] = []
    }
    class SimOption {
      value: string
      text: string
      selected: boolean
      constructor(value: string, text: string, selected = false) {
        this.value = value
        this.text = text
        this.selected = selected
      }
    }
    let selectProtoSetterCalls = 0
    class SimSelect extends SimHTMLElement {
      disabled = false
      multiple = false
      options: SimOption[] = []
      labels: SimElement[] = []
      constructor(label: string, options: SimOption[] = [], top = 20) {
        super('select', '', top)
        this.setAttribute('aria-label', label)
        this.options = options
      }
      get value(): string {
        return this.options.find((o) => o.selected)?.value ?? this.options[0]?.value ?? ''
      }
      set value(v: string) {
        selectProtoSetterCalls += 1
        for (const opt of this.options) {
          opt.selected = opt.value === v
        }
      }
    }
    class SimAnchor extends SimHTMLElement {
      href: string
      target = ''
      constructor(label: string, href: string, top = 20) {
        super('a', label, top)
        this.href = href
        this.setAttribute('href', href)
      }
    }

    const docListeners = new Map<string, Listener[]>()
    const docRoot = new SimHTMLElement('html', '', 0)
    docRoot.clientWidth = 800
    docRoot.clientHeight = 600
    docRoot.scrollWidth = 800
    docRoot.scrollHeight = 2400
    const body = new SimHTMLElement('body', '', 0)
    docRoot.append(body)
    const simLocation = { href: initialUrl }
    const simWindow: Record<PropertyKey, unknown> = {
      innerWidth: 800,
      innerHeight: 600,
      scrollX: 0,
      scrollY: 0,
      scrollBy: (_opts: { top?: number; left?: number }) => {
        simWindow.scrollY = Number(simWindow.scrollY) + (_opts?.top ?? 0)
        simWindow.scrollX = Number(simWindow.scrollX) + (_opts?.left ?? 0)
      },
      scrollTo: (_opts: { top?: number; left?: number }) => {
        if (_opts?.top !== undefined) {
          simWindow.scrollY = _opts.top
        }
        if (_opts?.left !== undefined) {
          simWindow.scrollX = _opts.left
        }
      },
    }
    const simDocument = {
      defaultView: simWindow,
      body,
      documentElement: docRoot,
      title: initialTitle,
      readyState: 'complete',
      activeElement: body as SimElement,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (selector: string) => docRoot.querySelectorAll(selector),
      elementFromPoint: (x: number, y: number): SimElement | null => {
        let hit: SimElement | null = null
        const walk = (node: SimElement) => {
          for (const child of node.children) {
            if (child.getAttribute('data-ds-overlay') === '1') {
              continue
            }
            const r = child.getBoundingClientRect()
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
              hit = child
            }
            walk(child)
          }
        }
        walk(body)
        return hit
      },
      createElement: (tag: string) => {
        const el = new SimHTMLElement(tag || 'div', '', 0)
        el.ownerDocument = simDocument
        return el
      },
      addEventListener: (type: string, fn: (ev: SimEvent) => void, opts?: { once?: boolean }) => {
        const list = docListeners.get(type) ?? []
        list.push({ fn, once: Boolean(opts?.once) })
        docListeners.set(type, list)
      },
      removeEventListener: (type: string, fn: (ev: SimEvent) => void) => {
        const list = docListeners.get(type)
        if (!list) {
          return
        }
        docListeners.set(
          type,
          list.filter((entry) => entry.fn !== fn)
        )
      },
    }
    docRoot.ownerDocument = simDocument
    body.ownerDocument = simDocument
    simWindow.Element = SimElement
    simWindow.HTMLElement = SimHTMLElement
    simWindow.SVGElement = SimSVGElement
    simWindow.HTMLInputElement = SimInput
    simWindow.HTMLTextAreaElement = SimTextarea
    simWindow.HTMLSelectElement = SimSelect
    simWindow.HTMLAnchorElement = SimAnchor
    simWindow.PointerEvent = SimEvent
    simWindow.MouseEvent = SimEvent
    simWindow.KeyboardEvent = SimEvent
    simWindow.InputEvent = SimEvent
    simWindow.Event = SimEvent
    simWindow.getComputedStyle = (el: SimElement) =>
      el?.style ?? {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        overflowX: 'visible',
        overflowY: 'visible',
      }

    const runScript = (script: string): string => {
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
        'KeyboardEvent',
        'InputEvent',
        'Event',
        script
      )
      return fn(
        simWindow,
        simDocument,
        simLocation,
        simWindow.getComputedStyle,
        SimElement,
        SimHTMLElement,
        SimSVGElement,
        SimInput,
        SimTextarea,
        SimSelect,
        SimAnchor,
        SimEvent,
        SimEvent,
        SimEvent,
        SimEvent,
        SimEvent
      ) as string
    }

    return {
      SimEvent,
      SimElement,
      SimHTMLElement,
      SimForm,
      SimInput,
      SimOption,
      SimSelect,
      SimAnchor,
      body,
      docRoot,
      simWindow,
      simDocument,
      simLocation,
      getSelectProtoSetterCalls: () => selectProtoSetterCalls,
      runScript,
    }
  }

  it('waits for delayed cross-origin link navigation on browser_click without browser_wait, while non-navigating clicks settle promptly', async () => {
    const dom = createInteractiveDom('https://example.com/', 'Example Domain')
    dom.body.innerText = 'Example Domain\nThis domain is for use in illustrative examples.'

    const env = await withVisiblePage()
    const tabId = env.browser.getSession('s1').tabs[0]?.id ?? ''
    assert.ok(tabId)
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    // Cross-origin link whose native load starts AFTER 320 ms (past the old 250 ms blind sleep).
    const link = new dom.SimAnchor('', 'https://www.iana.org/domains/example', 40)
    const span = new dom.SimHTMLElement('span', 'Learn more', 40)
    link.append(span)
    link.onClickAction = () => {
      setTimeout(() => {
        env.host.emitState({
          tabId,
          url: 'https://example.com/',
          title: null,
          isLoading: true,
          canGoBack: true,
          canGoForward: false,
        })
        setTimeout(() => {
          dom.simLocation.href = 'https://www.iana.org/help/example-domains'
          dom.simDocument.title = 'Example Domains'
          dom.body.innerText = 'IANA Example Domains\nManaged by IANA.'
          dom.body.children = []
          env.host.emitState({
            tabId,
            url: 'https://www.iana.org/help/example-domains',
            title: 'Example Domains',
            isLoading: false,
            canGoBack: true,
            canGoForward: false,
          })
        }, 60)
      }, 320)
    }

    const spaLink = new dom.SimAnchor('SPA Link', 'https://example.com/spa', 90)
    spaLink.addEventListener('click', (ev) => ev.preventDefault())

    dom.body.append(link)
    dom.body.append(spaLink)

    const observed = await env.browser.run(
      'browser_observe',
      {},
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(observed.status, 'ok')
    const spaRef = /\[(e\d+)\] link "SPA Link"/.exec(observed.text)?.[1]
    const learnRef = /\[(e\d+)\] link "Learn more"/.exec(observed.text)?.[1]
    assert.ok(spaRef && learnRef)

    // Non-navigating (preventDefault) click should settle quickly without waiting for a full nav start window.
    const spaClick = await env.browser.run(
      'browser_click',
      { ref: spaRef },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(spaClick.status, 'ok')
    assert.equal(spaClick.meta.url, 'https://example.com/')
    assert.ok(spaClick.durationMs < 1000, `non-navigating click took ${spaClick.durationMs}ms`)

    // Cross-origin link click must wait for the delayed load and return the destination page directly.
    const navClick = await env.browser.run(
      'browser_click',
      { ref: learnRef },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(navClick.status, 'ok')
    assert.equal(navClick.meta.url, 'https://www.iana.org/help/example-domains')
    assert.match(navClick.text, /IANA Example Domains/)
    env.browser.dispose()
  })

  it('yields after input on browser_type(submit: true) so async-hydrated inputs receive Enter without a premature change event', async () => {
    const dom = createInteractiveDom('https://en.wikipedia.org/wiki/Main_Page', 'Wikipedia')
    dom.body.innerText = 'Welcome to Wikipedia'

    const env = await withVisiblePage()
    const tabId = env.browser.getSession('s1').tabs[0]?.id ?? ''
    assert.ok(tabId)
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    const ssrForm = new dom.SimForm()
    const ssrInput = new dom.SimInput('Search Wikipedia', 20)
    ssrInput.form = ssrForm
    ssrForm.append(ssrInput)
    dom.body.append(ssrForm)

    let prematureChangeFired = false
    let ssrEnterCount = 0
    let hydratedEnterValue: string | null = null

    ssrInput.addEventListener('change', () => {
      prematureChangeFired = true
    })
    ssrInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ssrEnterCount += 1
        // Unhydrated search widget prevents default and only opens suggestions instead of submitting.
        ev.preventDefault()
      }
    })
    ssrInput.addEventListener('input', () => {
      const typed = ssrInput.value
      // Simulate Vue/Codex TypeaheadSearch mounting asynchronously after input.
      setTimeout(() => {
        ssrInput.isConnected = false
        ssrForm.isConnected = false
        const hydratedForm = new dom.SimForm()
        const hydratedInput = new dom.SimInput('Search Wikipedia', 20)
        hydratedInput.value = typed
        hydratedInput.form = hydratedForm
        hydratedForm.append(hydratedInput)
        dom.body.children = [hydratedForm]
        dom.simDocument.activeElement = hydratedInput

        hydratedInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            hydratedEnterValue = hydratedInput.value
            ev.preventDefault()
            env.host.emitState({
              tabId,
              url: 'https://en.wikipedia.org/wiki/Main_Page',
              title: null,
              isLoading: true,
              canGoBack: true,
              canGoForward: false,
            })
            setTimeout(() => {
              dom.simLocation.href = 'https://en.wikipedia.org/wiki/Humpback_whale'
              dom.simDocument.title = 'Humpback whale - Wikipedia'
              dom.body.innerText =
                'Humpback whale\nThe humpback whale is a species of baleen whale.'
              dom.body.children = []
              env.host.emitState({
                tabId,
                url: 'https://en.wikipedia.org/wiki/Humpback_whale',
                title: 'Humpback whale - Wikipedia',
                isLoading: false,
                canGoBack: true,
                canGoForward: false,
              })
            }, 40)
          }
        })
      }, 40)
    })

    const observed = await env.browser.run(
      'browser_observe',
      {},
      { signal: signal(), sessionId: 's1' }
    )
    const searchRef = /\[(e\d+)\] input:text "Search Wikipedia"/.exec(observed.text)?.[1]
    assert.ok(searchRef)

    const typed = await env.browser.run(
      'browser_type',
      { ref: searchRef, text: 'Humpback whale', submit: true },
      { signal: signal(), sessionId: 's1' }
    )

    assert.equal(prematureChangeFired, false, 'must not emit premature change before Enter')
    assert.equal(ssrEnterCount, 0, 'must not dispatch synchronous Enter before hydration settles')
    assert.equal(hydratedEnterValue, 'Humpback whale')
    assert.equal(typed.status, 'ok')
    assert.equal(typed.meta.url, 'https://en.wikipedia.org/wiki/Humpback_whale')
    assert.match(typed.text, /species of baleen whale/)
    env.browser.dispose()
  })

  it('returns safe stale-ref errors with refreshed interactive refs and matching replacement hints inside untrusted_webpage_content', async () => {
    const dom = createInteractiveDom('https://en.wikipedia.org/wiki/Main_Page', 'Wikipedia')
    dom.body.innerText = 'Search header'

    const env = await withVisiblePage()
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    const oldBtn = new dom.SimHTMLElement('button', 'Search', 30)
    const otherBtn = new dom.SimHTMLElement('button', 'Donate', 80)
    dom.body.append(oldBtn)
    dom.body.append(otherBtn)

    const observed = await env.browser.run(
      'browser_observe',
      {},
      { signal: signal(), sessionId: 's1' }
    )
    const oldSearchRef = /\[(e\d+)\] button "Search"/.exec(observed.text)?.[1]
    assert.ok(oldSearchRef)

    // Framework replaces the Search button DOM node before the next click.
    oldBtn.isConnected = false
    let replacementClicks = 0
    const newBtn = new dom.SimHTMLElement('button', 'Search', 30)
    newBtn.onClickAction = () => {
      replacementClicks += 1
    }
    dom.body.children = [newBtn, otherBtn]

    const stale = await env.browser.run(
      'browser_click',
      { ref: oldSearchRef },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(stale.status, 'error')
    assert.match(stale.text, /stale/i)
    assert.equal(replacementClicks, 0, 'must never silently click the replacement node')
    assert.match(
      stale.text,
      /<untrusted_webpage_content[^>]*>[\s\S]*button "Search"[\s\S]*<\/untrusted_webpage_content>/
    )

    const replacementRef = /\[(e\d+)\] button "Search"/.exec(stale.text)?.[1]
    assert.ok(replacementRef && replacementRef !== oldSearchRef, 'surfaces fresh replacement ref')

    const retry = await env.browser.run(
      'browser_click',
      { ref: replacementRef },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(retry.status, 'ok')
    assert.equal(replacementClicks, 1)
    env.browser.dispose()
  })

  it('omits page text on scroll/viewport, deduplicates unchanged text on same-URL actions, reports inline diffs, and always returns full text on observe', async () => {
    const dom = createInteractiveDom('https://example.com/form', 'Account Form')
    const baseLines = [
      'Account Registration',
      'Line one of stable instructions about your account.',
      'Line two of stable instructions about privacy.',
      'Line three of stable instructions about security.',
      'Line four of stable instructions about terms.',
    ]
    dom.body.innerText = baseLines.join('\n')

    const env = await withVisiblePage()
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    const noopBtn = new dom.SimHTMLElement('button', 'Check', 30)
    const submitBtn = new dom.SimHTMLElement('button', 'Submit', 80)
    submitBtn.onClickAction = () => {
      dom.body.innerText = `${baseLines.join('\n')}\nPassword must be at least 8 characters.`
    }
    dom.body.append(noopBtn)
    dom.body.append(submitBtn)

    // 1. Explicit observe returns full page text.
    const obs1 = await env.browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })
    assert.equal(obs1.status, 'ok')
    assert.match(obs1.text, /Line one of stable instructions/)
    const checkRef = /\[(e\d+)\] button "Check"/.exec(obs1.text)?.[1]
    const submitRef = /\[(e\d+)\] button "Submit"/.exec(obs1.text)?.[1]
    assert.ok(checkRef && submitRef)

    // 2. Scroll omits page text by default, includes it when text: true.
    const scrolled = await env.browser.run(
      'browser_scroll',
      { direction: 'down', amount: 400 },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(scrolled.status, 'ok')
    assert.doesNotMatch(scrolled.text, /Line one of stable instructions/)
    assert.match(scrolled.text, /button "Submit"/)

    const scrolledWithText = await env.browser.run(
      'browser_scroll',
      { direction: 'up', amount: 200, text: true },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(scrolledWithText.status, 'ok')
    assert.match(scrolledWithText.text, /Line one of stable instructions/)

    // 3. Viewport change omits page text.
    const resized = await env.browser.run(
      'browser_set_viewport',
      { preset: 'mobile' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(resized.status, 'ok')
    assert.doesNotMatch(resized.text, /Line one of stable instructions/)

    // 4. Same-URL click with unchanged text does not re-dump the page body.
    const unchangedClick = await env.browser.run(
      'browser_click',
      { ref: checkRef },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(unchangedClick.status, 'ok')
    assert.doesNotMatch(unchangedClick.text, /Line one of stable instructions/)
    assert.match(unchangedClick.text, /unchanged/i)

    // 5. Same-URL click that adds a validation error surfaces the new line without repeating unchanged lines.
    const errorClick = await env.browser.run(
      'browser_click',
      { ref: submitRef },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(errorClick.status, 'ok')
    assert.match(errorClick.text, /Password must be at least 8 characters\./)
    assert.doesNotMatch(errorClick.text, /Line one of stable instructions/)

    // 6. Explicit browser_observe always returns the full page text again.
    const obs2 = await env.browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })
    assert.equal(obs2.status, 'ok')
    assert.match(obs2.text, /Line one of stable instructions/)
    assert.match(obs2.text, /Password must be at least 8 characters\./)

    // 7. browser_navigate({ text: false }) omits page text.
    const navNoText = await env.browser.run(
      'browser_navigate',
      { url: 'https://example.com/other', text: false },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(navNoText.status, 'ok')
    assert.doesNotMatch(navNoText.text, /Line one of stable instructions/)
    env.browser.dispose()
  })

  it('always preserves the closing </untrusted_webpage_content> tag under truncation across oversized snapshots and browser_eval outputs', async () => {
    const env = await withVisiblePage()

    // Oversized snapshot: 140 verbose elements + 20,000 chars of page text.
    const verboseElements = Array.from({ length: 140 }, (_, i) => ({
      ref: `e${i + 1}`,
      role: 'link',
      label: `Very long Wikipedia article link label number ${i + 1} `.repeat(3).trim(),
      href: `/wiki/Humpback_whale_reference_section_${i + 1}_${'x'.repeat(80)}`,
      inView: i < 20,
      rect: { x: 0, y: i * 24, w: 200, h: 20 },
    }))
    env.host.host.evalJs = async (_tabId, script, isolated) => {
      if (isolated) {
        return JSON.stringify({
          ...SNAPSHOT,
          totalInteractiveCount: verboseElements.length,
          elements: verboseElements,
          pageText: 'Humpback whale biology paragraph. '.repeat(600),
        })
      }
      return new AsyncFunction(script)()
    }

    const hugeObserve = await env.browser.run(
      'browser_observe',
      {},
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(hugeObserve.status, 'ok')
    assert.match(hugeObserve.text, /<untrusted_webpage_content url="https:\/\/example\.com\/">/)
    assert.ok(
      hugeObserve.text.trimEnd().endsWith('</untrusted_webpage_content>'),
      'observe output must keep closing </untrusted_webpage_content> tag when truncated'
    )
    assert.match(hugeObserve.text, /Truncated/i)

    // Oversized browser_eval outputs across multiple lengths.
    for (const size of [25_000, 40_000, 80_000]) {
      const hugeEval = await env.browser.run(
        'browser_eval',
        { script: `return "w".repeat(${size})` },
        { signal: signal(), sessionId: 's1' }
      )
      assert.equal(hugeEval.status, 'ok')
      assert.match(hugeEval.text, /^<untrusted_webpage_content url="[^"]*">\n/)
      assert.ok(
        hugeEval.text.trimEnd().endsWith('</untrusted_webpage_content>'),
        `eval output (${size} chars) must keep closing </untrusted_webpage_content> tag`
      )
      assert.match(hugeEval.text, /Truncated/i)
    }

    env.browser.dispose()
  })

  it('traverses same-origin iframes (cross-realm) for refs/select/text/wait and surfaces cross-origin iframes in snapshots', async () => {
    const dom = createInteractiveDom(
      'https://developer.mozilla.org/en-US/docs/select',
      'MDN Select'
    )
    dom.body.innerText = 'Top level MDN page'

    // Build a separate-realm same-origin iframe (its Element/HTMLSelectElement are distinct constructors).
    const frameDom = createInteractiveDom(
      'https://developer.mozilla.org/en-US/embed/demo',
      'Embedded Demo'
    )
    frameDom.body.innerText = 'Embedded demo instructions'
    const frameSelect = new frameDom.SimSelect(
      'Pet choice',
      [
        new frameDom.SimOption('', '--Choose--', true),
        new frameDom.SimOption('dog', 'Dog'),
        new frameDom.SimOption('cat', 'Cat'),
      ],
      12
    )
    let frameBtnClicks = 0
    const frameBtn = new frameDom.SimHTMLElement('button', 'Apply Pet', 56)
    frameBtn.onClickAction = () => {
      frameBtnClicks += 1
    }
    frameDom.body.append(frameSelect)
    frameDom.body.append(frameBtn)

    const sameOriginIframe = new dom.SimHTMLElement('iframe', '', 100) as unknown as {
      rect: {
        left: number
        top: number
        right: number
        bottom: number
        width: number
        height: number
      }
      attrs: Map<string, string>
      setAttribute: (k: string, v: string) => void
      contentDocument: unknown
      contentWindow: unknown
    }
    sameOriginIframe.rect = { left: 40, top: 100, right: 440, bottom: 320, width: 400, height: 220 }
    sameOriginIframe.setAttribute('src', 'https://developer.mozilla.org/en-US/embed/demo')
    sameOriginIframe.setAttribute('title', 'Same-origin demo')
    sameOriginIframe.contentDocument = frameDom.simDocument
    sameOriginIframe.contentWindow = frameDom.simWindow
    dom.body.append(sameOriginIframe as unknown as InstanceType<typeof dom.SimHTMLElement>)

    // Cross-origin iframe whose contentDocument throws SecurityError.
    const crossOriginIframe = new dom.SimHTMLElement('iframe', '', 340)
    crossOriginIframe.rect = {
      left: 40,
      top: 340,
      right: 680,
      bottom: 580,
      width: 640,
      height: 240,
    }
    crossOriginIframe.setAttribute('src', 'https://live.mdnplay.dev/en-US/docs/select/runner.html')
    crossOriginIframe.setAttribute('title', 'MDN live sample')
    Object.defineProperty(crossOriginIframe, 'contentDocument', {
      get() {
        throw new Error('Blocked a frame with origin from accessing a cross-origin frame.')
      },
    })
    Object.defineProperty(crossOriginIframe, 'contentWindow', {
      get() {
        return {
          get document() {
            throw new Error('Blocked a frame with origin from accessing a cross-origin frame.')
          },
        }
      },
    })
    dom.body.append(crossOriginIframe)

    const env = await withVisiblePage()
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    const obs = await env.browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })
    assert.equal(obs.status, 'ok')
    assert.match(obs.text, /select "Pet choice"/)
    assert.match(obs.text, /button "Apply Pet"/)
    assert.match(obs.text, /Embedded demo instructions/)
    assert.match(
      obs.text,
      /<untrusted_webpage_content[^>]*>[\s\S]*MDN live sample[\s\S]*live\.mdnplay\.dev[\s\S]*<\/untrusted_webpage_content>/
    )

    const selectRef = /\[(e\d+)\] select "Pet choice"/.exec(obs.text)?.[1]
    const btnRef = /\[(e\d+)\] button "Apply Pet"/.exec(obs.text)?.[1]
    assert.ok(selectRef && btnRef)

    const selected = await env.browser.run(
      'browser_select',
      { ref: selectRef, values: ['Cat'] },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(selected.status, 'ok')
    assert.equal(frameSelect.value, 'cat')

    const clicked = await env.browser.run(
      'browser_click',
      { ref: btnRef },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(clicked.status, 'ok')
    assert.equal(frameBtnClicks, 1)

    const waited = await env.browser.run(
      'browser_wait',
      { text: 'Embedded demo instructions', timeout_ms: 500 },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(waited.status, 'ok')
    env.browser.dispose()
  })

  it('executes keyboard default actions on browser_press_key (Tab/Shift+Tab, Enter, Space, Home/End) unless preventDefault is called', async () => {
    const dom = createInteractiveDom('https://example.com/form', 'Keyboard Form')
    const inputA = new dom.SimInput('Username', 20)
    const disabledBtn = new dom.SimHTMLElement('button', 'Disabled', 60)
    disabledBtn.setAttribute('disabled', '')
    const checkbox = new dom.SimInput('Remember me', 100)
    checkbox.type = 'checkbox'
    let actionClicks = 0
    const actionBtn = new dom.SimHTMLElement('button', 'Continue', 140)
    actionBtn.onClickAction = () => {
      actionClicks += 1
    }
    const guardedBtn = new dom.SimHTMLElement('button', 'Guarded', 180)
    let guardedClicks = 0
    guardedBtn.onClickAction = () => {
      guardedClicks += 1
    }
    guardedBtn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
      }
    })
    dom.body.append(inputA)
    dom.body.append(disabledBtn)
    dom.body.append(checkbox)
    dom.body.append(actionBtn)
    dom.body.append(guardedBtn)

    const env = await withVisiblePage()
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    // Home/End when body is focused.
    const endRes = await env.browser.run(
      'browser_press_key',
      { key: 'End' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(endRes.status, 'ok')
    assert.equal(dom.simWindow.scrollY, 2400)

    const homeRes = await env.browser.run(
      'browser_press_key',
      { key: 'Home' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(homeRes.status, 'ok')
    assert.equal(dom.simWindow.scrollY, 0)

    // Tab moves focus: body -> inputA -> checkbox (skipping disabledBtn) -> actionBtn; Shift+Tab returns to checkbox.
    const tab1 = await env.browser.run(
      'browser_press_key',
      { key: 'Tab' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(tab1.status, 'ok')
    assert.equal(dom.simDocument.activeElement, inputA)
    assert.match(tab1.text, /Focused: <input> "Username"/)

    const tab2 = await env.browser.run(
      'browser_press_key',
      { key: 'Tab' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(tab2.status, 'ok')
    assert.equal(dom.simDocument.activeElement, checkbox)

    // Space toggles the focused checkbox.
    const spaceRes = await env.browser.run(
      'browser_press_key',
      { key: ' ' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(spaceRes.status, 'ok')
    assert.equal(checkbox.checked, true)

    await env.browser.run(
      'browser_press_key',
      { key: 'Tab' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(dom.simDocument.activeElement, actionBtn)

    // Enter activates the focused button.
    const enterRes = await env.browser.run(
      'browser_press_key',
      { key: 'Enter' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(enterRes.status, 'ok')
    assert.equal(actionClicks, 1)

    // Shift+Tab moves back to checkbox.
    await env.browser.run(
      'browser_press_key',
      { key: 'Tab', modifiers: ['shift'] },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(dom.simDocument.activeElement, checkbox)

    // preventDefault() on keydown suppresses default Enter click.
    guardedBtn.focus()
    await env.browser.run(
      'browser_press_key',
      { key: 'Enter' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(guardedClicks, 0)
    env.browser.dispose()
  })

  it('clears transient driver highlight overlays before taking a screenshot and deduplicates text across same-page #hash clicks', async () => {
    const dom = createInteractiveDom(
      'https://en.wikipedia.org/wiki/DeepSeek',
      'DeepSeek - Wikipedia'
    )
    dom.body.innerText =
      'DeepSeek\nLong article body paragraph that should not be re-sent on anchor jump.'
    const historyLink = new dom.SimAnchor('History', '#History', 40)
    historyLink.onClickAction = () => {
      dom.simLocation.href = 'https://en.wikipedia.org/wiki/DeepSeek#History'
      dom.simWindow.scrollY = 2108
    }
    dom.body.append(historyLink)

    const env = await withVisiblePage()
    let overlaysDuringSnapshot = -1
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })
    env.host.host.takeSnapshot = async () => {
      overlaysDuringSnapshot = dom.docRoot.querySelectorAll('[data-ds-overlay="1"]').length
      return { dataUrl: 'data:image/jpeg;base64,CLEAN', width: 800, height: 600 }
    }

    const obs = await env.browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })
    assert.match(obs.text, /Long article body paragraph/)
    const historyRef = /\[(e\d+)\] link "History"/.exec(obs.text)?.[1]
    assert.ok(historyRef)

    const clicked = await env.browser.run(
      'browser_click',
      { ref: historyRef, screenshot: true },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(clicked.status, 'ok')
    assert.equal(
      overlaysDuringSnapshot,
      0,
      'transient highlight overlays must be cleared before screenshot'
    )
    assert.doesNotMatch(
      clicked.text,
      /Long article body paragraph/,
      'hash-only anchor click with unchanged text must deduplicate page text'
    )
    assert.match(clicked.text, /unchanged/i)
    env.browser.dispose()
  })

  it('indexes scrollable containers (without SoM badges), scrolls them proportionally, and reports container scroll offsets', async () => {
    const dom = createInteractiveDom('https://example.com/inbox', 'Inbox')
    const scroller = new dom.SimHTMLElement('div', '', 40)
    scroller.setAttribute('aria-label', 'Message list')
    scroller.style.overflowY = 'auto'
    scroller.rect = { left: 10, top: 40, right: 410, bottom: 340, width: 400, height: 300 }
    scroller.clientWidth = 400
    scroller.clientHeight = 300
    scroller.scrollWidth = 400
    scroller.scrollHeight = 1800
    const itemBtn = new dom.SimHTMLElement('button', 'Open thread', 50)
    scroller.append(itemBtn)
    dom.body.append(scroller)

    const env = await withVisiblePage()
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    const obs = await env.browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })
    assert.equal(obs.status, 'ok')
    assert.match(obs.text, /scrollable "Message list"/)
    const scrollRef = /\[(e\d+)\] scrollable "Message list"/.exec(obs.text)?.[1]
    assert.ok(scrollRef)

    const scrolled = await env.browser.run(
      'browser_scroll',
      { ref: scrollRef, direction: 'down' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(scrolled.status, 'ok')
    assert.equal(scroller.scrollTop, Math.round(300 * 0.75))
    assert.match(scrolled.text, /Scrolled \[e\d+\] down to \(0, 225\) of 400x1800/)
    env.browser.dispose()
  })

  it('uses native prototype value setter for single <select>, preserves selected option in truncated lists, and notes overflow', async () => {
    const dom = createInteractiveDom('https://example.com/countries', 'Countries')
    const options = Array.from({ length: 30 }, (_, i) => {
      const idx = i + 1
      return new dom.SimOption(`c${idx}`, `Country ${idx}`, idx === 28)
    })
    const select = new dom.SimSelect('Country', options, 30)
    let inputEvents = 0
    let changeEvents = 0
    select.addEventListener('input', () => {
      inputEvents += 1
    })
    select.addEventListener('change', () => {
      changeEvents += 1
    })
    dom.body.append(select)

    const env = await withVisiblePage()
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    const obs = await env.browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })
    assert.equal(obs.status, 'ok')
    assert.match(obs.text, /"c28":"Country 28"\*/)
    assert.match(obs.text, /\(\+10 more\)/)
    const selectRef = /\[(e\d+)\] select "Country"/.exec(obs.text)?.[1]
    assert.ok(selectRef)

    const beforeSetterCalls = dom.getSelectProtoSetterCalls()
    const res = await env.browser.run(
      'browser_select',
      { ref: selectRef, values: ['Country 5'] },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(res.status, 'ok')
    assert.equal(select.value, 'c5')
    assert.ok(
      dom.getSelectProtoSetterCalls() > beforeSetterCalls,
      'must use native prototype value setter'
    )
    assert.equal(inputEvents, 1)
    assert.equal(changeEvents, 1)
    env.browser.dispose()
  })

  it('evaluates multi-line expressions, IIFEs, strings with keywords/semicolons, and non-JSON values in browser_eval', async () => {
    const { browser } = await withVisiblePage()
    const run = (script: string) =>
      browser.run('browser_eval', { script }, { signal: signal(), sessionId: 's1' })

    const multilineObj = await run('({\n  a: 1,\n  b: "two"\n})')
    assert.equal(multilineObj.status, 'ok')
    assert.match(multilineObj.text, /"a": 1/)
    assert.match(multilineObj.text, /"b": "two"/)

    const stringWithKeywordAndSemi = await run('"if;then".split(";")[0]')
    assert.equal(stringWithKeywordAndSemi.status, 'ok')
    assert.match(stringWithKeywordAndSemi.text, /\nif\n/)

    const iife = await run('(() => {\n  const x = 6;\n  return x * 7;\n})()')
    assert.equal(iife.status, 'ok')
    assert.match(iife.text, /\n42\n/)

    const specialValues = await run(
      'const obj = { s: new Set([1, 2]), big: 9n }; obj.self = obj; return obj;'
    )
    assert.equal(specialValues.status, 'ok')
    assert.match(specialValues.text, /\[Circular\]/)
    assert.match(specialValues.text, /"9"/)
    browser.dispose()
  })

  it('reports the next active tab on browser_tabs close and avoids scrolling before coordinate clicks', async () => {
    const dom = createInteractiveDom('https://example.com/coords', 'Coords')
    let clicks = 0
    const btn = new dom.SimHTMLElement('button', 'Target', 40)
    btn.rect = { left: 50, top: 40, right: 170, bottom: 72, width: 120, height: 32 }
    btn.onClickAction = () => {
      clicks += 1
    }
    dom.body.append(btn)

    const env = await withVisiblePage()
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    // Coordinate click must NOT call scrollIntoView before clicking at (x, y).
    const coordClick = await env.browser.run(
      'browser_click',
      { x: 100, y: 55 },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(coordClick.status, 'ok')
    assert.equal(clicks, 1)
    assert.equal(btn.scrollIntoViewCalls, 0)

    // Opening a second tab and closing it reports the active tab we returned to.
    const firstTabId = env.browser.getSession('s1').tabs[0]?.id ?? ''
    assert.ok(firstTabId)
    const opened = await env.browser.run(
      'browser_tabs',
      { action: 'new', url: 'https://example.org/' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(opened.status, 'ok')

    const closedSecond = await env.browser.run(
      'browser_tabs',
      { action: 'close' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(closedSecond.status, 'ok')
    assert.match(closedSecond.text, new RegExp(`Active tab is now ${firstTabId}`))
    assert.equal(closedSecond.meta.url, 'https://example.com/')

    const closedLast = await env.browser.run(
      'browser_tabs',
      { action: 'close' },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(closedLast.status, 'ok')
    assert.match(closedLast.text, /No tabs remain/i)
    env.browser.dispose()
  })

  it('prevents link-dense pages from starving Page text, reports exact truncation counts, and clarifies ref stability when elements are capped', async () => {
    const dom = createInteractiveDom(
      'https://en.wikipedia.org/wiki/Red_panda',
      'Red panda - Wikipedia'
    )
    for (let i = 1; i <= 180; i += 1) {
      const link = new dom.SimAnchor(
        `Red panda taxonomy reference link entry number ${i} with descriptive title`,
        `/wiki/Red_panda_section_${i}_${'a'.repeat(80)}`,
        i <= 15 ? i * 30 : 1200 + i * 24
      )
      dom.body.append(link)
    }
    const prefix = 'Red panda habitat notes. '.repeat(400) // 10,000 chars
    const deepMarker = 'DEEP_SECTION_MARKER_10K'
    const tail = 'Additional alpine ecology context. '.repeat(450).trimEnd() // ~15,749 chars
    dom.body.innerText = `${prefix}${deepMarker}${tail}`
    const expectedTotal = dom.body.innerText.length

    const env = await withVisiblePage()
    env.host.host.evalJs = async (_tabId, script, isolated) =>
      isolated ? dom.runScript(script) : JSON.stringify({ ok: true, value: null })

    const obs = await env.browser.run('browser_observe', {}, { signal: signal(), sessionId: 's1' })
    assert.equal(obs.status, 'ok')
    assert.ok(obs.text.length <= 24_000, `output length ${obs.text.length} must stay within 24,000`)
    assert.ok(
      obs.text.trimEnd().endsWith('</untrusted_webpage_content>'),
      'output must end cleanly with </untrusted_webpage_content>'
    )
    assert.match(
      obs.text,
      /Interactive elements \(showing \d+ of 180, in-viewport first; existing \[eN\] refs stay valid\):/
    )
    assert.match(obs.text, /Page text:/)
    assert.ok(
      obs.text.includes(deepMarker),
      'link-dense interactive elements must not starve Page text before ~10,000 chars'
    )
    assert.match(
      obs.text,
      new RegExp(
        `\\[Page text truncated: showing [\\d,]+ of ${expectedTotal.toLocaleString()} chars; use browser_observe with selector or browser_eval to read other sections\\]`
      )
    )
    env.browser.dispose()
  })

  it('reports CSS viewport pixels, Retina screenshot pixel dimensions/scale, and CSS coordinate schemas', async () => {
    const env = await withVisiblePage()
    const declared = env.browser.declareTools({ enabled: true })
    const clickSchema = declared.find((t) => t.name === 'browser_click')?.input_schema as {
      properties?: Record<string, { description?: string }>
    }
    const typeSchema = declared.find((t) => t.name === 'browser_type')?.input_schema as {
      properties?: Record<string, { description?: string }>
    }
    assert.match(clickSchema?.properties?.x?.description ?? '', /CSS viewport/i)
    assert.match(clickSchema?.properties?.x?.description ?? '', /not raw screenshot pixels/i)
    assert.match(typeSchema?.properties?.y?.description ?? '', /CSS viewport/i)

    // 2x Retina screenshot on an 800x600 CSS viewport.
    env.host.host.takeSnapshot = async () => ({
      dataUrl: 'data:image/jpeg;base64,RETINA',
      width: 800,
      height: 600,
      pixelWidth: 1600,
      pixelHeight: 1200,
    })
    const retinaObs = await env.browser.run(
      'browser_observe',
      { screenshot: true },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(retinaObs.status, 'ok')
    assert.match(retinaObs.text, /Viewport: 800x600 CSS px/)
    assert.match(
      retinaObs.text,
      /Screenshot: 1600x1200px \(2x vs CSS viewport; browser_click\/browser_type x,y use CSS viewport px\)/
    )

    // 1x screenshot reports 1x CSS viewport without scale warning noise.
    env.host.host.takeSnapshot = async () => ({
      dataUrl: 'data:image/jpeg;base64,STANDARD',
      width: 800,
      height: 600,
      pixelWidth: 800,
      pixelHeight: 600,
    })
    const standardObs = await env.browser.run(
      'browser_observe',
      { screenshot: true },
      { signal: signal(), sessionId: 's1' }
    )
    assert.equal(standardObs.status, 'ok')
    assert.match(standardObs.text, /Screenshot: 800x600px \(1x CSS viewport\)/)
    env.browser.dispose()
  })
})
