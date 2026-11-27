import { createScrollGlide, readingLineY } from '@deepseek-chat/lib-ui'
import styles from './MinimapStudy.module.css'

/**
 * Prototype only: draws a minimap rail over the real transcript's left gutter, measured from the
 * transcript's own layout, so the design options can be judged on the actual app. It hides the
 * shipped chapter rail while mounted and restores it on dispose.
 *
 * - `text`: a scaled copy of the transcript. Every text line is a stroke at its real position and
 *   length; prompt bubbles, code blocks, tables and quotes keep their shapes.
 * - `stems`: today's ticks, plus a stem down each turn for the turn's real length.
 */
export type MinimapStyle = 'text' | 'stems'

const SVG = 'http://www.w3.org/2000/svg'
const PAD = 24
const MAX_SCALE = 0.1
const TEXT_MAX_WIDTH = 44

export type Seg = {
  readonly turn: number
  readonly kind: 'text' | 'heading' | 'bubble' | 'code'
  /** Index into `blocks` of the paragraph, table, code block or quote this line belongs to; -1 in a prompt. */
  readonly block: number
  /** The text's computed colour in the transcript. */
  readonly color: string
  readonly x: number
  readonly w: number
  readonly y: number
  readonly h: number
}

export type Box = {
  readonly turn: number
  readonly kind: 'bubble' | 'code' | 'table' | 'quote' | 'rule'
  /** The element's computed colour in the transcript: background for prompts and code blocks, the
   * border for quotes and table rules. */
  readonly color: string
  readonly x: number
  readonly w: number
  readonly y: number
  readonly h: number
}

/** A paragraph, list item, heading, table, code block or quote: the union of its lines. */
export type Block = {
  readonly turn: number
  readonly kind: Seg['kind']
  readonly x: number
  readonly w: number
  readonly y: number
  readonly h: number
}

export type Measure = {
  readonly anchors: readonly number[]
  readonly excerpts: readonly string[]
  readonly segs: readonly Seg[]
  readonly boxes: readonly Box[]
  readonly blocks: readonly Block[]
  readonly height: number
  /** The element each entry above was measured from, so positions can be tracked between
   * measures: a line's paragraph (or prompt bubble), a block's element, a box, a turn anchor. */
  readonly els: {
    readonly segs: readonly Element[]
    readonly blocks: readonly Element[]
    readonly boxes: readonly Element[]
    readonly anchors: readonly Element[]
  }
}

const BLOCKS = 'p,li,td,th,h1,h2,h3,h4,pre,blockquote,[data-turn-bubble]'

const el = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element
) => {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value))
  }
  parent?.appendChild(node)
  return node
}

