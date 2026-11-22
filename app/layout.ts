import { create } from 'zustand'

/** 窗口布局状态：桌面端侧边栏默认展开，每次启动保持打开 */
export const useLayout = create(() => ({
  siderCollapsed: false,
}))

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  useLayout.setState({ siderCollapsed })
}
