import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { act, createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { createLocaleStore, LocaleProvider } from '@deepseek-chat/spine/i18n'
import {
  HOVER_GLIDE_ITEM_ATTR,
  HOVER_GLIDE_SURFACE_ATTR,
  HoverGlide,
  HoverGlideIndicator,
  INITIAL_HOVER_GLIDE_STATE,
  ToastViewport,
  UiProvider,
  VIEWPORT_PADDING,
  computeAnchoredPosition,
  createNoticeBus,
  createOverlayCoordinator,
  enterGlideTarget,
  expireGlideCooldown,
  glideRectsEqual,
  hoverGlideItem,
  leaveGlideTarget,
  measureGlideRect,
  normalizeGlideRadius,
  syncGlideRect,
  usePresence,
  type GlideRect,
} from '@deepseek-chat/lib-ui'

const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('lib-ui OverlayCoordinator', () => {
  it('announces only 0->1 and 1->0 transitions and ignores duplicate releases', () => {
    const coord = createOverlayCoordinator()
    const seen: boolean[] = []
    const unsub = coord.subscribe((open) => seen.push(open))

    const releaseA = coord.acquire()
    const releaseB = coord.acquire()
    assert.equal(coord.isOpen(), true)
    releaseA()
    releaseA()
    assert.equal(coord.isOpen(), true)
    releaseB()
    assert.equal(coord.isOpen(), false)
    unsub()

    assert.deepEqual(seen, [true, false])
  })

  it('matches a reference active-lock set across randomized acquire/release sequences', () => {
    const rand = mulberry32(42)
    const coord = createOverlayCoordinator()
    const active: Array<() => void> = []
    const transitions: boolean[] = []
    coord.subscribe((open) => transitions.push(open))

    for (let step = 0; step < 120; step += 1) {
      const wasOpen = active.length > 0
      if (active.length === 0 || rand() < 0.55) {
        active.push(coord.acquire())
      } else {
        const idx = Math.floor(rand() * active.length)
        const [release] = active.splice(idx, 1)
        release?.()
        // Duplicate release must be an idempotent no-op.
        release?.()
      }
      const isNowOpen = active.length > 0
      assert.equal(coord.isOpen(), isNowOpen)
      if (wasOpen !== isNowOpen) {
        assert.equal(transitions.at(-1), isNowOpen)
      }
    }
    while (active.length > 0) {
      active.pop()?.()
    }
    assert.equal(coord.isOpen(), false)
  })
})

describe('lib-ui NoticeBus & ToastViewport', () => {
  beforeEach(() =>
    mock.timers.enable({ apis: ['setTimeout'] } as unknown as Parameters<
      typeof mock.timers.enable
    >[0])
  )
  afterEach(() => {
    mock.timers.reset()
  })

  it('replaces the active notice, cancels stale timers, and keeps linked notices longer', () => {
    const bus = createNoticeBus()
    bus.show({ text: () => 'first' })
    mock.timers.tick(2000)
    bus.show({ text: () => 'second' })
    mock.timers.tick(1500)
    assert.equal(bus.getSnapshot().content?.text(), 'second')
    mock.timers.tick(1500)
    assert.equal(bus.getSnapshot().content, null)

    bus.show({ text: () => 'quota', link: { text: () => 'details', href: 'https://example.test' } })
    mock.timers.tick(4999)
    assert.notEqual(bus.getSnapshot().content, null)
    mock.timers.tick(1)
    assert.equal(bus.getSnapshot().content, null)
  })

  it('renders active notice inside ToastViewport via UiProvider in the live locale', () => {
    const bus = createNoticeBus()
    const locale = createLocaleStore('zh-CN')
    bus.show({
      text: (loc) => (loc === 'zh-CN' ? 'rendered-zh' : 'rendered-en'),
      tone: 'error',
      link: {
        text: (loc) => (loc === 'zh-CN' ? '详情' : 'Details'),
        href: 'https://example.test/',
      },
    })

    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        { store: locale },
        createElement(UiProvider, { notices: bus }, createElement(ToastViewport))
      )
    )
    assert.match(html, /role="status"/)
    assert.match(html, /rendered-zh/)
    assert.match(html, /详情/)
    assert.match(html, /href="https:\/\/example\.test\/"/)
  })
})

