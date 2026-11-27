import { createScrollGlide, readingLineY } from '@deepseek-chat/lib-ui'
import { measure, type Block, type Box, type Measure, type Seg } from './minimapRail.js'
import styles from './MinimapStudy.module.css'

/**
 * Prototype only: a minimap rail that stays readable as the chat grows.
 *
 * Two ideas work together:
 *
 * 1. Level of detail follows scale. The rail draws each part of the transcript at the detail its
 *    scale can carry: text lines while a line still gets about 2px of rail, then one bar per
 *    paragraph, table or code block, then one slab per answer. Each part fades between levels,
 *    so the rail never shows lines too dense to read.
 * 2. Optionally, a lens around the reading position. Without it the whole chat shares the rail at
 *    one scale and only the window moves. With it, once the chat no longer fits at full detail,
 *    the viewport and about a viewport on either side keep full detail and detail eases off over
 *    the next three viewports. The lens holds still for small scrolls and follows larger ones on
 *    a spring, so the map doesn't flow under every scroll tick.
 */

const PAD = 24
const BIN = 4
const MAX_WIDTH = 44
/** Rail px per transcript px at full detail, and inside the lens. */
const NEAR = 0.1
/** Transcript kept at full detail on each side of the lens's centre, in viewports. */
const LENS_CORE = 1
/** Distance over which detail eases from the lens to the rest of the chat, in viewports. */
const LENS_FALLOFF = 3
/** The most of the rail the lens may take, so the rest of the chat keeps some room. */
const LENS_MAX_SHARE = 0.6
/** How far the reading position moves, in viewports, before the lens follows it. */
const LENS_SLACK = 0.5
/** Spring the lens follows with (critically damped; settles in about half a second). */
const LENS_STIFFNESS = 90
const LINE_HEIGHT = 22

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
/** Text lines show while a line gets at least ~1.3px of rail, fully from 2px. */
const lineAlpha = (scale: number) => smooth(1.3, 2, scale * LINE_HEIGHT)
/** Paragraph bars show while the gaps between paragraphs stay visible. */
const blockAlpha = (scale: number) => smooth(0.014, 0.03, scale)

type MapLayout = {
  readonly top: (y: number) => number
  readonly scaleAt: (y: number) => number
  readonly toContent: (railY: number) => number
}

const layoutMap = (
  height: number,
  viewport: number,
  centre: number | null,
  railTop: number,
  railHeight: number
): MapLayout => {
  const uniform = (scale: number): MapLayout => {
    const top0 = railTop + Math.max(0, (railHeight - height * scale) / 2)
    return {
      top: (y) => top0 + y * scale,
      scaleAt: () => scale,
      toContent: (railY) => (railY - top0) / scale,
    }
  }
  if (centre === null || railHeight / height >= NEAR) {
    return uniform(Math.min(NEAR, railHeight / height))
  }

  const core = viewport * LENS_CORE
  const falloff = viewport * LENS_FALLOFF
  const bins = Math.ceil(height / BIN)
  const weight = new Float32Array(bins)
  let weightSum = 0
  for (let i = 0; i < bins; i += 1) {
    const w = 1 - smooth(core, core + falloff, Math.abs((i + 0.5) * BIN - centre))
    weight[i] = w
    weightSum += w
  }
  const lensSpan = weightSum * BIN
  const near = Math.min(NEAR, (LENS_MAX_SHARE * railHeight) / lensSpan)
  const far = (railHeight - near * lensSpan) / Math.max(1, height - lensSpan)
  if (far >= near) {
    return uniform(railHeight / height)
  }

  const cum = new Float32Array(bins + 1)
  cum[0] = railTop
  for (let i = 0; i < bins; i += 1) {
    cum[i + 1] = (cum[i] ?? 0) + BIN * (far + (near - far) * (weight[i] ?? 0))
  }
  const fit = railHeight / ((cum[bins] ?? railTop + 1) - railTop)
  for (let i = 1; i <= bins; i += 1) {
    cum[i] = railTop + ((cum[i] ?? 0) - railTop) * fit
  }
  const top = (y: number) => {
    const f = clamp(y / BIN, 0, bins)
    const i = Math.min(bins - 1, Math.floor(f))
    const a = cum[i] ?? 0
    return a + ((cum[i + 1] ?? a) - a) * (f - i)
  }
  return {
    top,
    scaleAt: (y) =>
      (far + (near - far) * (weight[clamp(Math.floor(y / BIN), 0, bins - 1)] ?? 0)) * fit,
    toContent: (railY) => {
      let lo = 0
      let hi = bins
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if ((cum[mid + 1] ?? Infinity) < railY) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      const a = cum[lo] ?? 0
      const b = cum[lo + 1] ?? a + 1
      return (lo + clamp((railY - a) / Math.max(1e-6, b - a), 0, 1)) * BIN
    },
  }
}

