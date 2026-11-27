import {
  shapeMinimapSection,
  type MinimapBlock,
  type MinimapDecoration,
  type MinimapMarker,
  type MinimapRun,
  type MinimapSectionShape,
  type Rgba,
} from './minimapGeometry.js'

/**
 * Reads a scrolling document into minimap sections and keeps them current.
 *
 * The content's direct children are split into sections at each child matching
 * `sectionSelector`. Each section is measured relative to its own top and cached; it is measured
 * again only when one of its children resizes or changes (a disclosure opening, text streaming
 * in), so a section below a change only moves. Text is read as it renders: each line's runs with
 * their computed colour, standard HTML blocks (paragraphs, list items, headings, tables, code,
 * quotes), code backgrounds, table rules and quote bars, and a `markerSelector` element that starts
 * a section. Text outside any container that clips it (a disclosure while it animates, a scroll
 * box) is left out, as it is on screen.
 */

export type MinimapDocument = {
  /** Total scrollable height. */
  readonly height: number
  /** Where each section starts, in content px, ascending. */
  readonly tops: readonly number[]
  readonly shapes: readonly MinimapSectionShape[]
}

export type MinimapReader = {
  /** The document as it is now; measures only what changed since the last read. */
  readonly read: () => MinimapDocument
  /** Forgets every measure (colours changed, say). */
  readonly invalidate: () => void
  readonly dispose: () => void
}

const BLOCKS = 'p,li,dt,dd,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,figcaption,summary'
const GROUPS = 'table,pre,blockquote'
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
const TRANSPARENT = new Set(['transparent', 'rgba(0, 0, 0, 0)'])

const pixel = typeof document === 'undefined' ? null : document.createElement('canvas')
const pixelContext = pixel?.getContext('2d', { willReadFrequently: true }) ?? null
const rgbaCache = new Map<string, Rgba>()

/** Any CSS colour (computed colours can come as lab() or oklch()) as sRGB, for blending. */
export const cssToRgba = (color: string): Rgba => {
  const cached = rgbaCache.get(color)
  if (cached) {
    return cached
  }
  let value: Rgba = [128, 128, 128, 1]
  if (pixelContext) {
    pixelContext.clearRect(0, 0, 1, 1)
    pixelContext.fillStyle = '#808080'
    pixelContext.fillStyle = color
    pixelContext.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0, a = 255] = pixelContext.getImageData(0, 0, 1, 1).data
    value = [r, g, b, a / 255]
  }
  rgbaCache.set(color, value)
  return value
}

type Frame = { readonly originY: number; readonly left: number; readonly width: number }