describe('lib-ui computeAnchoredPosition invariants', () => {
  it('keeps floating boxes inside viewport bounds across randomized geometries', () => {
    const rand = mulberry32(1337)
    const sides = ['top', 'bottom'] as const
    const aligns = ['start', 'center', 'end'] as const

    for (let i = 0; i < 200; i += 1) {
      const vw = 360 + Math.floor(rand() * 1200)
      const vh = 480 + Math.floor(rand() * 800)
      const aw = 24 + Math.floor(rand() * 160)
      const ah = 24 + Math.floor(rand() * 48)
      const al = Math.floor(rand() * Math.max(1, vw - aw))
      const at = Math.floor(rand() * Math.max(1, vh - ah))
      const fw = 80 + Math.floor(rand() * 200)
      const fh = 40 + Math.floor(rand() * 180)
      const side = sides[Math.floor(rand() * sides.length)]
      const align = aligns[Math.floor(rand() * aligns.length)]

      const pos = computeAnchoredPosition({
        anchor: { left: al, right: al + aw, top: at, bottom: at + ah, width: aw, height: ah },
        floating: { width: fw, height: fh, scrollHeight: fh },
        viewport: { width: vw, height: vh },
        options: { side, align, offset: 4 },
      })

      assert.ok(pos.left !== undefined)
      assert.ok(
        pos.left >= VIEWPORT_PADDING,
        `left ${pos.left} violated VIEWPORT_PADDING (${VIEWPORT_PADDING})`
      )
      if (fw + VIEWPORT_PADDING * 2 <= vw) {
        assert.ok(
          pos.left + fw <= vw - VIEWPORT_PADDING + 0.01,
          `right edge ${pos.left + fw} overflowed viewport ${vw}`
        )
      }
      if (fh + VIEWPORT_PADDING * 2 <= vh) {
        assert.ok(pos.top >= VIEWPORT_PADDING - 0.01, `top ${pos.top} overflowed viewport`)
        assert.ok(
          pos.top + fh <= vh - VIEWPORT_PADDING + 0.01,
          `bottom edge ${pos.top + fh} overflowed viewport ${vh}`
        )
      }
    }
  })
})

const rowRect = (index: number): GlideRect => ({ x: 2, y: index * 40, width: 236, height: 40 })

