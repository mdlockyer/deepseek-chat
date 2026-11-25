import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLocale } from '@deepseek-chat/spine/i18n'
import { createTestSlice } from './harness.js'

const renderWithEnglish = (render: () => string): string => {
  setLocale('en-US')
  return render()
}

describe('conversations: permanent top-right Settings & first-launch chrome', () => {
  it('omits Settings from Sider now that Settings lives permanently in the top-right header', async () => {
    const slice = createTestSlice()
    await slice.commands.init()

    const html = renderWithEnglish(() =>
      renderToStaticMarkup(createElement(slice.Sider, { collapsed: false }))
    )

    assert.match(html, /New chat/)
    assert.doesNotMatch(html, /aria-label="Settings"/)
    assert.doesNotMatch(html, />Settings</)
    slice.dispose()
  })

  it('renders top-right Settings and the missing API key cue on Welcome when no key is set, and hides the cue once configured', async () => {
    const needsKeySlice = createTestSlice({
      getApiKey: () => null,
      ui: {
        voice: null,
        useNeedsApiKey: () => true,
        openSettings: () => {},
        openInApp: null,
        saveFile: async () => {},
        setSiderCollapsed: () => {},
      },
    })
    await needsKeySlice.commands.init()

    const htmlNeedsKey = renderWithEnglish(() =>
      renderToStaticMarkup(createElement(needsKeySlice.ChatMain, { siderMode: 'absent' }))
    )
    assert.match(htmlNeedsKey, /<button[^>]*aria-label="Settings"/)
    assert.match(htmlNeedsKey, /Add a DeepSeek API key to start chatting/)
    assert.match(htmlNeedsKey, /How can I help you\?/)

    const hasKeySlice = createTestSlice({
      getApiKey: () => 'sk-configured',
      ui: {
        voice: null,
        useNeedsApiKey: () => false,
        openSettings: () => {},
        openInApp: null,
        saveFile: async () => {},
        setSiderCollapsed: () => {},
      },
    })
    await hasKeySlice.commands.init()

    const htmlHasKey = renderWithEnglish(() =>
      renderToStaticMarkup(createElement(hasKeySlice.ChatMain, { siderMode: 'absent' }))
    )
    assert.match(htmlHasKey, /<button[^>]*aria-label="Settings"/)
    assert.doesNotMatch(htmlHasKey, /Add a DeepSeek API key to start chatting/)

    needsKeySlice.dispose()
    hasKeySlice.dispose()
  })

  it('keeps Settings in the top-right header of SessionView alongside session actions and during loading', async () => {
    const SampleAction = ({ sessionId }: { readonly sessionId: string }) =>
      createElement('button', { type: 'button', 'aria-label': `Files ${sessionId}` }, 'Files')

    const slice = createTestSlice({
      ui: {
        voice: null,
        headerActions: [SampleAction],
        openSettings: () => {},
        openInApp: null,
        saveFile: async () => {},
        setSiderCollapsed: () => {},
      },
    })

    // Before init() finishes, loading header still keeps Settings accessible in the top-right.
    const loadingHtml = renderWithEnglish(() =>
      renderToStaticMarkup(createElement(slice.ChatMain, { siderMode: 'absent' }))
    )
    assert.match(loadingHtml, /<button[^>]*aria-label="Settings"/)

    await slice.commands.init()
    await slice.replaceSessions(async () => ({
      sessions: [
        {
          id: 's1',
          title: 'Active thread',
          createdAt: 1,
          updatedAt: 2,
          rootMessageId: 'u1',
          messages: [{ id: 'u1', role: 'user', content: 'Hello', files: [], createdAt: 1 }],
        },
      ],
      blobs: [],
    }))
    slice.commands.selectSession('s1')
    // Ensure session cache is populated before static render.
    await new Promise((resolve) => setTimeout(resolve, 10))

    const sessionHtml = renderWithEnglish(() =>
      renderToStaticMarkup(createElement(slice.ChatMain, { siderMode: 'collapsed' }))
    )
    assert.match(sessionHtml, /Active thread/)
    assert.match(sessionHtml, /aria-label="Files s1"/)
    assert.match(sessionHtml, /<button[^>]*aria-label="Settings"/)

    slice.dispose()
  })

  it('renders CollapsedSider controls cleanly in both fade and morph modes', async () => {
    const slice = createTestSlice()
    await slice.commands.init()

    const fadeHtml = renderWithEnglish(() =>
      renderToStaticMarkup(
        createElement(slice.CollapsedSider, { enterMode: 'fade', exitMode: 'fade' })
      )
    )
    assert.match(fadeHtml, /aria-label="Open sidebar"/)
    assert.match(fadeHtml, /aria-label="New chat"/)
    assert.doesNotMatch(fadeHtml, /aria-label="Settings"/)

    slice.dispose()
  })
})