/** Measures one section's children, relative to `top` (content px). */
const measureSection = (
  children: readonly Element[],
  content: Element,
  top: number,
  height: number,
  frame: Frame,
  markerSelector: string
) => {
  const toY = (clientY: number) => clientY - frame.originY - top
  const toX = (clientX: number) => (clientX - frame.left) / frame.width
  const style = new Map<Element, CSSStyleDeclaration>()
  const styleOf = (el: Element) => {
    let value = style.get(el)
    if (!value) {
      value = getComputedStyle(el)
      style.set(el, value)
    }
    return value
  }
  // The visible band of an element: inside every ancestor (up to the content) that clips.
  const bands = new Map<Element, readonly [number, number]>()
  const bandOf = (el: Element): readonly [number, number] => {
    const known = bands.get(el)
    if (known) {
      return known
    }
    const parent = el.parentElement
    let band: readonly [number, number] =
      !parent || parent === content ? [-Infinity, Infinity] : bandOf(parent)
    if (el !== content && styleOf(el).overflowY !== 'visible') {
      const rect = el.getBoundingClientRect()
      band = [Math.max(band[0], rect.top), Math.min(band[1], rect.bottom)]
    }
    bands.set(el, band)
    return band
  }

  type Line = {
    block: Element
    kind: MinimapRun['kind']
    color: string
    x0: number
    x1: number
    top: number
    h: number
  }
  const lines = new Map<string, Line>()
  const markerLines = new Map<Element, Line[]>()
  const ids = new Map<Element, number>()
  const range = document.createRange()
  let token = 0

  for (const child of children) {
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || !node.textContent?.trim() || parent.closest('[aria-hidden="true"]')) {
        continue
      }
      const marker = parent.closest(markerSelector)
      const block = marker ?? parent.closest(BLOCKS) ?? parent
      const kind: MinimapRun['kind'] = block.closest('pre')
        ? 'code'
        : HEADINGS.has(block.tagName)
          ? 'heading'
          : 'text'
      const color = styleOf(parent).color
      const [visibleTop, visibleBottom] = bandOf(parent)
      if (!ids.has(block)) {
        ids.set(block, ids.size)
      }
      token += 1
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) {
          continue
        }
        // Only text wholly inside what clips it shows, as lines appear when they're revealed.
        if (rect.top < visibleTop - 0.5 || rect.bottom > visibleBottom + 0.5) {
          continue
        }
        // A line merges into one run per colour; code keeps each token, so syntax colours show.
        const row = Math.round(rect.top / 4)
        const key =
          kind === 'code'
            ? `${ids.get(block)}:${row}:${token}`
            : `${ids.get(block)}:${row}:${color}`
        const line = lines.get(key)
        if (line) {
          line.x0 = Math.min(line.x0, rect.left)
          line.x1 = Math.max(line.x1, rect.right)
          line.h = Math.max(line.h, rect.height)
          continue
        }
        const fresh = {
          block,
          kind,
          color,
          x0: rect.left,
          x1: rect.right,
          top: rect.top,
          h: rect.height,
        }
        lines.set(key, fresh)
        if (marker) {
          const list = markerLines.get(marker) ?? []
          list.push(fresh)
          markerLines.set(marker, list)
        }
      }
    }
  }

  // Blocks: the union of their lines, a table, code block or quote counting as one.
  const groups = new Map<Element, { x0: number; x1: number; top: number; bottom: number }>()
  const runsInBlocks: { line: Line; group: Element }[] = []
  for (const line of lines.values()) {
    if (line.block.matches(markerSelector)) {
      continue
    }
    const group = line.block.closest(GROUPS) ?? line.block
    runsInBlocks.push({ line, group })
    const box = groups.get(group)
    if (box) {
      box.x0 = Math.min(box.x0, line.x0)
      box.x1 = Math.max(box.x1, line.x1)
      box.top = Math.min(box.top, line.top)
      box.bottom = Math.max(box.bottom, line.top + line.h)
    } else {
      groups.set(group, { x0: line.x0, x1: line.x1, top: line.top, bottom: line.top + line.h })
    }
  }
  const blockIndex = new Map([...groups.keys()].map((group, i) => [group, i]))
  const blocks: MinimapBlock[] = [...groups.values()].map((box) => ({
    x: toX(box.x0),
    w: (box.x1 - box.x0) / frame.width,
    y: toY(box.top),
    h: box.bottom - box.top,
  }))
  const runs: MinimapRun[] = runsInBlocks.map(({ line, group }) => ({
    block: blockIndex.get(group) ?? 0,
    kind: line.kind,
    color: line.color,
    x: toX(line.x0),
    w: (line.x1 - line.x0) / frame.width,
    y: toY(line.top),
    h: line.h,
  }))

  const decorations: MinimapDecoration[] = []
  const rectOf = (el: Element) => el.getBoundingClientRect()
  for (const child of children) {
    for (const pre of child.querySelectorAll('pre')) {
      // The code block's background is on the pre or the nearest wrapper that paints one.
      let painted: Element | null = pre
      while (painted && painted !== child && TRANSPARENT.has(styleOf(painted).backgroundColor)) {
        painted = painted.parentElement
      }
      if (painted && painted !== child) {
        const r = rectOf(painted)
        decorations.push({
          kind: 'fill',
          color: styleOf(painted).backgroundColor,
          x: toX(r.left),
          w: r.width / frame.width,
          y: toY(r.top),
          h: r.height,
        })
      }
    }
    for (const row of child.querySelectorAll('tr')) {
      const cell = row.querySelector('td,th') ?? row
      const cellStyle = styleOf(cell)
      if (Number.parseFloat(cellStyle.borderBottomWidth) > 0) {
        const r = rectOf(row)
        decorations.push({
          kind: 'rule',
          color: cellStyle.borderBottomColor,
          x: toX(r.left),
          w: r.width / frame.width,
          y: toY(r.bottom - 1),
          h: 1,
        })
      }
    }
    for (const quote of child.querySelectorAll('blockquote')) {
      const quoteStyle = styleOf(quote)
      const width = Number.parseFloat(quoteStyle.borderLeftWidth)
      if (width > 0) {
        const r = rectOf(quote)
        decorations.push({
          kind: 'bar',
          color: quoteStyle.borderLeftColor,
          x: toX(r.left),
          w: width / frame.width,
          y: toY(r.top),
          h: r.height,
        })
      }
    }
  }

  let marker: MinimapMarker | undefined
  for (const child of children) {
    const el = child.matches(markerSelector) ? child : child.querySelector(markerSelector)
    if (el) {
      const r = rectOf(el)
      marker = {
        x: toX(r.left),
        w: r.width / frame.width,
        y: toY(r.top),
        h: r.height,
        runs: (markerLines.get(el) ?? []).map((line) => ({
          color: line.color,
          x: toX(line.x0),
          w: (line.x1 - line.x0) / frame.width,
          y: toY(line.top),
          h: line.h,
        })),
      }
      break
    }
  }

  return { height, runs, blocks, decorations, marker }
}