describe('lib-ui HoverGlide state machine & geometry', () => {
  it('round-trips viewport and scroll-content coordinates and transitions cold/warm/cooling/muted', () => {
    const rect = measureGlideRect(
      { left: 14, top: 180, width: 236, height: 40 },
      { left: 10, top: 100, width: 240, height: 500 },
      0,
      320,
      1,
      2
    )
    assert.equal(10 + 1 - 0 + rect.x, 14)
    assert.equal(100 + 2 - 320 + rect.y, 180)

    const first = enterGlideTarget(INITIAL_HOVER_GLIDE_STATE, 'r1', rowRect(1), false)
    assert.equal(first.effect.animatePosition, false)
    const second = enterGlideTarget(first.state, 'r2', rowRect(2), false)
    assert.equal(second.effect.animatePosition, true)
    const left = leaveGlideTarget(second.state)
    assert.equal(left.state.kind, 'cooling')
    const expired = expireGlideCooldown(left.state)
    assert.equal(expired.state.kind, 'cold')
    assert.equal(expired.effect.resetGeometry, true)

    const synced = syncGlideRect(second.state, { x: 2, y: 120, width: 260, height: 40 })
    assert.equal(synced.effect.changed, true)
    assert.equal(synced.effect.animatePosition, false)

    assert.deepEqual(hoverGlideItem(), { [HOVER_GLIDE_ITEM_ATTR]: '' })
    assert.deepEqual(hoverGlideItem(true), { [HOVER_GLIDE_ITEM_ATTR]: 'muted' })
    const html = renderToStaticMarkup(createElement(HoverGlideIndicator))
    assert.match(html, /aria-hidden="true"/)

    const activeSurfaceHtml = renderToStaticMarkup(
      createElement(HoverGlide, null, createElement('button', hoverGlideItem(), 'Row'))
    )
    assert.match(activeSurfaceHtml, new RegExp(`${HOVER_GLIDE_SURFACE_ATTR}="active"`))
    assert.match(activeSurfaceHtml, /aria-hidden="true"/)
    assert.match(activeSurfaceHtml, /Row/)

    const disabledSurfaceHtml = renderToStaticMarkup(
      createElement(HoverGlide, { disabled: true }, 'Hidden')
    )
    assert.match(disabledSurfaceHtml, new RegExp(`${HOVER_GLIDE_SURFACE_ATTR}="disabled"`))
  })

  it('normalizes and clamps corner radii so rounded rows morph smoothly into capsule pills', () => {
    assert.equal(normalizeGlideRadius('9999px', 140, 32), '16px')
    assert.equal(normalizeGlideRadius('12px', 540, 32), '12px')
    assert.equal(normalizeGlideRadius('12px 12px 12px 12px', 236, 40), '12px')
    assert.equal(normalizeGlideRadius('12px 12px 0px 0px', 200, 40), '12px 12px 0px 0px')
    assert.equal(normalizeGlideRadius('50%', 32, 32), '16px')
    assert.equal(normalizeGlideRadius('0', 200, 32), '0px')
    assert.equal(normalizeGlideRadius('', 200, 32), null)
    assert.equal(normalizeGlideRadius('12px', 0, 32), null)
    assert.equal(normalizeGlideRadius('12px / 8px', 200, 32), null)

    const base: GlideRect = { x: 8, y: 12, width: 200, height: 32 }
    assert.equal(glideRectsEqual(base, { ...base, radius: null }), true)
    assert.equal(glideRectsEqual({ ...base, radius: '12px' }, { ...base, radius: '16px' }), false)
    assert.equal(glideRectsEqual({ ...base, radius: '16px' }, { ...base, radius: '16px' }), true)
  })
})

