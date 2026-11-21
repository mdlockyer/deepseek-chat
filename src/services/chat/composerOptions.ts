import { create } from 'zustand'
import { localStore } from '../../app/storage.js'

/** 输入框的四个开关：深度思考、智能搜索、运行代码、内置浏览器；存 localStorage，沿用原有键名 */
type ComposerOptions = {
  thinking: boolean
  search: boolean
  python: boolean
  browser: boolean
}

const KEYS = {
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  python: 'chat-demo:python',
  browser: 'chat-demo:browser',
} as const

export const useComposerOptions = create<ComposerOptions>(() => ({
  thinking: localStore.get(KEYS.thinking) === 'true',
  search: localStore.get(KEYS.search) === 'true',
  python: localStore.get(KEYS.python) === 'true',
  browser: localStore.get(KEYS.browser) === 'true',
}))

const setter = (key: keyof ComposerOptions) => (value: boolean) => {
  localStore.set(KEYS[key], String(value))
  useComposerOptions.setState({ [key]: value })
}

export const setThinking = setter('thinking')
export const setSearch = setter('search')
export const setPython = setter('python')
export const setBrowser = setter('browser')
