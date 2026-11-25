import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { memoryStore } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import { clampSidePanelResizeWidth, createRightPanelController } from '../rightPanel/state.js'

const makeController = (activeSessionId: string | null = 's1') => {
  const controller = createRightPanelController(memoryStore(), new EventLog())
  controller.setActiveSession(activeSessionId)
  return controller
}

describe('right panel resize clamping', () => {
  it('clamps resize width between 360px and min(window - 360, 72vw)', () => {
    assert.equal(clampSidePanelResizeWidth(240, 1200), 360)
    assert.equal(clampSidePanelResizeWidth(600.4, 1200), 600)
    assert.equal(clampSidePanelResizeWidth(950, 1200), 840)
    assert.equal(clampSidePanelResizeWidth(1400, 1800), 1296)
    assert.equal(clampSidePanelResizeWidth(500, 600), 360)
  })
})

describe('right-rail coordination (factory-scoped)', () => {
  it('prevents closeActivePanelKind("activity") from closing an open preview or browser panel', () => {
    const panel = makeController('s1')
    panel.openPanel('s1', 'preview')
    assert.equal(panel.getActivePanel('s1'), 'preview')

    panel.closeActivePanelKind('activity')
    assert.equal(panel.getActivePanel('s1'), 'preview')

    panel.openPanel('s1', 'activity')
    assert.equal(panel.getActivePanel('s1'), 'activity')
    assert.equal(panel.getPreviousPanel('s1'), 'preview')

    panel.closeActivePanelKind('activity')
    assert.equal(panel.getActivePanel('s1'), null)
    assert.equal(panel.getPreviousPanel('s1'), null)
    panel.dispose()
  })

  it('tracks the displaced previous panel per session for one-click return chips', () => {
    const panel = makeController('s1')
    panel.openPanel('s1', 'browser')
    assert.equal(panel.getPreviousPanel('s1'), null)

    panel.openPanel('s1', 'activity')
    assert.equal(panel.getActivePanel('s1'), 'activity')
    assert.equal(panel.getPreviousPanel('s1'), 'browser')

    panel.openPanel('s1', 'preview')
    assert.equal(panel.getActivePanel('s1'), 'preview')
    assert.equal(panel.getPreviousPanel('s1'), 'activity')

    panel.closePanel('s1', 'preview')
    assert.equal(panel.getPreviousPanel('s1'), null)
    panel.dispose()
  })

  it('fires shared overlay lock listeners only on 0->1 and 1->0 transitions', () => {
    const panel = makeController('s1')
    const events: boolean[] = []
    const unsub = panel.registerOverlayLockListener((locked) => events.push(locked))

    const release1 = panel.acquireOverlayLock()
    const release2 = panel.acquireOverlayLock()
    assert.deepEqual(events, [true])

    release1()
    assert.deepEqual(events, [true])
    release1()
    assert.deepEqual(events, [true])

    release2()
    assert.deepEqual(events, [true, false])
    unsub()
    panel.dispose()
  })

  it('reacts to Spine ActiveSessionChanged, SessionDeleted, and SessionHistoryReplaced facts', () => {
    const log = new EventLog()
    const panel = createRightPanelController(memoryStore(), log)
    log.publishSticky('unit', { type: 'ActiveSessionChanged', sessionId: 's1' })
    panel.openPanel('s1', 'activity')
    assert.equal(panel.createSlot('activity').isOpen('s1'), true)

    log.publish({ type: 'SessionDeleted', sessionId: 's1' })
    assert.equal(panel.getActivePanel('s1'), null)
    assert.equal(panel.useStore.getState().activeSessionId, null)

    log.publishSticky('unit', { type: 'ActiveSessionChanged', sessionId: 's2' })
    panel.openPanel('s2', 'preview')
    log.publish({ type: 'SessionHistoryReplaced' })
    assert.equal(panel.getActivePanel('s2'), null)
    panel.dispose()
  })
})
