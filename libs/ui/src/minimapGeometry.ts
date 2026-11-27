import { scrollSpringSettled, stepScrollSpring, type ScrollSpring } from './scrollGlide.js'

/**
 * Pure geometry for the minimap: what a measured document looks like on the rail at every scale.
 * No DOM here; `minimapMeasure.ts` builds the model and `minimapPaint.ts` draws it.
 *
 * A document is a list of sections (for a chat, its turns). Positions inside a section are px
 * from the section's top (`y`, `h`) and fractions of the content column's width (`x`, `w`), so a
 * section's shape stays valid while everything above it changes height and it only moves.
 */

/** One run of text on one line, in one colour (a code token, or a whole line of prose). */
export type MinimapRun = {
  /** Index into `blocks` of the paragraph, list item, heading, table, code block or quote it is in. */
  readonly block: number
  readonly kind: 'text' | 'heading' | 'code'
  readonly color: string
  readonly x: number
  readonly w: number
  readonly y: number
  readonly h: number
}

/** A paragraph, list item, heading, table, code block or quote: the union of its runs. */
export type MinimapBlock = {
  readonly x: number
  readonly w: number
  readonly y: number
  readonly h: number
}

/** A code block's background, a table row's rule, or a quote's bar, in its own colour. */
export type MinimapDecoration = {
  readonly kind: 'fill' | 'rule' | 'bar'
  readonly color: string
  readonly x: number
  readonly w: number
  readonly y: number
  readonly h: number
}

/** What starts a section (for a chat, the prompt bubble) and its own lines of text. */
export type MinimapMarker = {
  readonly x: number
  readonly w: number
  readonly y: number
  readonly h: number
  readonly runs: readonly Omit<MinimapRun, 'block' | 'kind'>[]
}

/** What one section contains, measured from its top. */
export type MinimapSectionContent = {
  /** From the section's top to the next section's (or the end of the content). */
  readonly height: number
  readonly runs: readonly MinimapRun[]
  readonly blocks: readonly MinimapBlock[]
  readonly decorations: readonly MinimapDecoration[]
  readonly marker: MinimapMarker | undefined
}

/** Rail px per content px where the rail shows full detail: around the reader, or everywhere when it fits. */
export const MINIMAP_FULL_SCALE = 0.1
/** Content kept at full detail on each side of the focus, in viewports. */
export const MINIMAP_LENS_CORE = 1
/** Distance over which detail eases from the lens to the rest of the document, in viewports. */
export const MINIMAP_LENS_FALLOFF = 3
/** The most of the rail the lens may take, so the rest of the document keeps some room. */
export const MINIMAP_LENS_MAX_SHARE = 0.6
/** How far the reader moves, in viewports, before the lens follows. */
export const MINIMAP_FOCUS_SLACK = 0.5
/** Stiffness of the spring the lens follows with (critically damped; settles in about 0.6s). */
export const MINIMAP_FOCUS_STIFFNESS = 90
/** Line height the detail thresholds are set against, in content px. */
const LINE_PITCH = 22
/** Resolution of the lens's scale profile, in content px. */
const BIN = 4

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** How much text lines show at `scale`: while a line gets ~1.3px of rail or more, fully from 2px. */
export const minimapLineDetail = (scale: number) => smoothstep(1.3, 2, scale * LINE_PITCH)
/** How much paragraph bars show at `scale`: while the gaps between paragraphs stay visible. */
export const minimapBlockDetail = (scale: number) => smoothstep(0.014, 0.03, scale)

/** Where content lands on the rail. `top` and `toContent` are inverses; `scaleAt` is d(top)/dy. */
export type MinimapMap = {
  readonly top: (y: number) => number
  readonly scaleAt: (y: number) => number
  readonly toContent: (railY: number) => number
}

/**
 * Lays a document `height` px tall onto a rail from `railTop` for `railHeight` px.
 *
 * When the document fits at full detail it does, centred. Otherwise, with no `focus`, it all
 * shares the rail at one scale. With a `focus` (content px) the lens keeps full detail within
 * `MINIMAP_LENS_CORE` viewports of it, eases off over `MINIMAP_LENS_FALLOFF` more, and the rest of
 * the document shares what's left, so the map always fills the rail exactly.
 */
