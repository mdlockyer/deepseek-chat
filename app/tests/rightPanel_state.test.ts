import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { memoryStore } from '@deepseek-chat/test-support'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  DEFAULT_ACTIVITY_PANEL_WIDTH,
  DEFAULT_SIDE_PANEL_WIDTH,
  MIN_ACTIVITY_PANEL_WIDTH,
  clampSidePanelResizeWidth,
  createRightPanelController,
} from '../rightPanel/state.js'

const makeController = (activeSessionId: string | null = 's1') => {
  const log = new EventLog()
  const controller = createRightPanelController(memoryStore(), log)
  controller.setActiveSession(activeSessionId)
  return { controller, log }
}

describe('right panel resize clamping', () => {
  it('clamps resize width between 360px and min(window - 360, 72vw)', () => {
    assert.equal(clampSidePanelResizeWidth(240, 1200), 360)
    assert.equal(clampSidePanelResizeWidth(600.4, 1200), 600)
    assert.equal(clampSidePanelResizeWidth(950, 1200), 840)
    assert.equal(clampSidePanelResizeWidth(1400, 1800), 1296)
    assert.equal(clampSidePanelResizeWidth(500, 600), 360)
    assert.equal(clampSidePanelResizeWidth(240, 1200, MIN_ACTIVITY_PANEL_WIDTH), 320)
  })

  it('defaults activity panel to 400px independent of browser/preview persisted width', () => {
    const store = memoryStore({ 'chat-demo:browser-panel-width': '620' })
    const log = new EventLog()
    const panel = createRightPanelController(store, log)
    panel.setActiveSession('s1')

    assert.equal(panel.getPanelWidth('browser'), 620)
    assert.equal(panel.getPanelWidth('activity'), DEFAULT_ACTIVITY_PANEL_WIDTH)

    panel.openPanel('s1', 'activity')
    assert.equal(panel.createSlot('activity').getLayout().width, DEFAULT_ACTIVITY_PANEL_WIDTH)

    panel.setWidthForKind('activity', 560)
    assert.equal(panel.getPanelWidth('activity'), 560)
    assert.equal(panel.getPanelWidth('browser'), 620)
    assert.equal(
      store.get('chat-demo:browser-panel-width'),
      '620',
      'resizing Activity must not overwrite Browser/Preview persisted width'
    )

    panel.setWidthForKind('browser', DEFAULT_SIDE_PANEL_WIDTH)
    assert.equal(store.get('chat-demo:browser-panel-width'), String(DEFAULT_SIDE_PANEL_WIDTH))
    assert.equal(panel.getPanelWidth('activity'), 560)
    panel.dispose()
  })
})

describe('right-rail coordination (factory-scoped)', () => {
  it('prevents closeActivePanelKind("activity") from closing an open preview or browser panel', () => {
    const { controller: panel } = makeController('s1')
    panel.openPanel('s1', 'preview')
    assert.equal(panel.getActivePanel('s1'), 'preview')

    panel.closeActivePanelKind('activity')
    assert.equal(panel.getActivePanel('s1'), 'preview')

    panel.openPanel('s1', 'activity')
    assert.equal(panel.getActivePanel('s1'), 'activity')

    panel.closeActivePanelKind('activity')
    assert.equal(panel.getActivePanel('s1'), null)
    panel.dispose()
  })

  it('politely reveals when idle, never hijacks an open panel or user dismissal, and resets on a new reply', () => {
    const { controller: panel, log } = makeController('s1')
    const browserSlot = panel.createSlot('browser')
    const activitySlot = panel.createSlot('activity')

    // Idle session: polite reveal opens browser automatically.
    browserSlot.reveal?.('s1')
    assert.equal(panel.getActivePanel('s1'), 'browser')

    // User switches to Activity -> subsequent browser reveals must NOT hijack it.
    activitySlot.open('s1')
    assert.equal(panel.getActivePanel('s1'), 'activity')
    browserSlot.reveal?.('s1')
    assert.equal(panel.getActivePanel('s1'), 'activity')

    // User closes the panel -> polite reveal stays quiet for the rest of this turn.
    activitySlot.close('s1')
    assert.equal(panel.getActivePanel('s1'), null)
    browserSlot.reveal?.('s1')
    assert.equal(panel.getActivePanel('s1'), null)

    // New reply starts -> policy resets so polite reveal works once again when idle.
    log.publish({
      type: 'ReplyLifecycleChanged',
      sessionId: 's1',
      messageId: 'm2',
      phase: 'started',
    })
    browserSlot.reveal?.('s1')
    assert.equal(panel.getActivePanel('s1'), 'browser')

    // If user keeps Activity open across turns, new reply still does not displace Activity.
    activitySlot.open('s1')
    log.publish({
      type: 'ReplyLifecycleChanged',
      sessionId: 's1',
      messageId: 'm3',
      phase: 'started',
    })
    browserSlot.reveal?.('s1')
    assert.equal(panel.getActivePanel('s1'), 'activity')

    panel.dispose()
  })

  it('fires shared overlay lock listeners only on 0->1 and 1->0 transitions', () => {
    const { controller: panel } = makeController('s1')
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

  it('signals panelAnimating consistently on open, close, cross-width kind switches, programmatic resizes, and session switches', () => {
    const { controller: panel } = makeController('s1')
    const isAnimating = () => panel.useStore.getState().panelAnimating

    // Closed -> Open animates.
    panel.openPanel('s1', 'browser')
    assert.equal(isAnimating(), true)
    panel.setAnimating(false)

    // Open -> Open with identical width (browser 540 -> preview 540) does NOT wait on width transition.
    panel.openPanel('s1', 'preview')
    assert.equal(isAnimating(), false)

    // Open -> Open across different widths (preview 540 -> activity 400) animates smoothly.
    panel.openPanel('s1', 'activity')
    assert.equal(isAnimating(), true)
    panel.setAnimating(false)

    // Programmatic width toggle (400 -> 560) animates; live pointer drag resize does not.
    panel.setWidthForKind('activity', 560)
    assert.equal(isAnimating(), true)
    panel.setAnimating(false)

    panel.setResizing(true)
    panel.setWidthForKind('activity', 480)
    assert.equal(isAnimating(), false)
    panel.setResizing(false)

    // Switching sessions across different open widths animates; same open width stays steady.
    panel.openPanel('s2', 'browser')
    panel.setActiveSession('s2')
    assert.equal(isAnimating(), true)
    panel.setAnimating(false)

    panel.openPanel('s3', 'preview')
    panel.setActiveSession('s3')
    assert.equal(isAnimating(), false)

    // Open -> Closed animates.
    panel.closePanel('s3', 'preview')
    assert.equal(isAnimating(), true)
    panel.dispose()
  })
})
