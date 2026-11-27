import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyDocumentTheme, THEME_ATTR } from '@deepseek-chat/spine/design'
import { noopNoticePort, noopOverlayPort } from '@deepseek-chat/spine/ports'

describe('spine/ports ui host contracts', () => {
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
