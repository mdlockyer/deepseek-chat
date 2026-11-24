import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyDocumentTheme, THEME_ATTR } from '@deepseek-chat/spine/design'
import { memoryNoticePort, noopNoticePort, noopOverlayPort } from '@deepseek-chat/spine/ports'

describe('spine/ports ui host contracts', () => {
  it('records notices in order and exposes latest / clear cleanly', () => {
    const notices = memoryNoticePort()
    assert.equal(notices.latest(), null)
    assert.equal(notices.history.length, 0)

    const first = { text: () => 'Saved' }
    const second = { text: () => 'Failed', tone: 'error' as const }
    notices.show(first)
    notices.show(second)

    assert.equal(notices.latest(), second)
    const snapshot = notices.history
    assert.equal(snapshot.length, 2)
    assert.equal(snapshot[0]?.text(), 'Saved')
    assert.equal(snapshot[1]?.tone, 'error')

    // Returned history array is a defensive snapshot.
    notices.clear()
    assert.equal(notices.latest(), null)
    assert.equal(snapshot.length, 2)
  })

  it('provides safe no-op ports for headless or non-UI hosts', () => {
    assert.doesNotThrow(() => noopNoticePort.show({ text: () => 'ignored' }))
    const release = noopOverlayPort.acquire()
    assert.doesNotThrow(() => {
      release()
      release()
    })
  })
})

describe('spine/design theme contract', () => {
  it('sets both data-theme attribute and color-scheme on the root element', () => {
    const attrs = new Map<string, string>()
    const root = {
      setAttribute: (name: string, value: string) => {
        attrs.set(name, value)
      },
      style: { colorScheme: '' },
    }

    applyDocumentTheme(root, 'dark')
    assert.equal(attrs.get(THEME_ATTR), 'dark')
    assert.equal(root.style.colorScheme, 'dark')

    applyDocumentTheme(root, 'light')
    assert.equal(attrs.get(THEME_ATTR), 'light')
    assert.equal(root.style.colorScheme, 'light')
  })
})