export const measure = (scroll: HTMLElement, column: HTMLElement): Measure => {
  const scrollRect = scroll.getBoundingClientRect()
  const colRect = column.getBoundingClientRect()
  const toY = (top: number) => top - scrollRect.top + scroll.scrollTop
  const toX = (left: number) => (left - colRect.left) / colRect.width
  const anchorEls = [...column.querySelectorAll<HTMLElement>('[data-turn-anchor]')]
  const anchors = anchorEls.map((a) => toY(a.getBoundingClientRect().top))
  const turnOf = (y: number) => {
    let turn = 0
    anchors.forEach((top, i) => {
      if (top <= y + 1) {
        turn = i
      }
    })
    return turn
  }

  const bubbles = [...column.querySelectorAll<HTMLElement>('[data-turn-bubble]')]
  const excerpts = anchors.map((top, i) => {
    const bubble = bubbles.find((b) => turnOf(toY(b.getBoundingClientRect().top)) === i)
    const text = (bubble?.textContent ?? '').trim().replace(/\s+/g, ' ')
    return text.length > 56 ? `${text.slice(0, 55)}…` : text || `Turn ${top}`
  })

  const lines = new Map<
    string,
    {
      block: Element
      kind: Seg['kind']
      color: string
      x0: number
      x1: number
      top: number
      h: number
    }
  >()
  const colors = new Map<Element, string>()
  const colorOf = (el: Element) => {
    let color = colors.get(el)
    if (!color) {
      color = getComputedStyle(el).color
      colors.set(el, color)
    }
    return color
  }
  let run = 0
  const ids = new Map<Element, number>()
  const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || !node.textContent?.trim() || parent.closest('[aria-hidden="true"]')) {
      continue
    }
    const block = parent.closest(BLOCKS) ?? parent
    const kind: Seg['kind'] = block.closest('[data-turn-bubble]')
      ? 'bubble'
      : block.closest('pre')
        ? 'code'
        : /^H[1-4]$/.test(block.tagName)
          ? 'heading'
          : 'text'
    if (!ids.has(block)) {
      ids.set(block, ids.size)
    }
    const color = colorOf(parent)
    run += 1
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      if (rect.width < 0.5 || rect.height < 0.5) {
        continue
      }
      // A line merges into one stroke per colour; code keeps each token, so syntax colours show.
      const key =
        kind === 'code'
          ? `${ids.get(block)}:${Math.round(rect.top / 4)}:${run}`
          : `${ids.get(block)}:${Math.round(rect.top / 4)}:${color}`
      const line = lines.get(key)
      if (line) {
        line.x0 = Math.min(line.x0, rect.left)
        line.x1 = Math.max(line.x1, rect.right)
        line.h = Math.max(line.h, rect.height)
      } else {
        lines.set(key, {
          block,
          kind,
          color,
          x0: rect.left,
          x1: rect.right,
          top: rect.top,
          h: rect.height,
        })
      }
    }
  }
  const boxes: Box[] = []
  const boxEls: Element[] = []
  const addBoxes = (
    selector: string,
    kind: Box['kind'],
    colorOfBox: (el: Element) => string,
    target: (el: Element) => Element = (el) => el,
    edge: 'box' | 'bottom' = 'box'
  ) => {
    for (const found of column.querySelectorAll(selector)) {
      const node = target(found)
      const rect = node.getBoundingClientRect()
      if (rect.height > 0) {
        const y = toY(edge === 'bottom' ? rect.bottom - 1 : rect.top)
        boxEls.push(node)
        boxes.push({
          turn: turnOf(y),
          kind,
          color: colorOfBox(node),
          x: toX(rect.left),
          w: rect.width / colRect.width,
          y,
          h: edge === 'bottom' ? 1 : rect.height,
        })
      }
    }
  }
  const style = (el: Element) => getComputedStyle(el)
  addBoxes('[data-turn-bubble]', 'bubble', (el) => style(el).backgroundColor)
  addBoxes(
    'pre',
    'code',
    (el) => style(el).backgroundColor,
    (pre) => pre.closest('[class*="code-block"]') ?? pre
  )
  addBoxes('table', 'table', (el) => style(el.querySelector('td') ?? el).borderBottomColor)
  addBoxes(
    'tr',
    'rule',
    (el) => style(el.querySelector('td,th') ?? el).borderBottomColor,
    undefined,
    'bottom'
  )
  addBoxes('blockquote', 'quote', (el) => style(el).borderLeftColor)

  const grouped = new Map<
    Element,
    { kind: Seg['kind']; x0: number; x1: number; top: number; bottom: number }
  >()
  for (const line of lines.values()) {
    if (line.kind === 'bubble') {
      continue
    }
    const key = line.block.closest('table,pre,blockquote') ?? line.block
    const block = grouped.get(key)
    if (block) {
      block.x0 = Math.min(block.x0, line.x0)
      block.x1 = Math.max(block.x1, line.x1)
      block.top = Math.min(block.top, line.top)
      block.bottom = Math.max(block.bottom, line.top + line.h)
    } else {
      grouped.set(key, {
        kind: line.kind,
        x0: line.x0,
        x1: line.x1,
        top: line.top,
        bottom: line.top + line.h,
      })
    }
  }
  const blocks = [...grouped.values()].map((block) => {
    const y = toY(block.top)
    return {
      turn: turnOf(y),
      kind: block.kind,
      x: toX(block.x0),
      w: (block.x1 - block.x0) / colRect.width,
      y,
      h: block.bottom - block.top,
    }
  })

  const blockIndex = new Map([...grouped.keys()].map((key, i) => [key, i]))
  const segs = [...lines.values()].map((line) => {
    const y = toY(line.top)
    return {
      turn: turnOf(y),
      kind: line.kind,
      color: line.color,
      block:
        line.kind === 'bubble'
          ? -1
          : (blockIndex.get(line.block.closest('table,pre,blockquote') ?? line.block) ?? -1),
      x: toX(line.x0),
      w: (line.x1 - line.x0) / colRect.width,
      y,
      h: line.h,
    }
  })

  return {
    anchors,
    excerpts,
    segs,
    boxes,
    blocks,
    height: scroll.scrollHeight,
    els: {
      segs: [...lines.values()].map((line) => line.block),
      blocks: [...grouped.keys()],
      boxes: boxEls,
      anchors: anchorEls,
    },
  }
}