/**
 * Starts reading `content` (the scrolled column inside `scroll`). `onChange` is called with
 * `'layout'` from a resize observer (layout is fresh: read and paint now, in step with the
 * content) and with `'content'` when the DOM changed (read on the next frame).
 */
export const createMinimapReader = ({
  scroll,
  content,
  sectionSelector,
  markerSelector,
  onChange,
}: {
  readonly scroll: HTMLElement
  readonly content: HTMLElement
  readonly sectionSelector: string
  readonly markerSelector: string
  readonly onChange: (kind: 'layout' | 'content') => void
}): MinimapReader => {
  type Cached = { readonly shape: MinimapSectionShape }
  let sections: { readonly anchor: Element; readonly children: Element[] }[] = []
  let sectionOf = new Map<Element, Element>()
  let structureDirty = true
  let width = -1
  const cache = new Map<Element, Cached>()
  const dirty = new Set<Element>()

  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === content) {
        if (entry.contentRect.width !== width) {
          width = entry.contentRect.width
          cache.clear()
        }
      } else {
        const anchor = sectionOf.get(entry.target)
        if (anchor) {
          dirty.add(anchor)
        }
      }
    }
    onChange('layout')
  })
  resize.observe(content)

  const restructure = () => {
    structureDirty = false
    for (const section of sections) {
      for (const child of section.children) {
        resize.unobserve(child)
      }
    }
    sections = []
    sectionOf = new Map()
    let current: { anchor: Element; children: Element[] } | null = null
    for (const child of content.children) {
      if (child.matches(sectionSelector)) {
        current = { anchor: child, children: [] }
        sections.push(current)
        sectionOf.set(child, child)
        continue
      }
      if (current) {
        current.children.push(child)
        sectionOf.set(child, current.anchor)
        resize.observe(child)
      }
    }
    for (const anchor of [...cache.keys()]) {
      if (!sectionOf.has(anchor)) {
        cache.delete(anchor)
      }
    }
  }

  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target === content && record.type === 'childList') {
        structureDirty = true
        continue
      }
      let node: Node | null = record.target
      while (node && node.parentNode !== content) {
        node = node.parentNode
      }
      const anchor = node instanceof Element ? sectionOf.get(node) : undefined
      if (anchor) {
        dirty.add(anchor)
      }
    }
    onChange('content')
  })
  // `data-phase` is how disclosures switch clipping on while they open or close.
  mutations.observe(content, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-phase', 'open'],
  })

  const read = (): MinimapDocument => {
    if (structureDirty) {
      restructure()
    }
    const scrollRect = scroll.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const frame: Frame = {
      originY: scrollRect.top - scroll.scrollTop,
      left: contentRect.left,
      width: Math.max(1, contentRect.width),
    }
    const tops = sections.map(
      (section) => section.anchor.getBoundingClientRect().top - frame.originY
    )
    const contentBottom = contentRect.bottom - frame.originY
    const shapes = sections.map((section, i) => {
      const top = tops[i] ?? 0
      const height = Math.max(1, (tops[i + 1] ?? contentBottom) - top)
      const cached = cache.get(section.anchor)
      if (cached && !dirty.has(section.anchor) && Math.abs(cached.shape.height - height) < 0.5) {
        return cached.shape
      }
      const measured = measureSection(section.children, content, top, height, frame, markerSelector)
      const shape = shapeMinimapSection(measured, cssToRgba)
      cache.set(section.anchor, { shape })
      return shape
    })
    dirty.clear()
    return { height: scroll.scrollHeight, tops, shapes }
  }

  return {
    read,
    invalidate: () => {
      cache.clear()
    },
    dispose: () => {
      resize.disconnect()
      mutations.disconnect()
      cache.clear()
    },
  }
}