const installMinimalDom = ({ reducedMotion = false }: { reducedMotion?: boolean } = {}) => {
  const globals = globalThis as Record<string, unknown>
  const savedKeys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const saved = new Map<string, { hadOwn: boolean; value: unknown }>()
  for (const key of savedKeys) {
    saved.set(key, { hadOwn: Object.hasOwn(globals, key), value: globals[key] })
  }

  let now = 0
  let nextTimerId = 1
  const pendingTimers = new Map<number, { at: number; callback: () => void }>()

  const FakeIFrame = function FakeIFrame() {}
  class FakeNode {
    nodeType: number
    nodeName: string
    tagName: string
    nodeValue = ''
    childNodes: FakeNode[] = []
    parentNode: FakeNode | null = null
    ownerDocument: unknown
    style: Record<string, string> = {}
    namespaceURI = 'http://www.w3.org/1999/xhtml'

    constructor(nodeType: number, nodeName: string, ownerDocument: unknown) {
      this.nodeType = nodeType
      this.nodeName = nodeName
      this.tagName = nodeName
      this.ownerDocument = ownerDocument
    }

    appendChild(child: FakeNode) {
      child.parentNode = this
      this.childNodes.push(child)
      return child
    }

    removeChild(child: FakeNode) {
      this.childNodes = this.childNodes.filter((item) => item !== child)
      child.parentNode = null
      return child
    }

    insertBefore(child: FakeNode, ref: FakeNode | null) {
      child.parentNode = this
      const index = ref ? this.childNodes.indexOf(ref) : -1
      if (index >= 0) {
        this.childNodes.splice(index, 0, child)
      } else {
        this.childNodes.push(child)
      }
      return child
    }

    addEventListener() {}
    removeEventListener() {}
    setAttribute() {}
    removeAttribute() {}

    get firstChild(): FakeNode | null {
      return this.childNodes[0] ?? null
    }

    get nextSibling(): FakeNode | null {
      if (!this.parentNode) {
        return null
      }
      const index = this.parentNode.childNodes.indexOf(this)
      return this.parentNode.childNodes[index + 1] ?? null
    }

    set textContent(value: string) {
      this.childNodes = value ? [doc.createTextNode(String(value))] : []
    }

    get textContent(): string {
      return this.nodeType === 3
        ? this.nodeValue
        : this.childNodes.map((child) => child.textContent).join('')
    }
  }

  const win = {
    setTimeout(callback: () => void, delay = 0) {
      const id = nextTimerId++
      pendingTimers.set(id, { at: now + Math.max(0, delay), callback })
      return id
    },
    clearTimeout(id: number) {
      pendingTimers.delete(id)
    },
    matchMedia: (query: string) => ({
      matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
    }),
    addEventListener() {},
    removeEventListener() {},
    navigator: { userAgent: '' },
    HTMLIFrameElement: FakeIFrame,
  }

  const doc = {
    nodeType: 9,
    defaultView: win,
    documentElement: null as FakeNode | null,
    body: null as FakeNode | null,
    activeElement: null,
    createElement(tag: string) {
      return new FakeNode(1, tag.toUpperCase(), doc)
    },
    createTextNode(text: string) {
      const node = new FakeNode(3, '#text', doc)
      node.nodeValue = text
      return node
    },
    addEventListener() {},
    removeEventListener() {},
  }
  doc.documentElement = doc.createElement('html')
  doc.body = doc.createElement('body')

  globals.window = win
  globals.document = doc
  globals.HTMLElement = FakeNode
  globals.IS_REACT_ACT_ENVIRONMENT = true

  return {
    container: doc.createElement('div') as unknown as HTMLElement,
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...pendingTimers.entries()]) {
        if (timer.at <= now) {
          pendingTimers.delete(id)
          timer.callback()
        }
      }
    },
    pendingTimerCount: () => pendingTimers.size,
    restore() {
      pendingTimers.clear()
      for (const [key, entry] of saved) {
        if (entry.hadOwn) {
          globals[key] = entry.value
        } else {
          Reflect.deleteProperty(globals, key)
        }
      }
    },
  }
}