export const layoutMinimapMap = ({
  height,
  viewport,
  focus,
  railTop,
  railHeight,
}: {
  readonly height: number
  readonly viewport: number
  readonly focus: number | null
  readonly railTop: number
  readonly railHeight: number
}): MinimapMap => {
  const span = Math.max(1, height)
  const uniform = (scale: number): MinimapMap => {
    const top0 = railTop + Math.max(0, (railHeight - span * scale) / 2)
    return {
      top: (y) => top0 + y * scale,
      scaleAt: () => scale,
      toContent: (railY) => (railY - top0) / scale,
    }
  }
  if (focus === null || railHeight / span >= MINIMAP_FULL_SCALE) {
    return uniform(Math.min(MINIMAP_FULL_SCALE, railHeight / span))
  }

  const core = viewport * MINIMAP_LENS_CORE
  const falloff = viewport * MINIMAP_LENS_FALLOFF
  const bins = Math.ceil(span / BIN)
  const weight = new Float32Array(bins)
  let weightSum = 0
  for (let i = 0; i < bins; i += 1) {
    const w = 1 - smoothstep(core, core + falloff, Math.abs((i + 0.5) * BIN - focus))
    weight[i] = w
    weightSum += w
  }
  const lensSpan = weightSum * BIN
  const near = Math.min(MINIMAP_FULL_SCALE, (MINIMAP_LENS_MAX_SHARE * railHeight) / lensSpan)
  const far = (railHeight - near * lensSpan) / Math.max(1, span - lensSpan)
  if (far >= near) {
    return uniform(railHeight / span)
  }

  // Cumulative rail position at each bin edge, scaled so the last edge lands on the rail's end.
  const cum = new Float64Array(bins + 1)
  cum[0] = railTop
  for (let i = 0; i < bins; i += 1) {
    const binHeight = Math.min(BIN, span - i * BIN)
    cum[i + 1] = (cum[i] ?? 0) + binHeight * (far + (near - far) * (weight[i] ?? 0))
  }
  const fit = railHeight / ((cum[bins] ?? railTop + 1) - railTop)
  for (let i = 1; i <= bins; i += 1) {
    cum[i] = railTop + ((cum[i] ?? 0) - railTop) * fit
  }
  const edge = (i: number) => Math.min(span, i * BIN)
  const top = (y: number) => {
    const c = clamp(y, 0, span)
    const i = Math.min(bins - 1, Math.floor(c / BIN))
    const a = cum[i] ?? railTop
    const b = cum[i + 1] ?? a
    const width = edge(i + 1) - edge(i)
    return a + (b - a) * (width > 0 ? (c - edge(i)) / width : 0)
  }
  return {
    top,
    scaleAt: (y) =>
      (far + (near - far) * (weight[clamp(Math.floor(y / BIN), 0, bins - 1)] ?? 0)) * fit,
    toContent: (railY) => {
      if (railY <= railTop) {
        return 0
      }
      let lo = 0
      let hi = bins - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if ((cum[mid + 1] ?? Infinity) < railY) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      const a = cum[lo] ?? railTop
      const b = cum[lo + 1] ?? a
      const t = b > a ? clamp((railY - a) / (b - a), 0, 1) : 0
      return edge(lo) + (edge(lo + 1) - edge(lo)) * t
    },
  }
}

/**
 * Moves the lens's focus toward the reader. It holds still while the reader's centre is within
 * `MINIMAP_FOCUS_SLACK` viewports of it, so small scrolls only move the window, and follows larger
 * moves on a critically damped spring. While `hold` is set (the window is being dragged) it stays
 * put, so the rail under the pointer doesn't move.
 */
export const stepMinimapFocus = (
  focus: ScrollSpring,
  readerCentre: number,
  viewport: number,
  seconds: number,
  hold = false
): { readonly focus: ScrollSpring; readonly settled: boolean } => {
  const slack = viewport * MINIMAP_FOCUS_SLACK
  const goal = hold
    ? focus.position
    : clamp(focus.position, readerCentre - slack, readerCentre + slack)
  if (scrollSpringSettled(focus, goal)) {
    return { focus: { position: goal, velocity: 0 }, settled: true }
  }
  return { focus: stepScrollSpring(focus, goal, seconds, MINIMAP_FOCUS_STIFFNESS), settled: false }
}

export type MinimapRect = {
  readonly x: number
  readonly w: number
  readonly y0: number
  readonly y1: number
}

export const mixRect = (a: MinimapRect, b: MinimapRect, t: number): MinimapRect =>
  t <= 0
    ? a
    : t >= 1
      ? b
      : {
          x: a.x + (b.x - a.x) * t,
          w: a.w + (b.w - a.w) * t,
          y0: a.y0 + (b.y0 - a.y0) * t,
          y1: a.y1 + (b.y1 - a.y1) * t,
        }

/**
 * One run with where it goes at each level of detail, in content px: its own stroke, its tile of
 * its block's bar (from its line's top to the next line's), and its tile of its section's slab.
 * Drawing a blend of the three lets lines thicken into their bar and bars stretch into the slab as
 * one shape, rather than two drawings fading over each other.
 */
