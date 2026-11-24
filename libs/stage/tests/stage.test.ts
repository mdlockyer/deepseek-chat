import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StageHost } from '@deepseek-chat/spine/ports'
import {
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  MIN_VIEWPORT_HEIGHT,
  MIN_VIEWPORT_WIDTH,
  MIN_VIEWPORT_ZOOM,
  StageFrame,
  VIEWPORT_PRESETS,
  ViewportMenu,
  computeDraggedViewportSize,
  fitViewportToStage,
  getDefaultCustomViewportSize,
  isCustomViewport,
  parseAspectRatio,
  parseCustomViewportInput,
} from '@deepseek-chat/lib-stage'

const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const fakeHost: StageHost = {
  useStageSize: () => ({ width: 640, height: 480 }),
  setStageSize: () => undefined,
  setResizing: () => undefined,
  isResizing: () => false,
}

describe('lib-stage viewport geometry & invariants', () => {
  it('fits any requested viewport inside positive stage bounds across randomized inputs', () => {
    const rand = mulberry32(2026)

    for (let i = 0; i < 200; i += 1) {
      const stageW = 120 + Math.floor(rand() * 2400)
      const stageH = 120 + Math.floor(rand() * 1800)
      const reqW = 100 + Math.floor(rand() * 3200)
      const reqH = 100 + Math.floor(rand() * 3200)

      const fit = fitViewportToStage({ width: reqW, height: reqH }, stageW, stageH)
      assert.ok(fit.boxWidth >= 1 && fit.boxWidth <= stageW)
      assert.ok(fit.boxHeight >= 1 && fit.boxHeight <= stageH)
      assert.ok(fit.zoom >= MIN_VIEWPORT_ZOOM && fit.zoom <= 1)
      assert.equal(fit.letterboxed, true)
    }

    const auto = fitViewportToStage(null, 540, 700)
    assert.deepEqual(auto, {
      boxWidth: 540,
      boxHeight: 700,
      zoom: 1,
      scale: 1,
      letterboxed: false,
      clipped: false,
    })

    const clipped = fitViewportToStage({ width: 2560, height: 1440 }, 320, 480)
    assert.equal(clipped.clipped, true)
    assert.equal(clipped.zoom, MIN_VIEWPORT_ZOOM)
  })

  it('parses custom inputs at exact boundaries and rejects malformed or out-of-range inputs', () => {
    assert.deepEqual(
      parseCustomViewportInput(`${MIN_VIEWPORT_WIDTH}px`, `${MIN_VIEWPORT_HEIGHT}`),
      {
        ok: true,
        spec: {
          width: MIN_VIEWPORT_WIDTH,
          height: MIN_VIEWPORT_HEIGHT,
          preset: null,
          aspectRatio: null,
        },
      }
    )
    assert.deepEqual(parseCustomViewportInput(`${MAX_VIEWPORT_WIDTH}`, `${MAX_VIEWPORT_HEIGHT}`), {
      ok: true,
      spec: {
        width: MAX_VIEWPORT_WIDTH,
        height: MAX_VIEWPORT_HEIGHT,
        preset: null,
        aspectRatio: null,
      },
    })
    assert.deepEqual(parseCustomViewportInput('200', '900'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: false,
    })
    assert.deepEqual(parseCustomViewportInput('abc', '100'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: true,
    })
    assert.deepEqual(parseAspectRatio('16:9'), { rw: 16, rh: 9, label: '16:9' })
    assert.equal(parseAspectRatio('100:1'), null)
  })

  it('distinguishes custom viewports, seeds defaults, and clamps drag deltas per edge', () => {
    assert.equal(isCustomViewport(null), false)
    assert.equal(isCustomViewport({ ...VIEWPORT_PRESETS.mobile, preset: 'mobile' }), false)
    assert.equal(isCustomViewport({ width: 900, height: 600, preset: null }), true)

    assert.deepEqual(getDefaultCustomViewportSize(null, { width: 500, height: 700 }), {
      width: 500,
      height: 700,
    })
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 800, height: 600 },
        startZoom: 0.5,
        dx: 25,
        dy: 40,
        edge: 'right',
      }),
      { width: 900, height: 600 }
    )
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 800, height: 600 },
        startZoom: 0.5,
        dx: 25,
        dy: 40,
        edge: 'corner',
      }),
      { width: 900, height: 760 }
    )
  })

  it('renders StageFrame and ViewportMenu cleanly via SSR', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(ViewportMenu, {
          host: fakeHost,
          viewport: { width: 1280, height: 720, preset: 'desktop' },
          zoom: 0.5,
          onSelect: () => undefined,
        }),
        createElement(StageFrame, {
          host: fakeHost,
          viewport: { width: 900, height: 600, preset: null },
          onViewportCommit: () => undefined,
          renderContent: () => createElement('div', null, 'Canvas'),
        })
      )
    )
    assert.match(html, /aria-haspopup="dialog"/)
    assert.match(html, /1280×720/)
    assert.match(html, /role="separator"/)
    assert.match(html, /Canvas/)
  })
})
