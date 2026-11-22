import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clampSidePanelResizeWidth } from './state.js'

describe('right panel resize clamping', () => {
  it('clamps resize width between 360px and min(window - 360, 72vw)', () => {
    assert.equal(clampSidePanelResizeWidth(240, 1200), 360)
    assert.equal(clampSidePanelResizeWidth(600.4, 1200), 600)
    // 1200 - 360 = 840 < 1200 * 0.72 = 864
    assert.equal(clampSidePanelResizeWidth(950, 1200), 840)
    // 1800 * 0.72 = 1296 < 1800 - 360 = 1440
    assert.equal(clampSidePanelResizeWidth(1400, 1800), 1296)
    // Narrow window still floors at 360px
    assert.equal(clampSidePanelResizeWidth(500, 600), 360)
  })
})