export type MinimapRunShape = {
  readonly run: MinimapRun
  /** Several runs on one line share a tile; only the first grows into it, the rest fade. */
  readonly leads: boolean
  readonly tileTop: number
  readonly tileBottom: number
  readonly slabTop: number
  readonly slabBottom: number
}

export type MinimapBlockShape = {
  readonly block: MinimapBlock
  readonly runs: readonly MinimapRunShape[]
  readonly slabTop: number
  readonly slabBottom: number
  /** Its runs' colours averaged by length, as RGBA 0–255 with alpha 0–1. */
  readonly color: Rgba
}

export type MinimapSectionShape = {
  readonly height: number
  readonly blocks: readonly MinimapBlockShape[]
  readonly decorations: readonly MinimapDecoration[]
  /** The section's body: from below its marker to just above the next section. */
  readonly bodyTop: number
  readonly bodyBottom: number
  readonly marker: MinimapMarker | undefined
  /** Its blocks' colours averaged by area. */
  readonly color: Rgba
}

export type Rgba = readonly [number, number, number, number]

/** Space between a marker and its section's body, and before the next section, in content px. */
const BODY_GAP_TOP = 12
const BODY_GAP_BOTTOM = 6
/** Runs closer than this, in content px, are on the same line. */
const SAME_LINE = 3

const average = (parts: readonly { readonly color: Rgba; readonly weight: number }[]): Rgba => {
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  let total = 0
  for (const { color, weight } of parts) {
    r += color[0] * weight
    g += color[1] * weight
    b += color[2] * weight
    a += color[3] * weight
    total += weight
  }
  return total > 0 ? [r / total, g / total, b / total, a / total] : [128, 128, 128, 1]
}

/**
 * Tiles a section for drawing at every level of detail. Every block's slab tile runs from its top
 * to the next block's (the first from the body's top, the last to the body's bottom), and every
 * line's bar tile from its top to the next line's, so fully merged the tiles cover the body
 * exactly once. `toRgba` turns a CSS colour into RGBA.
 */
export const shapeMinimapSection = (
  content: MinimapSectionContent,
  toRgba: (color: string) => Rgba
): MinimapSectionShape => {
  const { blocks, runs, marker, height, decorations } = content
  const runsByBlock = blocks.map((): MinimapRun[] => [])
  for (const run of runs) {
    runsByBlock[run.block]?.push(run)
  }
  const bodyTop = marker ? marker.y + marker.h + BODY_GAP_TOP : 0
  const bodyBottom = Math.max(bodyTop + 1, height - BODY_GAP_BOTTOM)
  const order = blocks
    .map((_, i) => i)
    .filter((i) => (blocks[i]?.h ?? 0) > 0)
    .sort((a, b) => (blocks[a]?.y ?? 0) - (blocks[b]?.y ?? 0))
  let cursor = bodyTop
  const shapes = order.map((index, k): MinimapBlockShape => {
    const block = blocks[index] as MinimapBlock
    const next = blocks[order[k + 1] ?? -1]
    const slabTop = Math.min(cursor, block.y)
    const slabBottom = next
      ? Math.max(block.y + block.h, next.y)
      : Math.max(bodyBottom, block.y + block.h)
    cursor = slabBottom
    const own = (runsByBlock[index] ?? []).slice().sort((a, b) => a.y - b.y || a.x - b.x)
    const lines: MinimapRun[][] = []
    for (const run of own) {
      const line = lines.at(-1)
      if (line && Math.abs((line[0]?.y ?? 0) - run.y) < SAME_LINE) {
        line.push(run)
      } else {
        lines.push([run])
      }
    }
    const shaped = lines.flatMap((line, l) => {
      const lineTop = line[0]?.y ?? block.y
      const nextTop = lines[l + 1]?.[0]?.y
      const tileTop = l === 0 ? block.y : lineTop
      const tileBottom = nextTop ?? block.y + block.h
      return line.map(
        (run, r): MinimapRunShape => ({
          run,
          leads: r === 0,
          tileTop,
          tileBottom,
          slabTop: l === 0 ? slabTop : lineTop,
          slabBottom: nextTop ?? slabBottom,
        })
      )
    })
    const color = average(own.map((run) => ({ color: toRgba(run.color), weight: run.w })))
    return { block, runs: shaped, slabTop, slabBottom, color }
  })
  const color = average(
    shapes.map((shape) => ({ color: shape.color, weight: shape.block.w * shape.block.h }))
  )
  return { height, blocks: shapes, decorations, bodyTop, bodyBottom, marker, color }
}
