import { create } from 'zustand'
import { localStore } from './storage.js'

/** 窗口布局的本机状态：桌面端侧边栏是否收起；存 localStorage，沿用原有键名 */
const SIDER_COLLAPSED_KEY = 'chat-demo:sider-collapsed'

export const useLayout = create(() => ({
  siderCollapsed: localStore.get(SIDER_COLLAPSED_KEY) === 'true',
}))

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  localStore.set(SIDER_COLLAPSED_KEY, String(siderCollapsed))
  useLayout.setState({ siderCollapsed })
}