describe('lib-ui usePresence (SPEC 10)', () => {
  it('mounts synchronously, holds exit for durationMs, cancels mid-exit reopen, and stays in sync with useSyncExternalStore', async () => {
    const dom = installMinimalDom()
    const CLOSED = { open: false as const }
    let snapshot: { readonly open: boolean } = CLOSED
    const listeners = new Set<() => void>()
    const store = {
      getState: () => snapshot,
      setState: (next: { readonly open: boolean }) => {
        snapshot = next
        for (const listener of listeners) {
          listener()
        }
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }

    const Probe = () => {
      const current = useSyncExternalStore(store.subscribe, store.getState)
      const { mounted, exiting } = usePresence(current.open, 200)
      return createElement('div', null, `${current.open}:${mounted}:${exiting}`)
    }

    const root = createRoot(dom.container)
    try {
      await act(async () => {
        root.render(createElement(Probe))
      })
      assert.equal(dom.container.textContent, 'false:false:false')

      // Opening mounts immediately without render-phase setState stalling external-store commits.
      await act(async () => {
        store.setState({ open: true })
      })
      assert.equal(dom.container.textContent, 'true:true:false')

      // Returning to the exact prior CLOSED snapshot reference must re-render and enter exit phase.
      await act(async () => {
        store.setState(CLOSED)
      })
      assert.equal(dom.container.textContent, 'false:true:true')

      // Stays mounted until the full exit duration elapses.
      await act(async () => {
        dom.advance(199)
      })
      assert.equal(dom.container.textContent, 'false:true:true')

      await act(async () => {
        dom.advance(1)
      })
      assert.equal(dom.container.textContent, 'false:false:false')

      // Reopening mid-exit cancels the unmount timer and keeps the surface mounted.
      await act(async () => {
        store.setState({ open: true })
      })
      assert.equal(dom.container.textContent, 'true:true:false')

      await act(async () => {
        store.setState(CLOSED)
      })
      assert.equal(dom.container.textContent, 'false:true:true')

      await act(async () => {
        dom.advance(100)
        store.setState({ open: true })
      })
      assert.equal(dom.container.textContent, 'true:true:false')
      assert.equal(dom.pendingTimerCount(), 0)

      await act(async () => {
        dom.advance(500)
      })
      assert.equal(dom.container.textContent, 'true:true:false')
    } finally {
      await act(async () => {
        root.unmount()
      })
      dom.restore()
    }
  })

  it('unmounts immediately without scheduling timers when reduced motion is preferred or durationMs <= 0', async () => {
    for (const scenario of [
      { reducedMotion: true, durationMs: 200 },
      { reducedMotion: false, durationMs: 0 },
    ]) {
      const dom = installMinimalDom({ reducedMotion: scenario.reducedMotion })
      const Probe = ({ open }: { open: boolean }) => {
        const { mounted, exiting } = usePresence(open, scenario.durationMs)
        return createElement('div', null, `${mounted}:${exiting}`)
      }
      const root = createRoot(dom.container)
      try {
        await act(async () => {
          root.render(createElement(Probe, { open: true }))
        })
        assert.equal(dom.container.textContent, 'true:false')

        await act(async () => {
          root.render(createElement(Probe, { open: false }))
        })
        assert.equal(dom.container.textContent, 'false:false')
        assert.equal(dom.pendingTimerCount(), 0)
      } finally {
        await act(async () => {
          root.unmount()
        })
        dom.restore()
      }
    }
  })
})

describe('lib-ui <HoverGlide> interactive DOM behavior', () => {
  it('morphs clamped radius across mixed shapes, skips disabled targets, observes stationary mute changes, and retargets on ancestor scroll and resize', async () => {
    const globals = globalThis as Record<string, unknown>
    const savedKeys = [
      'window',
      'document',
      'HTMLElement',
      'Element',
      'Node',
      'ResizeObserver',
      'MutationObserver',
      'IS_REACT_ACT_ENVIRONMENT',
    ] as const
    const saved = new Map<string, { hadOwn: boolean; value: unknown }>()
    for (const key of savedKeys) {
      saved.set(key, { hadOwn: Object.hasOwn(globals, key), value: globals[key] })
    }

    const rects = new WeakMap<
      FakeEl,
      { left: number; top: number; width: number; height: number }
    >()
    const radii = new WeakMap<FakeEl, string>()
    const windowListeners = new Map<string, Set<(event: unknown) => void>>()
    const rafQueue: (() => void)[] = []
    let hitTarget: FakeEl | null = null
    const observers: {
      resize: (() => void) | null
      mutation: ((records: { target: FakeEl }[]) => void) | null
    } = { resize: null, mutation: null }
    const pendingTimers = new Map<number, () => void>()
    let nextTimerId = 1

    const toKebab = (name: string) => name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)

    class FakeEl {
      nodeType: number
      nodeName: string
      tagName: string
      nodeValue = ''
      childNodes: FakeEl[] = []
      parentNode: FakeEl | null = null
      ownerDocument: unknown
      style: Record<string, string> = {}
      namespaceURI = 'http://www.w3.org/1999/xhtml'
      scrollLeft = 0
      scrollTop = 0
      clientLeft = 0
      clientTop = 0
      offsetWidth = 100
      private attrs = new Map<string, string>()
      private listeners = new Map<string, Set<(event: unknown) => void>>()

      dataset: Record<string, string | undefined>

      constructor(nodeType: number, nodeName: string, ownerDocument: unknown) {
        this.nodeType = nodeType
        this.nodeName = nodeName
        this.tagName = nodeName
        this.ownerDocument = ownerDocument
        this.dataset = new Proxy(
          {},
          {
            get: (_target, prop: string) => this.attrs.get(`data-${toKebab(prop)}`),
            set: (_target, prop: string, value: string) => {
              this.setAttribute(`data-${toKebab(prop)}`, String(value))
              return true
            },
          }
        )
      }

      get isConnected(): boolean {
        return this.parentNode !== null
      }

      appendChild(child: FakeEl) {
        child.parentNode = this
        this.childNodes.push(child)
        return child
      }

      removeChild(child: FakeEl) {
        this.childNodes = this.childNodes.filter((item) => item !== child)
        child.parentNode = null
        return child
      }

      insertBefore(child: FakeEl, ref: FakeEl | null) {
        child.parentNode = this
        const index = ref ? this.childNodes.indexOf(ref) : -1
        if (index >= 0) {
          this.childNodes.splice(index, 0, child)
        } else {
          this.childNodes.push(child)
        }
        return child
      }

      setAttribute(name: string, value: string) {
        this.attrs.set(name, String(value))
        if (
          observers.mutation &&
          (name === HOVER_GLIDE_ITEM_ATTR || name === 'disabled' || name === 'aria-disabled')
        ) {
          observers.mutation([{ target: this }])
        }
      }

      getAttribute(name: string): string | null {
        return this.attrs.has(name) ? (this.attrs.get(name) ?? '') : null
      }

      hasAttribute(name: string): boolean {
        return this.attrs.has(name)
      }

      removeAttribute(name: string) {
        this.attrs.delete(name)
      }

      contains(node: FakeEl | null): boolean {
        for (let cur: FakeEl | null = node; cur; cur = cur.parentNode) {
          if (cur === this) {
            return true
          }
        }
        return false
      }

      matches(selector: string): boolean {
        if (selector === `[${HOVER_GLIDE_ITEM_ATTR}]`) {
          return this.attrs.has(HOVER_GLIDE_ITEM_ATTR)
        }
        if (selector === ':disabled') {
          return this.attrs.has('disabled')
        }
        return false
      }

      closest(selector: string): FakeEl | null {
        if (this.matches(selector)) {
          return this
        }
        return this.parentNode ? this.parentNode.closest(selector) : null
      }

      getBoundingClientRect() {
        return rects.get(this) ?? { left: 0, top: 0, width: 0, height: 0 }
      }

      addEventListener(type: string, fn: (event: unknown) => void) {
        let set = this.listeners.get(type)
        if (!set) {
          set = new Set()
          this.listeners.set(type, set)
        }
        set.add(fn)
      }

      removeEventListener(type: string, fn: (event: unknown) => void) {
        this.listeners.get(type)?.delete(fn)
      }

      dispatch(type: string, event: Record<string, unknown>) {
        for (const fn of [...(this.listeners.get(type) ?? [])]) {
          fn(event)
        }
      }

      get firstChild(): FakeEl | null {
        return this.childNodes[0] ?? null
      }

      get nextSibling(): FakeEl | null {
        if (!this.parentNode) {
          return null
        }
        const index = this.parentNode.childNodes.indexOf(this)
        return this.parentNode.childNodes[index + 1] ?? null
      }

      set textContent(value: string) {
        this.childNodes = value ? [doc.createTextNode(String(value))] : []
      }

      get textContent(): string {
        return this.nodeType === 3
          ? this.nodeValue
          : this.childNodes.map((child) => child.textContent).join('')
      }

      get className(): string {
        return this.attrs.get('class') ?? ''
      }

      set className(value: string) {
        this.attrs.set('class', value)
      }
    }

    const win = {
      setTimeout(cb: () => void) {
        const id = nextTimerId++
        pendingTimers.set(id, cb)
        return id
      },
      clearTimeout(id: number) {
        pendingTimers.delete(id)
      },
      requestAnimationFrame(cb: () => void) {
        rafQueue.push(cb)
        return rafQueue.length
      },
      cancelAnimationFrame() {},
      getComputedStyle(el: FakeEl) {
        return { borderRadius: radii.get(el) ?? '' }
      },
      addEventListener(type: string, fn: (event: unknown) => void) {
        let set = windowListeners.get(type)
        if (!set) {
          set = new Set()
          windowListeners.set(type, set)
        }
        set.add(fn)
      },
      removeEventListener(type: string, fn: (event: unknown) => void) {
        windowListeners.get(type)?.delete(fn)
      },
      navigator: { userAgent: '' },
      HTMLIFrameElement: function FakeIFrame() {},
    }

    const doc = {
      nodeType: 9,
      defaultView: win,
      documentElement: null as FakeEl | null,
      body: null as FakeEl | null,
      activeElement: null,
      createElement(tag: string) {
        return new FakeEl(1, tag.toUpperCase(), doc)
      },
      createTextNode(text: string) {
        const node = new FakeEl(3, '#text', doc)
        node.nodeValue = text
        return node
      },
      elementFromPoint: () => hitTarget,
      addEventListener() {},
      removeEventListener() {},
    }
    doc.documentElement = doc.createElement('html')
    doc.body = doc.createElement('body')

    globals.window = win
    globals.document = doc
    globals.HTMLElement = FakeEl
    globals.Element = FakeEl
    globals.Node = FakeEl
    globals.ResizeObserver = class {
      constructor(cb: () => void) {
        observers.resize = cb
      }
      observe() {}
      disconnect() {}
    }
    globals.MutationObserver = class {
      constructor(cb: (records: { target: FakeEl }[]) => void) {
        observers.mutation = cb
      }
      observe() {}
      disconnect() {}
    }
    globals.IS_REACT_ACT_ENVIRONMENT = true

    const scroller = doc.createElement('div')
    const mount = doc.createElement('div')
    scroller.appendChild(mount)
    doc.body.appendChild(scroller)

    let surfaceEl: FakeEl | null = null
    let rowEl: FakeEl | null = null
    let pillEl: FakeEl | null = null
    let disabledEl: FakeEl | null = null
    let mutedBtnEl: FakeEl | null = null

    const Demo = ({ muted }: { muted: boolean }) =>
      createElement(
        HoverGlide,
        {
          ref: (node: HTMLDivElement | null) => {
            surfaceEl = node as unknown as FakeEl | null
          },
        },
        createElement(
          'button',
          {
            ...hoverGlideItem(),
            ref: (node: HTMLButtonElement | null) => {
              rowEl = node as unknown as FakeEl | null
            },
          },
          'Trace row'
        ),
        createElement(
          'button',
          {
            ...hoverGlideItem(),
            ref: (node: HTMLButtonElement | null) => {
              pillEl = node as unknown as FakeEl | null
            },
          },
          'Show more'
        ),
        createElement(
          'button',
          {
            ...hoverGlideItem(),
            disabled: true,
            ref: (node: HTMLButtonElement | null) => {
              disabledEl = node as unknown as FakeEl | null
            },
          },
          'Disabled'
        ),
        createElement(
          'button',
          {
            ...hoverGlideItem(muted),
            ref: (node: HTMLButtonElement | null) => {
              mutedBtnEl = node as unknown as FakeEl | null
            },
          },
          'Open in Activity'
        )
      )

    const root = createRoot(mount as unknown as HTMLElement)
    try {
      await act(async () => {
        root.render(createElement(Demo, { muted: true }))
      })
      assert.ok(surfaceEl && rowEl && pillEl && disabledEl && mutedBtnEl)
      const surface = surfaceEl as FakeEl
      const row = rowEl as FakeEl
      const pill = pillEl as FakeEl
      const disabledBtn = disabledEl as FakeEl
      const mutedBtn = mutedBtnEl as FakeEl
      const indicator = surface.childNodes[0]

      surface.clientLeft = 1
      rects.set(surface, { left: 10, top: 100, width: 560, height: 200 })
      rects.set(row, { left: 19, top: 104, width: 540, height: 32 })
      radii.set(row, '12px')
      rects.set(pill, { left: 19, top: 146, width: 140, height: 32 })
      radii.set(pill, '9999px')
      rects.set(disabledBtn, { left: 163, top: 146, width: 100, height: 32 })
      radii.set(disabledBtn, '9999px')
      rects.set(mutedBtn, { left: 267, top: 146, width: 130, height: 32 })
      radii.set(mutedBtn, '9999px')

      // React attaches pointer handlers via props; pull the React props from the fiber key to fire synthetic events cleanly.
      const reactPropsKey = Object.keys(surface).find((key) => key.startsWith('__reactProps$'))
      assert.ok(reactPropsKey, 'surface has React props')
      const handlers = (surface as unknown as Record<string, Record<string, (e: unknown) => void>>)[
        reactPropsKey
      ]

      // 1. Cold entry onto rounded row -> snaps to 12px radius and x = 19 - 10 - 1 = 8px.
      handlers.onPointerOver({ pointerType: 'mouse', clientX: 50, clientY: 120, target: row })
      assert.equal(indicator.dataset.glideVisible, 'true')
      assert.equal(indicator.style.transform, 'translate3d(8px, 4px, 0)')
      assert.equal(indicator.style.width, '540px')
      assert.equal(indicator.style.borderRadius, '12px')

      // 2. Warm glide onto capsule pill button -> clamps 9999px to 16px for smooth morphing.
      handlers.onPointerOver({ pointerType: 'mouse', clientX: 50, clientY: 160, target: pill })
      assert.equal(indicator.dataset.glideVisible, 'true')
      assert.equal(indicator.dataset.glideMoving, 'true')
      assert.equal(indicator.style.width, '140px')
      assert.equal(indicator.style.borderRadius, '16px')

      // 3. Disabled target is ignored -> enters cooling (hidden).
      handlers.onPointerOver({
        pointerType: 'mouse',
        clientX: 200,
        clientY: 160,
        target: disabledBtn,
      })
      assert.equal(indicator.dataset.glideVisible, 'false')

      // 4. Muted target tracks invisibly, then flipping muted -> false reveals immediately via MutationObserver.
      handlers.onPointerOver({ pointerType: 'mouse', clientX: 300, clientY: 160, target: mutedBtn })
      assert.equal(indicator.dataset.glideVisible, 'false')
      await act(async () => {
        root.render(createElement(Demo, { muted: false }))
      })
      assert.equal(indicator.dataset.glideVisible, 'true')
      assert.equal(indicator.style.borderRadius, '16px')

      // 5. Ancestor scroll re-targets stationary pointer to row via elementFromPoint.
      hitTarget = row
      for (const listener of windowListeners.get('scroll') ?? []) {
        listener({ target: scroller })
      }
      while (rafQueue.length > 0) {
        rafQueue.shift()?.()
      }
      assert.equal(indicator.style.width, '540px')
      assert.equal(indicator.style.borderRadius, '12px')

      // 6. ResizeObserver re-targets stationary pointer to pill via elementFromPoint.
      hitTarget = pill
      observers.resize?.()
      assert.equal(indicator.style.width, '140px')
      assert.equal(indicator.style.borderRadius, '16px')
    } finally {
      await act(async () => {
        root.unmount()
      })
      for (const [key, entry] of saved) {
        if (entry.hadOwn) {
          globals[key] = entry.value
        } else {
          Reflect.deleteProperty(globals, key)
        }
      }
    }
  })
})