export const mountMinimapRail = (
  area: HTMLElement,
  scroll: HTMLElement,
  column: HTMLElement,
  style: MinimapStyle
) => {
  const hidden = [...area.children].filter((child) => child !== scroll) as HTMLElement[]
  for (const child of hidden) {
    child.style.visibility = 'hidden'
  }

  const host = document.createElement('div')
  host.className = styles.minimapHost
  host.dataset.style = style
  const svg = el('svg', { class: styles.minimap, 'aria-hidden': 'true' }, host)
  const peek = document.createElement('div')
  peek.className = styles.peek
  host.appendChild(peek)
  area.appendChild(host)

  const glide = createScrollGlide(scroll)
  let m: Measure | null = null
  let geo = { sy: 0, top: 0, x: 0, w: 0, visible: false }
  let groups: SVGGElement[] = []
  let windowRect: SVGRectElement | null = null
  let hovered = -1

  const toMap = (y: number) => geo.top + y * geo.sy

  const draw = () => {
    m = measure(scroll, column)
    const gutter = column.getBoundingClientRect().left - area.getBoundingClientRect().left
    const avail = area.clientHeight - PAD * 2
    const sy = Math.min(MAX_SCALE, avail / Math.max(1, m.height))
    const w = style === 'text' ? Math.min(TEXT_MAX_WIDTH, gutter - 20) : 20
    const x =
      style === 'text'
        ? Math.max(8, Math.min(16, (gutter - w) / 2))
        : Math.max(4, Math.min(16, gutter / 2 - 16)) + 6
    geo = {
      sy,
      top: PAD + (avail - m.height * sy) / 2,
      x,
      w,
      visible: gutter >= 48 && (style === 'stems' || w >= 24),
    }
    host.style.width = `${Math.max(0, gutter)}px`
    host.hidden = !geo.visible
    svg.replaceChildren()

    el(
      'rect',
      { class: styles.hit, x: 0, y: 0, width: Math.max(0, gutter), height: area.clientHeight },
      svg
    )
    windowRect = el(
      'rect',
      { class: style === 'text' ? styles.windowText : styles.windowStems },
      svg
    )
    if (style === 'text') {
      windowRect.setAttribute('x', String(x - 4))
      windowRect.setAttribute('width', String(w + 8))
      windowRect.setAttribute('rx', '4')
    } else {
      windowRect.setAttribute('x', String(x - 7))
      windowRect.setAttribute('width', '2')
      windowRect.setAttribute('rx', '1')
    }

    groups = m.anchors.map((_, i) => el('g', { 'data-turn': i, class: styles.turn }, svg))
    if (style === 'text') {
      for (const box of m.boxes) {
        if (box.kind === 'rule') {
          continue
        }
        const by = toMap(box.y)
        const bh = Math.max(2, box.h * sy)
        const bw = Math.max(2, box.w * w)
        const radius = box.kind === 'bubble' ? Math.min(3, bh / 2) : 1.5
        el(
          'rect',
          {
            class: styles[`box_${box.kind}`] ?? '',
            x: x + box.x * w - (box.kind === 'bubble' ? 1 : 0),
            y: by,
            width: box.kind === 'quote' ? 1.5 : bw + (box.kind === 'bubble' ? 2 : 0),
            height: bh,
            rx: box.kind === 'quote' ? 0.75 : radius,
          },
          groups[box.turn]
        )
      }
      for (const seg of m.segs) {
        const stroke = Math.max(1, Math.min(seg.kind === 'heading' ? 2.4 : 1.6, seg.h * sy * 0.6))
        el(
          'rect',
          {
            class: styles[`line_${seg.kind}`] ?? '',
            x: x + seg.x * w,
            y: toMap(seg.y + seg.h / 2) - stroke / 2,
            width: Math.max(1, seg.w * w),
            height: stroke,
            rx: stroke / 2,
          },
          groups[seg.turn]
        )
      }
    } else {
      const { anchors, height } = m
      anchors.forEach((top, i) => {
        const y = toMap(top)
        const end = toMap(anchors[i + 1] ?? height)
        el('rect', { class: styles.tick, x, y: y - 1, width: 20, height: 2, rx: 1 }, groups[i])
        if (end - y > 9) {
          el(
            'rect',
            { class: styles.stem, x, y: y + 4, width: 2, height: end - y - 8, rx: 1 },
            groups[i]
          )
        }
      })
    }
    update()
  }

  const turnAt = (y: number) => {
    if (!m) {
      return 0
    }
    let turn = 0
    m.anchors.forEach((top, i) => {
      if (top <= y + 1) {
        turn = i
      }
    })
    return turn
  }

  const update = () => {
    if (!m || !windowRect) {
      return
    }
    const { anchors, height } = m
    const { scrollTop, clientHeight, scrollHeight } = scroll
    windowRect.setAttribute('y', String(toMap(scrollTop)))
    windowRect.setAttribute('height', String(Math.max(4, clientHeight * geo.sy)))
    const next = turnAt(readingLineY(scrollTop, clientHeight, scrollHeight))
    groups.forEach((g, i) => {
      const start = anchors[i] ?? 0
      const end = anchors[i + 1] ?? height
      g.toggleAttribute('data-in-view', end > scrollTop && start < scrollTop + clientHeight)
      g.toggleAttribute('data-current', i === next)
    })
  }

  let frame = 0
  const onScroll = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(update)
  }
  scroll.addEventListener('scroll', onScroll, { passive: true })

  let redraw = 0
  const scheduleDraw = () => {
    clearTimeout(redraw)
    redraw = window.setTimeout(draw, 60)
  }
  const resize = new ResizeObserver(scheduleDraw)
  resize.observe(column)
  resize.observe(area)
  const mutations = new MutationObserver(scheduleDraw)
  mutations.observe(column, { childList: true, subtree: true, characterData: true })

  const localY = (event: PointerEvent) => event.clientY - area.getBoundingClientRect().top
  const contentY = (event: PointerEvent) => (localY(event) - geo.top) / geo.sy

  const setHover = (turn: number, event: PointerEvent | null) => {
    if (turn !== hovered) {
      groups[hovered]?.removeAttribute('data-hover')
      groups[turn]?.setAttribute('data-hover', '')
      hovered = turn
    }
    if (turn < 0 || !m || !event) {
      peek.removeAttribute('data-open')
      return
    }
    peek.innerHTML = ''
    const number = document.createElement('span')
    number.className = styles.peekNumber
    number.textContent = String(turn + 1)
    const label = document.createElement('span')
    label.textContent = m.excerpts[turn] ?? ''
    peek.append(number, label)
    peek.style.left = `${geo.x + geo.w + 14}px`
    peek.style.top = `${localY(event)}px`
    peek.setAttribute('data-open', '')
  }

  let drag: { y: number; top: number; moved: boolean } | null = null
  const onDown = (event: PointerEvent) => {
    if (!m || event.button !== 0) {
      return
    }
    event.preventDefault()
    const y = contentY(event)
    setHover(turnAt(y), event)
    const { scrollTop, clientHeight } = scroll
    const onWindow = y >= scrollTop - 8 && y <= scrollTop + clientHeight + 8
    let top = scrollTop
    if (!onWindow) {
      top = Math.max(0, Math.min(scroll.scrollHeight - clientHeight, y - clientHeight / 2))
      glide.to(top, { fade: column })
    }
    drag = { y: event.clientY, top, moved: false }
    host.setAttribute('data-dragging', '')
    try {
      svg.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers cannot be captured; the drag still follows moves over the rail.
    }
  }
  const onMove = (event: PointerEvent) => {
    if (drag) {
      const dy = event.clientY - drag.y
      if (!drag.moved && Math.abs(dy) < 3) {
        return
      }
      if (!drag.moved) {
        glide.cancel()
        drag.moved = true
      }
      scroll.scrollTop = drag.top + dy / geo.sy
      setHover(turnAt(contentY(event)), event)
      return
    }
    const y = contentY(event)
    setHover(m && y >= 0 && y <= m.height ? turnAt(y) : -1, event)
  }
  const onUp = () => {
    drag = null
    host.removeAttribute('data-dragging')
  }
  const onLeave = () => {
    if (!drag) {
      setHover(-1, null)
    }
  }
  svg.addEventListener('pointerdown', onDown)
  svg.addEventListener('pointermove', onMove)
  svg.addEventListener('pointerup', onUp)
  svg.addEventListener('pointercancel', onUp)
  svg.addEventListener('pointerleave', onLeave)

  draw()

  return () => {
    clearTimeout(redraw)
    cancelAnimationFrame(frame)
    glide.cancel()
    resize.disconnect()
    mutations.disconnect()
    scroll.removeEventListener('scroll', onScroll)
    host.remove()
    for (const child of hidden) {
      child.style.visibility = ''
    }
  }
}
