import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createLocaleStore, defineMessages, LocaleProvider } from '@deepseek-chat/spine/i18n'

const messages = defineMessages({
  'zh-CN': { greet: '你好，{name}', count: '{n} 条', literal: '{unknown} 保留' },
  'en-US': { greet: 'Hello, {name}', count: '{n} items', literal: '{unknown} kept' },
})

describe('spine i18n', () => {
  it('translates for the explicit locale and lazy thunks', () => {
    assert.equal(messages.translate('en-US', 'greet', { name: 'Ada' }), 'Hello, Ada')
    assert.equal(messages.translate('zh-CN', 'greet', { name: 'Ada' }), '你好，Ada')
    const lazy = messages.lazy('greet', { name: 'Ada' })
    assert.equal(lazy(), 'Hello, Ada')
    assert.equal(lazy('zh-CN'), '你好，Ada')
  })

  it('fills numeric params and leaves unknown placeholders as written', () => {
    assert.equal(messages.translate('en-US', 'count', { n: 3 }), '3 items')
    assert.equal(messages.translate('en-US', 'literal'), '{unknown} kept')
  })

  it('keeps catalogues independent: two slices may use the same key', () => {
    const other = defineMessages({
      'zh-CN': { greet: '嗨' },
      'en-US': { greet: 'Hi' },
    })
    assert.equal(other.translate('en-US', 'greet'), 'Hi')
    assert.equal(messages.translate('en-US', 'greet', { name: 'B' }), 'Hello, B')
  })

  it('keeps separate LocaleStore instances completely isolated', () => {
    const storeA = createLocaleStore('en-US')
    const storeB = createLocaleStore('en-US')
    const seenA: string[] = []
    const seenB: string[] = []
    const unsubA = storeA.subscribe(() => seenA.push(storeA.get()))
    const unsubB = storeB.subscribe(() => seenB.push(storeB.get()))

    storeA.set('zh-CN')
    storeA.set('zh-CN')
    assert.equal(storeA.get(), 'zh-CN')
    assert.equal(storeB.get(), 'en-US')
    assert.deepEqual(seenA, ['zh-CN'])
    assert.deepEqual(seenB, [])

    storeA.set('en-US')
    unsubA()
    unsubB()
    storeA.set('zh-CN')
    assert.deepEqual(seenA, ['zh-CN', 'en-US'])
  })

  it('rejects an unsupported locale and keeps the current one', () => {
    assert.throws(() => createLocaleStore('fr-FR' as never), /Unsupported locale: fr-FR/)
    const store = createLocaleStore('zh-CN')
    assert.throws(() => store.set('fr-FR' as never), /Unsupported locale: fr-FR/)
    assert.equal(store.get(), 'zh-CN')
  })

  it('recognises its own keys only', () => {
    assert.equal(messages.has('greet'), true)
    assert.equal(messages.has('missing'), false)
    assert.equal(messages.has('hasOwnProperty'), false)
  })

  it('renders through useTranslate using the nearest LocaleProvider without global bleed', () => {
    const View = () => messages.useTranslate()('greet', { name: 'UI' })
    const zhStore = createLocaleStore('zh-CN')
    const enStore = createLocaleStore('en-US')
    assert.equal(
      renderToStaticMarkup(createElement(LocaleProvider, { store: zhStore }, createElement(View))),
      '你好，UI'
    )
    assert.equal(
      renderToStaticMarkup(createElement(LocaleProvider, { store: enStore }, createElement(View))),
      'Hello, UI'
    )
  })
})
