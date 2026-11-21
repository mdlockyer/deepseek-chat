import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defineMessages, getLocale, setLocale, subscribeLocale } from '@deepseek-chat/spine/i18n'

const messages = defineMessages({
  'zh-CN': { greet: '你好，{name}', count: '{n} 条', literal: '{unknown} 保留' },
  'en-US': { greet: 'Hello, {name}', count: '{n} items', literal: '{unknown} kept' },
})

afterEach(() => setLocale('en-US'))

describe('spine i18n', () => {
  it('translates with the locale current at call time', () => {
    setLocale('en-US')
    assert.equal(messages.translate('greet', { name: 'Ada' }), 'Hello, Ada')
    setLocale('zh-CN')
    assert.equal(messages.translate('greet', { name: 'Ada' }), '你好，Ada')
  })

  it('fills numeric params and leaves unknown placeholders as written', () => {
    assert.equal(messages.translate('count', { n: 3 }), '3 items')
    assert.equal(messages.translate('literal'), '{unknown} kept')
  })

  it('keeps catalogues independent: two slices may use the same key', () => {
    const other = defineMessages({
      'zh-CN': { greet: '嗨' },
      'en-US': { greet: 'Hi' },
    })
    assert.equal(other.translate('greet'), 'Hi')
    assert.equal(messages.translate('greet', { name: 'B' }), 'Hello, B')
  })

  it('notifies subscribers once per actual change', () => {
    const seen: string[] = []
    const unsubscribe = subscribeLocale(() => seen.push(getLocale()))
    setLocale('zh-CN')
    setLocale('zh-CN')
    setLocale('en-US')
    unsubscribe()
    setLocale('zh-CN')

    assert.deepEqual(seen, ['zh-CN', 'en-US'])
  })

  it('rejects an unsupported locale and keeps the current one', () => {
    setLocale('zh-CN')
    assert.throws(() => setLocale('fr-FR' as never), /Unsupported locale: fr-FR/)
    assert.equal(getLocale(), 'zh-CN')
  })

  it('recognises its own keys only', () => {
    assert.equal(messages.has('greet'), true)
    assert.equal(messages.has('missing'), false)
    assert.equal(messages.has('hasOwnProperty'), false)
  })

  it('renders through useTranslate in the current locale', () => {
    const View = () => messages.useTranslate()('greet', { name: 'UI' })
    setLocale('zh-CN')
    assert.equal(renderToStaticMarkup(createElement(View)), '你好，UI')
  })
})
