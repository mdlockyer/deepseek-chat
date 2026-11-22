import { create } from 'zustand'
import { deps } from './env.js'

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
  thinking: false,
  search: false,
  python: false,
  browser: false,
}))

/** 读取已保存的开关（创建 slice 时调用一次） */
export const hydrateComposerOptions = () => {
  const { store } = deps()
  useComposerOptions.setState({
    thinking: store.get(KEYS.thinking) === 'true',
    search: store.get(KEYS.search) === 'true',
    python: store.get(KEYS.python) === 'true',
    browser: store.get(KEYS.browser) === 'true',
  })
}

const setter = (key: keyof ComposerOptions) => (value: boolean) => {
  deps().store.set(KEYS[key], String(value))
  useComposerOptions.setState({ [key]: value })
}

export const setThinking = setter('thinking')
export const setSearch = setter('search')
export const setPython = setter('python')
export const setBrowser = setter('browser')