const TOKENS = [
  'text-disabled',
  'text-muted',
  'text-secondary',
  'text-primary',
  'border-subtle',
  'border-default',
  'border-strong',
  'interactive-hover',
  'interactive-active',
] as const
type Rgba = readonly [number, number, number, number]
type Palette = Record<(typeof TOKENS)[number], Rgba>

const pixel = typeof document === 'undefined' ? null : document.createElement('canvas')
const pixelCtx = pixel?.getContext('2d', { willReadFrequently: true }) ?? null
const rgbaCache = new Map<string, Rgba>()
/** Any CSS colour (the transcript's computed colours come as lab()) as sRGB, for blending. */
const toRgba = (color: string): Rgba => {
  const cached = rgbaCache.get(color)
  if (cached) {
    return cached
  }
  let value: Rgba = [128, 128, 128, 1]
  if (pixelCtx) {
    pixelCtx.clearRect(0, 0, 1, 1)
    pixelCtx.fillStyle = '#808080'
    pixelCtx.fillStyle = color
    pixelCtx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0, a = 255] = pixelCtx.getImageData(0, 0, 1, 1).data
    value = [r, g, b, a / 255]
  }
  rgbaCache.set(color, value)
  return value
}

/** Resolves each token to sRGB so colours can be blended frame by frame. */
const resolvePalette = (host: HTMLElement): Palette => {
  const probe = document.createElement('span')
  host.appendChild(probe)
  const pixel = document.createElement('canvas')
  pixel.width = 1
  pixel.height = 1
  const pctx = pixel.getContext('2d', { willReadFrequently: true })
  const palette = {} as Record<(typeof TOKENS)[number], Rgba>
  for (const token of TOKENS) {
    probe.style.color = `var(--ui-${token})`
    const css = getComputedStyle(probe).color
    if (!pctx) {
      palette[token] = [128, 128, 128, 1]
      continue
    }
    pctx.clearRect(0, 0, 1, 1)
    pctx.fillStyle = css
    pctx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0, a = 255] = pctx.getImageData(0, 0, 1, 1).data
    palette[token] = [r, g, b, a / 255]
  }
  probe.remove()
  return palette
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** A token colour at an opacity, as an RGBA tuple that can be blended. */
const tint = (c: Rgba, alpha: number): Rgba => [c[0], c[1], c[2], c[3] * alpha]
const blend = (a: Rgba, b: Rgba, t: number): Rgba => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
  lerp(a[3], b[3], t),
]
const css = (c: Rgba, alpha = 1) =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3] * alpha})`

type Rect = { x: number; w: number; y0: number; y1: number }
const mixRect = (a: Rect, b: Rect, t: number): Rect =>
  t <= 0
    ? a
    : t >= 1
      ? b
      : {
          x: lerp(a.x, b.x, t),
          w: lerp(a.w, b.w, t),
          y0: lerp(a.y0, b.y0, t),
          y1: lerp(a.y1, b.y1, t),
        }

/**
 * One text line, with where it goes at each level of detail: its own stroke, its tile of the
 * paragraph bar (from its top to the next line's), and its tile of the answer slab. Drawing a
 * blend of the three is what lets a paragraph's lines thicken into its bar, and bars stretch into
 * the slab, as one shape instead of two drawings fading over each other.
 */
type LineShape = {
  readonly seg: Seg
  /** Several cells on one table row share a tile; only the first grows into it. */
  readonly leads: boolean
  readonly tileBottom: number
  readonly slabTop: number
  readonly slabBottom: number
}
type BlockShape = {
  readonly block: Block
  /** Its lines' colours, averaged by length: what the bar is drawn in. */
  readonly color: Rgba
  readonly lines: readonly LineShape[]
  readonly slabTop: number
  readonly slabBottom: number
}
type TurnShape = {
  /** Its paragraphs' colours, averaged by size: what the slab is drawn in. */
  readonly color: Rgba
  readonly blocks: readonly BlockShape[]
  readonly answerStart: number
  readonly answerEnd: number
  readonly bubble: Box | undefined
  readonly bubbleLines: readonly Seg[]
}

const average = (parts: readonly { color: Rgba; weight: number }[]): Rgba => {
  const sum = [0, 0, 0, 0]
  let total = 0
  for (const { color, weight } of parts) {
    color.forEach((v, i) => (sum[i] = (sum[i] ?? 0) + v * weight))
    total += weight
  }
  return total > 0
    ? [(sum[0] ?? 0) / total, (sum[1] ?? 0) / total, (sum[2] ?? 0) / total, (sum[3] ?? 0) / total]
    : [128, 128, 128, 1]
}

const shapeTurns = (m: Measure): TurnShape[] => {
  const linesByBlock = m.blocks.map((): Seg[] => [])
  const bubbleLines = m.anchors.map((): Seg[] => [])
  for (const seg of m.segs) {
    if (seg.block >= 0) {
      linesByBlock[seg.block]?.push(seg)
    } else {
      bubbleLines[seg.turn]?.push(seg)
    }
  }
  const blocksByTurn = m.anchors.map((): number[] => [])
  m.blocks.forEach((block, i) => blocksByTurn[block.turn]?.push(i))

  return m.anchors.map((anchor, turn) => {
    const bubble = m.boxes.find((b) => b.kind === 'bubble' && b.turn === turn)
    const answerStart = bubble ? bubble.y + bubble.h + 12 : anchor
    const answerEnd = Math.max(answerStart + 1, (m.anchors[turn + 1] ?? m.height) - 6)
    const order = (blocksByTurn[turn] ?? []).sort(
      (a, b) => (m.blocks[a]?.y ?? 0) - (m.blocks[b]?.y ?? 0)
    )
    let cursor = answerStart
    const blocks = order.map((index, k): BlockShape => {
      const block = m.blocks[index] as Block
      const next = m.blocks[order[k + 1] ?? -1]
      const slabTop = Math.min(cursor, block.y)
      const slabBottom = next
        ? Math.max(block.y + block.h, next.y)
        : Math.max(answerEnd, block.y + block.h)
      cursor = slabBottom
      const segs = (linesByBlock[index] ?? []).slice().sort((a, b) => a.y - b.y || a.x - b.x)
      const rows: Seg[][] = []
      for (const seg of segs) {
        const row = rows.at(-1)
        if (row && Math.abs((row[0]?.y ?? 0) - seg.y) < 3) {
          row.push(seg)
        } else {
          rows.push([seg])
        }
      }
      const lines = rows.flatMap((row, r) => {
        const y = row[0]?.y ?? block.y
        const nextY = rows[r + 1]?.[0]?.y
        const tileBottom = nextY ?? block.y + block.h
        return row.map(
          (seg, c): LineShape => ({
            seg,
            leads: c === 0,
            tileBottom,
            slabTop: r === 0 ? slabTop : y,
            slabBottom: nextY ?? slabBottom,
          })
        )
      })
      const color = average(segs.map((seg) => ({ color: toRgba(seg.color), weight: seg.w })))
      return { block, color, lines, slabTop, slabBottom }
    })
    const color = average(blocks.map((b) => ({ color: b.color, weight: b.block.w * b.block.h })))
    return {
      color,
      blocks,
      answerStart,
      answerEnd,
      bubble,
      bubbleLines: bubbleLines[turn] ?? [],
    }
  })
}

/**
 * Every element a measure read, where it was, and the container that can clip it (one whose
 * overflow is hidden, like a disclosure animating its height).
 */
type Tracker = {
  readonly els: readonly Element[]
  readonly base: Float64Array
  /** Every ancestor that can clip it, nearest first; the visible part is inside all of them. */
  readonly clips: readonly (readonly Element[])[]
  readonly segs: Int32Array
  readonly blocks: Int32Array
  readonly boxes: Int32Array
  readonly anchors: Int32Array
}

const trackElements = (m: Measure, scroll: HTMLElement, column: HTMLElement): Tracker => {
  const index = new Map<Element, number>()
  const els: Element[] = []
  const slot = (el: Element) => {
    let i = index.get(el)
    if (i === undefined) {
      i = els.length
      index.set(el, i)
      els.push(el)
    }
    return i
  }
  const segs = Int32Array.from(m.els.segs, slot)
  const blocks = Int32Array.from(m.els.blocks, slot)
  const boxes = Int32Array.from(m.els.boxes, slot)
  const anchors = Int32Array.from(m.els.anchors, slot)
  const scrollTop = scroll.getBoundingClientRect().top - scroll.scrollTop
  const base = Float64Array.from(els, (el) => el.getBoundingClientRect().top - scrollTop)
  const clipping = new Map<Element, boolean>()
  const clips = els.map((el) => {
    const found: Element[] = []
    for (let node = el.parentElement; node && node !== column; node = node.parentElement) {
      // A disclosure clipping while it opens or closes, or a scroll box like the reasoning panel.
      let clips = clipping.get(node)
      if (clips === undefined) {
        clips = getComputedStyle(node).overflowY !== 'visible'
        clipping.set(node, clips)
      }
      if (clips) {
        found.push(node)
      }
    }
    return found
  })
  return { els, base, clips, segs, blocks, boxes, anchors }
}

/** The measure with every entry moved by as much as its element has moved, clipped to its container. */
const moveToElements = (m: Measure, t: Tracker, scroll: HTMLElement): Measure => {
  const origin = scroll.getBoundingClientRect().top - scroll.scrollTop
  const shift = new Float64Array(t.els.length)
  const clipTop = new Float64Array(t.els.length)
  const clipBottom = new Float64Array(t.els.length)
  const clipRects = new Map<Element, readonly [number, number]>()
  t.els.forEach((el, i) => {
    shift[i] = el.isConnected ? el.getBoundingClientRect().top - origin - (t.base[i] ?? 0) : 0
    let top = -Infinity
    let bottom = Infinity
    for (const clip of t.clips[i] ?? []) {
      let edges = clipRects.get(clip)
      if (!edges) {
        const rect = clip.getBoundingClientRect()
        edges = [rect.top - origin, rect.bottom - origin]
        clipRects.set(clip, edges)
      }
      top = Math.max(top, edges[0])
      bottom = Math.min(bottom, edges[1])
    }
    clipTop[i] = el.isConnected ? top : Infinity
    clipBottom[i] = el.isConnected ? bottom : -Infinity
  })
  const moved = <T extends { y: number; h: number }>(entry: T, i: number): T => {
    const y = entry.y + (shift[i] ?? 0)
    const top = Math.max(y, clipTop[i] ?? -Infinity)
    const bottom = Math.min(y + entry.h, clipBottom[i] ?? Infinity)
    return { ...entry, y: top, h: Math.max(0, bottom - top) }
  }
  return {
    ...m,
    anchors: m.anchors.map((y, k) => y + (shift[t.anchors[k] ?? 0] ?? 0)),
    // A line is shown once its whole height is inside its container, as text is revealed.
    segs: m.segs
      .map((seg, k) => {
        const next = moved(seg, t.segs[k] ?? 0)
        return next.h >= seg.h - 0.5 ? next : null
      })
      .filter((seg): seg is Seg => seg !== null),
    blocks: m.blocks.map((block, k) => moved(block, t.blocks[k] ?? 0)),
    boxes: m.boxes.map((box, k) => moved(box, t.boxes[k] ?? 0)),
    height: scroll.scrollHeight,
  }
}

export const mountAdaptiveMinimap = (
  area: HTMLElement,
  scroll: HTMLElement,
  column: HTMLElement,
  options: { readonly lens: boolean }
) => {
  const hidden = [...area.children].filter((child) => child !== scroll) as HTMLElement[]
  for (const child of hidden) {
    child.style.visibility = 'hidden'
  }

  const host = document.createElement('div')
  host.className = styles.minimapHost
  const canvas = document.createElement('canvas')
  canvas.className = styles.minimap
  canvas.setAttribute('aria-hidden', 'true')
  host.appendChild(canvas)
  const peek = document.createElement('div')
  peek.className = styles.peek
  host.appendChild(peek)
  area.appendChild(host)

  const ctx = canvas.getContext('2d')
  const glide = createScrollGlide(scroll)
  /** The last full measure, and `m`: the same, moved to where its elements are now. */
  let measured: Measure | null = null
  let m: Measure | null = null
  let tracker: Tracker | null = null
  let palette = resolvePalette(host)
  let shapes: TurnShape[] = []
  /** How highlighted each turn is, 0–1; eases toward 1 for the turn being read and the one hovered. */
  let emphasis = new Float32Array(0)
  let current = -1
  let geo = { x: 0, w: 0, gutter: 0, height: 0 }
  let layout: MapLayout | null = null
  let hovered = -1
  let dragging = false
  let lensCentre = scroll.scrollTop + scroll.clientHeight / 2
  let lensVelocity = 0

  const currentLayout = () =>
    m
      ? layoutMap(
          m.height,
          scroll.clientHeight,
          options.lens ? lensCentre : null,
          PAD,
          Math.max(1, geo.height - PAD * 2)
        )
      : null

  const turnAt = (y: number) => {
    let turn = 0
    m?.anchors.forEach((top, i) => {
      if (top <= y + 1) {
        turn = i
      }
    })
    return turn
  }

  const paint = () => {
    if (!m || !ctx) {
      return
    }
    const L = currentLayout()
    layout = L
    if (!L) {
      return
    }
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, geo.gutter, geo.height)
    const { scrollTop, clientHeight } = scroll
    const { x: X, w: W } = geo
    const p = palette
    const fill = (r: Rect, colour: Rgba, radius = 0) => {
      const h = Math.max(0.75, r.y1 - r.y0)
      const width = Math.max(0.75, r.w)
      ctx.fillStyle = css(colour)
      if (radius <= 0.05) {
        ctx.fillRect(r.x, r.y0, width, h)
        return
      }
      ctx.beginPath()
      ctx.roundRect(r.x, r.y0, width, h, Math.min(radius, h / 2, width / 2))
      ctx.fill()
    }
    const span = (x: number, w: number, a: number, b: number): Rect => ({
      x: X + x * W,
      w: w * W,
      y0: L.top(a),
      y1: L.top(b),
    })
    const SLAB_X = 0
    const SLAB_W = 0.86
    // Everything is drawn in the transcript's own colours. Lines, bars and slabs get lighter as
    // they get bigger, so the rail keeps about the same weight at every level of detail; the
    // highlighted turn comes up to near full strength.
    const lineInk = (color: string, e: number) => tint(toRgba(color), lerp(0.4, 0.85, e))
    const barInk = (color: Rgba, e: number) => tint(color, lerp(0.24, 0.5, e))
    const slabInk = (color: Rgba, e: number) => tint(color, lerp(0.16, 0.38, e))

    // Code block backgrounds, table row rules and quote bars, in their own colours; they belong
    // to full detail and fade with it. Drawn first, so the text sits on top.
    for (const b of m.boxes) {
      if (b.kind === 'bubble' || b.kind === 'table') {
        continue
      }
      if (b.h <= (b.kind === 'rule' ? 0 : 0.5)) {
        continue
      }
      const alpha = lineAlpha(L.scaleAt(b.y + b.h / 2))
      if (alpha < 0.01) {
        continue
      }
      const colour = toRgba(b.color)
      const r = span(b.x, b.w, b.y, b.y + b.h)
      if (b.kind === 'code') {
        fill(r, tint(colour, alpha), 1.5)
      } else if (b.kind === 'rule') {
        // Rules are hairlines in the app; at this size they need a little more ink to show.
        fill({ ...r, y1: r.y0 + 0.75 }, tint(colour, Math.min(1 / colour[3], 2.5) * alpha))
      } else {
        fill({ ...r, w: 1.5 }, tint(colour, alpha), 0.75)
      }
    }

    shapes.forEach((turn, t) => {
      const e = emphasis[t] ?? 0
      const slabColour = slabInk(turn.color, e)
      const mid = (turn.answerStart + turn.answerEnd) / 2
      const merged =
        turn.blocks.length === 0
          ? blockAlpha(L.scaleAt(mid)) <= 0
          : turn.blocks.every((b) => blockAlpha(L.scaleAt(b.block.y + b.block.h / 2)) <= 0)
      if (merged) {
        // The whole answer is one slab.
        fill(span(SLAB_X, SLAB_W, turn.answerStart, turn.answerEnd), slabColour)
        return
      }
      for (const shape of turn.blocks) {
        const { block } = shape
        const scale = L.scaleAt(block.y + block.h / 2)
        const toBar = 1 - lineAlpha(scale)
        const toSlab = 1 - blockAlpha(scale)
        const slabTile = span(SLAB_X, SLAB_W, shape.slabTop, shape.slabBottom)
        const barColour = barInk(shape.color, e)
        if (block.h <= 0.5) {
          continue
        }
        if (toBar >= 1) {
          // The paragraph is one bar, stretching toward its share of the slab.
          fill(
            mixRect(span(block.x, block.w, block.y, block.y + block.h), slabTile, toSlab),
            blend(barColour, slabColour, toSlab)
          )
          continue
        }
        for (const line of shape.lines) {
          const { seg } = line
          const heading = seg.kind === 'heading'
          const colour = lineInk(seg.color, e)
          const stroke = clamp(seg.h * scale * 0.6, 0.8, heading ? 2.4 : 1.6)
          const centre = (L.top(seg.y) + L.top(seg.y + seg.h)) / 2
          const own: Rect = {
            x: X + seg.x * W,
            w: seg.w * W,
            y0: centre - stroke / 2,
            y1: centre + stroke / 2,
          }
          if (!line.leads) {
            // Other runs on the row (code tokens, table cells) fade as the first grows into the tile.
            fill(own, tint(colour, 1 - toBar), stroke / 2)
            continue
          }
          const tile = mixRect(own, span(block.x, block.w, seg.y, line.tileBottom), toBar)
          const rect = mixRect(tile, span(SLAB_X, SLAB_W, line.slabTop, line.slabBottom), toSlab)
          fill(
            rect,
            blend(blend(colour, barColour, toBar), slabColour, toSlab),
            (stroke / 2) * (1 - toBar)
          )
        }
      }
    })

    // Prompts, at every level of detail. With room, the pill is the bubble's own fill with its
    // text showing; as it shrinks to a sliver it takes the text's colour so it can still be found.
    shapes.forEach((turn, t) => {
      const b = turn.bubble
      if (!b) {
        return
      }
      const e = emphasis[t] ?? 0
      const y0 = L.top(b.y)
      const h = Math.max(1.5, L.top(b.y + b.h) - y0)
      const roomy = smooth(2, 5, h)
      const pitch = L.top(m?.anchors[t + 1] ?? m?.height ?? 0) - L.top(m?.anchors[t] ?? b.y)
      // Where turns are only a few px apart, markers fade so they don't stripe the rail.
      const presence = lerp(smooth(2.5, 7, pitch), 1, e)
      const background = toRgba(b.color)
      const firstLine = turn.bubbleLines[0]
      const ink = firstLine ? toRgba(firstLine.color) : p['text-primary']
      const sliver = tint(ink, lerp(0.4, 0.85, e))
      const pill = blend(background, ink, lerp(0, 0.1, e))
      const width = Math.max(4, b.w * W) + 2
      fill(
        { x: X + b.x * W - 1, w: width, y0, y1: y0 + h },
        tint(blend(sliver, pill, roomy), presence),
        3
      )
      if (roomy > 0.01) {
        for (const seg of turn.bubbleLines) {
          const centre = (L.top(seg.y) + L.top(seg.y + seg.h)) / 2
          fill(
            { x: X + seg.x * W, w: seg.w * W, y0: centre - 0.7, y1: centre + 0.7 },
            tint(toRgba(seg.color), lerp(0.55, 0.9, e) * roomy * presence),
            0.7
          )
        }
      }
    })

    // The window: what's on screen. In a long chat at one scale it would shrink to a sliver, so
    // it keeps at least 16px to stay grabbable.
    const middle = (L.top(scrollTop) + L.top(scrollTop + clientHeight)) / 2
    const half = Math.max(8, (L.top(scrollTop + clientHeight) - L.top(scrollTop)) / 2)
    ctx.fillStyle = css(dragging ? p['interactive-active'] : p['interactive-hover'])
    ctx.strokeStyle = css(p['border-default'])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(X - 4.5, middle - half + 0.5, W + 9, Math.max(4, half * 2) - 1, 4)
    ctx.fill()
    ctx.stroke()
  }

  const draw = () => {
    measured = measure(scroll, column)
    tracker = trackElements(measured, scroll, column)
    m = measured
    palette = resolvePalette(host)
    const areaRect = area.getBoundingClientRect()
    const gutter = Math.max(0, column.getBoundingClientRect().left - areaRect.left)
    const w = Math.min(MAX_WIDTH, gutter - 20)
    geo = { x: Math.max(8, Math.min(16, (gutter - w) / 2)), w, gutter, height: area.clientHeight }
    host.hidden = gutter < 48 || w < 24
    host.style.width = `${gutter}px`
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(gutter * dpr)
    canvas.height = Math.round(geo.height * dpr)
    shapes = shapeTurns(m)
    const previous = emphasis
    emphasis = new Float32Array(m.anchors.length)
    emphasis.set(previous.subarray(0, emphasis.length))
    if (current < 0) {
      current = turnAt(readingLineY(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight))
      emphasis[current] = 1
    }
    paint()
  }

  // The lens stays put while the reading position moves within LENS_SLACK of its centre, so
  // small scrolls only move the window; past that it follows on a spring instead of rigidly.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0
  let lastTick = 0
  const tick = (now: number) => {
    frame = 0
    const dt = lastTick ? Math.min(0.05, (now - lastTick) / 1000) : 1 / 60
    lastTick = now
    const target = scroll.scrollTop + scroll.clientHeight / 2
    const slack = scroll.clientHeight * LENS_SLACK
    const desired = dragging ? lensCentre : clamp(lensCentre, target - slack, target + slack)
    if (reducedMotion.matches) {
      lensCentre = desired
      lensVelocity = 0
    } else {
      lensVelocity +=
        (LENS_STIFFNESS * (desired - lensCentre) - 2 * Math.sqrt(LENS_STIFFNESS) * lensVelocity) *
        dt
      lensCentre += lensVelocity * dt
      if (Math.abs(desired - lensCentre) < 0.5 && Math.abs(lensVelocity) < 5) {
        lensCentre = desired
        lensVelocity = 0
      }
    }
    // Highlights ease in and out (about 120ms) rather than switching in one frame.
    current = turnAt(readingLineY(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight))
    const ease = reducedMotion.matches ? 1 : 1 - Math.exp(-dt / 0.12)
    let highlighting = false
    for (let i = 0; i < emphasis.length; i += 1) {
      const goal = i === current || i === hovered ? 1 : 0
      const value = emphasis[i] ?? 0
      const next = Math.abs(goal - value) < 0.01 ? goal : value + (goal - value) * ease
      emphasis[i] = next
      highlighting ||= next !== goal
    }
    paint()
    if (lensCentre !== desired || lensVelocity !== 0 || highlighting) {
      frame = requestAnimationFrame(tick)
    } else {
      lastTick = 0
    }
  }
  const schedulePaint = () => {
    if (!frame) {
      frame = requestAnimationFrame(tick)
    }
  }
  scroll.addEventListener('scroll', schedulePaint, { passive: true })
  let redraw = 0
  const scheduleDraw = () => {
    clearTimeout(redraw)
    redraw = window.setTimeout(draw, 80)
  }
  // While the transcript changes height (a reasoning row opening, an image loading), follow it
  // frame by frame: move every line with its element and clip it to the container that's
  // growing or shrinking, as the transcript does. A full measure follows once it settles.
  const follow = () => {
    if (!measured || !tracker) {
      return
    }
    m = moveToElements(measured, tracker, scroll)
    shapes = shapeTurns(m)
    paint()
    clearTimeout(redraw)
    redraw = window.setTimeout(draw, 160)
  }
  const resize = new ResizeObserver((entries) => {
    if (entries.some((entry) => entry.target === area)) {
      scheduleDraw()
    } else {
      follow()
    }
  })
  resize.observe(column)
  resize.observe(area)
  // New content (the reasoning text that just opened) is measured on the next frame, so it can
  // be followed as it's revealed rather than appearing once the animation ends.
  let measureFrame = 0
  const mutations = new MutationObserver(() => {
    if (!measureFrame) {
      measureFrame = requestAnimationFrame(() => {
        measureFrame = 0
        draw()
      })
    }
  })
  // `data-phase` is how the transcript's disclosures switch clipping on while they open or close.
  mutations.observe(column, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-phase'],
  })
  const theme = new MutationObserver(scheduleDraw)
  theme.observe(document.documentElement, { attributes: true })

  const localY = (event: PointerEvent) => event.clientY - area.getBoundingClientRect().top

  const setHover = (turn: number, event: PointerEvent | null) => {
    if (turn !== hovered) {
      hovered = turn
      schedulePaint()
    }
    if (turn < 0 || !m || !event) {
      peek.removeAttribute('data-open')
      return
    }
    peek.replaceChildren()
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

  let drag: { offset: number; moved: boolean; y: number } | null = null
  const onDown = (event: PointerEvent) => {
    if (!m || !layout || event.button !== 0) {
      return
    }
    event.preventDefault()
    const railY = localY(event)
    const y = layout.toContent(railY)
    setHover(turnAt(y), event)
    const { scrollTop, clientHeight } = scroll
    const windowTop = layout.top(scrollTop)
    const windowBottom = layout.top(scrollTop + clientHeight)
    if (railY < windowTop - 8 || railY > windowBottom + 8) {
      const target = clamp(y - clientHeight / 2, 0, scroll.scrollHeight - clientHeight)
      glide.to(target, { fade: column })
      drag = { offset: (windowBottom - windowTop) / 2, moved: false, y: event.clientY }
    } else {
      drag = { offset: railY - windowTop, moved: false, y: event.clientY }
    }
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers cannot be captured; the drag still follows moves over the rail.
    }
  }
  const onMove = (event: PointerEvent) => {
    if (drag) {
      if (!drag.moved && Math.abs(event.clientY - drag.y) < 3) {
        return
      }
      if (!drag.moved) {
        glide.cancel()
        drag.moved = true
        dragging = true
      }
      // The lens holds still while dragging, so the rail under the pointer doesn't move.
      if (layout) {
        scroll.scrollTop = layout.toContent(localY(event) - drag.offset)
      }
      if (layout) {
        setHover(turnAt(layout.toContent(localY(event))), event)
      }
      return
    }
    if (layout && m) {
      const y = layout.toContent(localY(event))
      setHover(y >= 0 && y <= m.height ? turnAt(y) : -1, event)
    }
  }
  const onUp = () => {
    drag = null
    dragging = false
    schedulePaint()
  }
  const onLeave = () => {
    if (!drag) {
      setHover(-1, null)
    }
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('pointerleave', onLeave)

  draw()

  return () => {
    clearTimeout(redraw)
    cancelAnimationFrame(frame)
    cancelAnimationFrame(measureFrame)
    glide.cancel()
    resize.disconnect()
    mutations.disconnect()
    theme.disconnect()
    scroll.removeEventListener('scroll', schedulePaint)
    host.remove()
    for (const child of hidden) {
      child.style.visibility = ''
    }
  }
}
