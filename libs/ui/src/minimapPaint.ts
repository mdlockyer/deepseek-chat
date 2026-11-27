import {
  minimapBlockDetail,
  minimapLineDetail,
  mixRect,
  smoothstep,
  type MinimapMap,
  type MinimapRect,
  type Rgba,
} from './minimapGeometry.js'
import type { MinimapDocument } from './minimapMeasure.js'

/** Token colours the minimap draws its own chrome in, resolved to RGBA. */
export type MinimapPalette = {
  readonly window: Rgba
  readonly windowActive: Rgba
  readonly windowBorder: Rgba
  readonly windowBorderStrong: Rgba
  /** The surface behind the rail, laid thinly over the map outside the window. */
  readonly veil: Rgba
  readonly focusRing: Rgba
  readonly divider: Rgba
  /** What the markers (the sections' openers) are drawn in. */
  readonly marker: Rgba
}

/** Where a section's slab sits across the rail column, as fractions of its width. */
const SLAB_X = 0
const SLAB_W = 0.86
/** The window never gets shorter than this, so it stays grabbable in a long document. */
export const MINIMAP_WINDOW_MIN = 16
/** How much the map outside the window is veiled, at rest and with the pointer on the rail. */
const VEIL_REST = 0.35
const VEIL_ENGAGED = 0.5

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))
const tint = (c: Rgba, alpha: number): Rgba => [c[0], c[1], c[2], c[3] * alpha]
const blend = (a: Rgba, b: Rgba, t: number): Rgba => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
  lerp(a[3], b[3], t),
]
const css = (c: Rgba) =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${clamp(c[3], 0, 1)})`

// Content is drawn in its own colours. Lines, bars and slabs get lighter as they get bigger, so
// the rail keeps about the same weight at every level of detail; a highlighted section comes up
// to near full strength.
const lineInk = (c: Rgba, e: number) => tint(c, lerp(0.4, 0.85, e))
const barInk = (c: Rgba, e: number) => tint(c, lerp(0.24, 0.5, e))
const slabInk = (c: Rgba, e: number) => tint(c, lerp(0.16, 0.38, e))

export type MinimapPaint = {
  readonly ctx: CanvasRenderingContext2D
  readonly width: number
  readonly height: number
  readonly map: MinimapMap
  readonly doc: MinimapDocument
  /** The rail column: left edge and width, in px. */
  readonly x: number
  readonly w: number
  /** How highlighted each section is, 0–1. */
  readonly emphasis: Float32Array
  readonly scrollTop: number
  readonly viewport: number
  readonly dragging: boolean
  /** 0–1: how much the pointer is engaged with the rail (over it, or dragging). */
  readonly attention: number
  /** A section with keyboard focus gets a focus ring. */
  readonly focused: number | null
  /** Sections with a divider before them. */
  readonly dividers: ReadonlySet<number>
  readonly palette: MinimapPalette
  readonly toRgba: (color: string) => Rgba
}

/** Draws the whole rail: sections at their level of detail, markers, dividers, focus and window. */
export const paintMinimap = (p: MinimapPaint) => {
  const { ctx, map, doc, x: X, w: W, emphasis, palette, toRgba } = p
  ctx.clearRect(0, 0, p.width, p.height)
  const dividerYs: number[] = []

  const fill = (r: MinimapRect, colour: Rgba, radius = 0) => {
    if (colour[3] <= 0.004) {
      return
    }
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

  doc.shapes.forEach((shape, s) => {
    const top = doc.tops[s] ?? 0
    const at = (y: number) => map.top(top + y)
    const scaleAt = (y: number) => map.scaleAt(top + y)
    const span = (x: number, w: number, a: number, b: number): MinimapRect => ({
      x: X + x * W,
      w: w * W,
      y0: at(a),
      y1: at(b),
    })
    const e = emphasis[s] ?? 0
    const slabColour = slabInk(shape.color, e)

    // Code backgrounds, table rules and quote bars belong to full detail and fade with it. They
    // go under the text.
    for (const d of shape.decorations) {
      const alpha = minimapLineDetail(scaleAt(d.y + d.h / 2))
      if (alpha < 0.01 || d.h <= 0) {
        continue
      }
      const colour = toRgba(d.color)
      const r = span(d.x, d.w, d.y, d.y + d.h)
      if (d.kind === 'fill') {
        fill(r, tint(colour, alpha), 1.5)
      } else if (d.kind === 'rule') {
        // Rules are hairlines; at this size they need a little more ink to show.
        fill({ ...r, y1: r.y0 + 0.75 }, tint(colour, Math.min(1 / colour[3], 2.5) * alpha))
      } else {
        fill({ ...r, w: Math.max(1, r.w) }, tint(colour, alpha), 0.75)
      }
    }

    const merged =
      shape.blocks.length === 0
        ? minimapBlockDetail(scaleAt((shape.bodyTop + shape.bodyBottom) / 2)) <= 0
        : shape.blocks.every((b) => minimapBlockDetail(scaleAt(b.block.y + b.block.h / 2)) <= 0)
    if (merged) {
      fill(span(SLAB_X, SLAB_W, shape.bodyTop, shape.bodyBottom), slabColour)
    } else {
      for (const blockShape of shape.blocks) {
        const { block } = blockShape
        const scale = scaleAt(block.y + block.h / 2)
        const toBar = 1 - minimapLineDetail(scale)
        const toSlab = 1 - minimapBlockDetail(scale)
        const barColour = barInk(blockShape.color, e)
        if (toBar >= 1) {
          // One bar, stretching toward its share of the slab.
          fill(
            mixRect(
              span(block.x, block.w, block.y, block.y + block.h),
              span(SLAB_X, SLAB_W, blockShape.slabTop, blockShape.slabBottom),
              toSlab
            ),
            blend(barColour, slabColour, toSlab)
          )
          continue
        }
        for (const runShape of blockShape.runs) {
          const { run } = runShape
          const colour = lineInk(toRgba(run.color), e)
          const stroke = clamp(run.h * scale * 0.6, 0.8, run.kind === 'heading' ? 2.4 : 1.6)
          const centre = (at(run.y) + at(run.y + run.h)) / 2
          const own: MinimapRect = {
            x: X + run.x * W,
            w: run.w * W,
            y0: centre - stroke / 2,
            y1: centre + stroke / 2,
          }
          if (!runShape.leads) {
            // Other runs on the line (code tokens, table cells) fade as the first grows into the tile.
            fill(own, tint(colour, 1 - toBar), stroke / 2)
            continue
          }
          const tile = mixRect(
            own,
            span(block.x, block.w, runShape.tileTop, runShape.tileBottom),
            toBar
          )
          fill(
            mixRect(tile, span(SLAB_X, SLAB_W, runShape.slabTop, runShape.slabBottom), toSlab),
            blend(blend(colour, barColour, toBar), slabColour, toSlab),
            (stroke / 2) * (1 - toBar)
          )
        }
      }
    }

    // The marker, at every level of detail, in the marker colour so sections' openers stand out
    // from everything else: with room, a light pill with its text showing in the colour; as it
    // shrinks to a sliver, solid colour so it can still be found. Where sections are only a few px
    // apart, markers fade so they don't stripe the rail.
    const marker = shape.marker
    if (marker) {
      const y0 = at(marker.y)
      const h = Math.max(1.5, at(marker.y + marker.h) - y0)
      const roomy = smoothstep(2, 5, h)
      const presence = lerp(smoothstep(2.5, 7, at(shape.height) - at(0)), 1, e)
      const sliver = tint(palette.marker, lerp(0.7, 1, e))
      const pill = tint(palette.marker, lerp(0.16, 0.26, e))
      fill(
        { x: X + marker.x * W - 1, w: Math.max(4, marker.w * W) + 2, y0, y1: y0 + h },
        tint(blend(sliver, pill, roomy), presence),
        3
      )
      if (roomy > 0.01) {
        const ink = tint(palette.marker, lerp(0.75, 1, e) * roomy * presence)
        for (const run of marker.runs) {
          const centre = (at(run.y) + at(run.y + run.h)) / 2
          fill({ x: X + run.x * W, w: run.w * W, y0: centre - 0.7, y1: centre + 0.7 }, ink, 0.7)
        }
      }
    }

    if (p.dividers.has(s) && s > 0) {
      dividerYs.push(at(0) - 3)
    }
  })

  // The window: what's on screen.
  const windowTop = map.top(p.scrollTop)
  const windowBottom = map.top(p.scrollTop + p.viewport)
  const middle = (windowTop + windowBottom) / 2
  const half = Math.max(MINIMAP_WINDOW_MIN / 2, (windowBottom - windowTop) / 2)
  const top = middle - half
  const bottom = middle + half

  // Outside the window the map steps back under a thin veil of the surface behind it, so the part
  // on screen reads at full strength without a heavier frame; a little more while the pointer is
  // on the rail.
  ctx.fillStyle = css(tint(palette.veil, lerp(VEIL_REST, VEIL_ENGAGED, p.attention)))
  ctx.fillRect(X - 6, 0, W + 12, Math.max(0, top))
  ctx.fillRect(X - 6, bottom, W + 12, Math.max(0, p.height - bottom))

  // Dividers go over the veil, so a break (a summarized context, say) is visible anywhere on the
  // map: a dashed rule across the window's width, darker and heavier than the content around it.
  ctx.strokeStyle = css(palette.divider)
  ctx.lineWidth = 1.5
  ctx.lineCap = 'round'
  ctx.setLineDash([3, 3])
  for (const y of dividerYs) {
    ctx.beginPath()
    ctx.moveTo(X - 3, Math.round(y) + 0.25)
    ctx.lineTo(X + W + 3, Math.round(y) + 0.25)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.lineCap = 'butt'

  // Keyboard focus: a ring around the focused section.
  if (p.focused !== null) {
    const top = doc.tops[p.focused]
    if (top !== undefined) {
      const y0 = map.top(top) - 2
      const y1 = Math.max(y0 + 6, map.top(doc.tops[p.focused + 1] ?? doc.height) + 1)
      ctx.strokeStyle = css(palette.focusRing)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.roundRect(X - 5, y0, W + 10, y1 - y0, 4)
      ctx.stroke()
    }
  }

  ctx.fillStyle = css(p.dragging ? palette.windowActive : palette.window)
  ctx.strokeStyle = css(
    blend(palette.windowBorder, palette.windowBorderStrong, lerp(0.5, 1, p.attention))
  )
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(X - 4.5, top + 0.5, W + 9, Math.max(4, half * 2) - 1, 4)
  ctx.fill()
  ctx.stroke()
}
