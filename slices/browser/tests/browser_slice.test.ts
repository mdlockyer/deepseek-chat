import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PanelLayout, PanelSlot } from '@deepseek-chat/spine/design'
import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import { memoryStore } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
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
    setActiveTab: (tabId, bounds, visible) => {
      calls.push({ name: 'setActiveTab', args: [tabId, bounds, visible] })
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
    stopController: () => {},
    newId: () => `id${++counter}`,
  })
  /** What the app does on a chat switch: the panel first, then the browser. */
  const activate = (sessionId: string | null) => {
    panel.setActive(sessionId)
    browser.setActiveSession(sessionId)
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

  it('hides under overlay locks until the last one is released; double release is harmless', async () => {
    const { browser, host } = await withVisiblePage()
    const releaseA = browser.acquireOverlayLock()
    const releaseB = browser.acquireOverlayLock()
    await settle()
    assert.equal(host.lastActive.visible, false)

    releaseA()
    releaseA()
    await settle()
    assert.equal(host.lastActive.visible, false, 'one lock still held')

    releaseB()
    await settle()
    assert.equal(host.lastActive.visible, true)
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
})
