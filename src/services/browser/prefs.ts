import { create } from 'zustand'
import { localStore } from '../../app/storage.js'

/** 内置浏览器的本机偏好；存 localStorage，沿用原有键名 */
const ALLOW_LOCALHOST_KEY = 'chat-demo:browser-allow-localhost'

export const useBrowserPrefs = create(() => ({
  allowLocalhost: localStore.get(ALLOW_LOCALHOST_KEY) === 'true',
}))

export const setBrowserAllowLocalhost = (allowLocalhost: boolean) => {
  localStore.set(ALLOW_LOCALHOST_KEY, String(allowLocalhost))
  useBrowserPrefs.setState({ allowLocalhost })
}
