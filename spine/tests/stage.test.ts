import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  computeDraggedViewportSize,
  findMatchingViewportPreset,
  fitViewportToStage,
  getDefaultCustomViewportSize,
  isCustomViewport,
  parseCustomViewportInput,
  resolveViewportRequest,
} from '@deepseek-chat/spine/design'

describe('stage: viewport presets, aspect ratios, and stage fitting', () => {
  it('resolves presets, aspect ratios, explicit bounds, and auto reset', () => {
    assert.equal(resolveViewportRequest({ preset: 'auto' }), null)
    assert.deepEqual(resolveViewportRequest({ preset: 'mobile' }), {
      width: 390,
      height: 844,
      preset: 'mobile',
      aspectRatio: null,
    })
    assert.deepEqual(resolveViewportRequest({ preset: 'desktop' }), {
      width: 1280,
      height: 720,
      preset: 'desktop',
      aspectRatio: null,
    })
    assert.deepEqual(resolveViewportRequest({ aspect_ratio: '16:9' }), {
      width: 1280,
      height: 720,
      preset: null,
      aspectRatio: '16:9',
    })
    assert.deepEqual(resolveViewportRequest({ aspect_ratio: '9:16' }), {
      width: 390,
      height: 693,
      preset: null,
      aspectRatio: '9:16',
    })
    assert.deepEqual(resolveViewportRequest({ aspect_ratio: '4:3', width: 800 }), {
      width: 800,
      height: 600,
      preset: null,
      aspectRatio: '4:3',
    })
    assert.deepEqual(resolveViewportRequest({ width: 100, height: 4000 }), {
      width: 320,
      height: 2560,
      preset: null,
      aspectRatio: null,
    })
    assert.throws(() => resolveViewportRequest({ aspect_ratio: 'wide' }))
    assert.throws(() => resolveViewportRequest({}))
  })

  it('fits any requested viewport inside the panel stage without overflowing', () => {
    // Auto fills stage at 1:1
    assert.deepEqual(fitViewportToStage(null, 520, 660), {
      boxWidth: 520,
      boxHeight: 660,
      zoom: 1,
      scale: 1,
      letterboxed: false,
      clipped: false,
    })

    // 1280x720 scales down inside 520x660
    const desktopFit = fitViewportToStage({ width: 1280, height: 720 }, 520, 660)
    assert.equal(desktopFit.boxWidth, 520)
    assert.equal(desktopFit.boxHeight, 293)
    assert.equal(desktopFit.letterboxed, true)
    assert.equal(desktopFit.clipped, false)
    assert.ok(Math.abs(desktopFit.zoom - 520 / 1280) < 0.001)

    // Small viewport renders 1:1 centered
    const smallFit = fitViewportToStage({ width: 390, height: 640 }, 520, 660)
    assert.equal(smallFit.boxWidth, 390)
    assert.equal(smallFit.boxHeight, 640)
    assert.equal(smallFit.zoom, 1)
    assert.equal(smallFit.letterboxed, true)

    // Tall mobile viewport scales by height
    const mobileFit = fitViewportToStage({ width: 390, height: 844 }, 520, 660)
    assert.equal(mobileFit.boxHeight, 660)
    assert.equal(mobileFit.boxWidth, 305)
    assert.ok(Math.abs(mobileFit.zoom - 660 / 844) < 0.001)

    // Ultra-wide request clamps zoom to 0.25 floor while still fitting inside stage
    const clippedFit = fitViewportToStage({ width: 2560, height: 1440 }, 340, 660)
    assert.equal(clippedFit.clipped, true)
    assert.equal(clippedFit.zoom, 0.25)
    assert.equal(clippedFit.boxWidth, 340)
    assert.equal(clippedFit.boxHeight, 191)
  })

  it('parses and validates custom viewport inputs at exact boundaries and rejects invalid formats', () => {
    // Valid custom dimensions (preset: null)
    assert.deepEqual(parseCustomViewportInput('1024', '768'), {
      ok: true,
      spec: { width: 1024, height: 768, preset: null, aspectRatio: null },
    })
    assert.deepEqual(parseCustomViewportInput(' 800px ', ' 600 PX '), {
      ok: true,
      spec: { width: 800, height: 600, preset: null, aspectRatio: null },
    })

    // Exact inclusive bounds: width 320..2560, height 240..2560
    assert.equal(parseCustomViewportInput('320', '240').ok, true)
    assert.equal(parseCustomViewportInput('2560', '2560').ok, true)

    // Explicit custom apply preserves preset: null so Custom mode and handles stay active
    assert.equal(findMatchingViewportPreset(1280, 720), 'desktop')
    assert.equal(findMatchingViewportPreset(1024, 768), null)
    assert.deepEqual(parseCustomViewportInput('1280', '720'), {
      ok: true,
      spec: { width: 1280, height: 720, preset: null, aspectRatio: null },
    })

    // Out-of-bounds identify the exact invalid field(s)
    assert.deepEqual(parseCustomViewportInput('319', '240'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: false,
    })
    assert.deepEqual(parseCustomViewportInput('320', '239'), {
      ok: false,
      widthInvalid: false,
      heightInvalid: true,
    })
    assert.deepEqual(parseCustomViewportInput('2561', '2561'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: true,
    })

    // Malformed strings are rejected rather than coerced
    assert.deepEqual(parseCustomViewportInput('', '  '), {
      ok: false,
      widthInvalid: true,
      heightInvalid: true,
    })
    assert.deepEqual(parseCustomViewportInput('-400', '1e3'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: true,
    })
    assert.deepEqual(parseCustomViewportInput('800x', '600'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: false,
    })
  })

  it('seeds default custom dimensions from active viewport, clamped stage size, or fallback', () => {
    assert.deepEqual(
      getDefaultCustomViewportSize({ width: 1000, height: 650 }, { width: 520, height: 660 }),
      { width: 1000, height: 650 }
    )
    assert.deepEqual(getDefaultCustomViewportSize(null, { width: 280.4, height: 660.6 }), {
      width: 320,
      height: 661,
    })
    assert.deepEqual(getDefaultCustomViewportSize(null, null), { width: 1024, height: 768 })
  })

  it('distinguishes custom viewports from presets and computes centered stage drag deltas', () => {
    assert.equal(isCustomViewport(null), false)
    assert.equal(isCustomViewport({ width: 1280, height: 720, preset: 'desktop' }), false)
    assert.equal(isCustomViewport({ width: 1280, height: 720, preset: null }), true)
    assert.equal(isCustomViewport({ width: 1024, height: 768 }), true)
    assert.equal(isCustomViewport({ width: 1280, height: 720 }), false)

    // Unscaled centered stage: dragging right +40px adds 2 * 40 = +80px width without changing height
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 400, height: 500 },
        startZoom: 1,
        dx: 40,
        dy: 25,
        edge: 'right',
      }),
      { width: 480, height: 500 }
    )

    // Bottom edge changes height only
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 400, height: 500 },
        startZoom: 1,
        dx: 40,
        dy: -30,
        edge: 'bottom',
      }),
      { width: 400, height: 440 }
    )

    // Scaled stage (zoom = 0.5) amplifies drag delta by 2 / 0.5 = 4x and clamps bounds
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 1000, height: 600 },
        startZoom: 0.5,
        dx: 50,
        dy: -100,
        edge: 'corner',
      }),
      { width: 1200, height: 240 }
    )
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 2400, height: 2500 },
        startZoom: 0.5,
        dx: 100,
        dy: 100,
        edge: 'corner',
      }),
      { width: 2560, height: 2560 }
    )
  })
})
