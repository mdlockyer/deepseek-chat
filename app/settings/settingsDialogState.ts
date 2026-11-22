import { create } from 'zustand'
import { account } from '../composition.js'

/** 设置弹窗的分组：通用设置 / API 密钥 / 数据管理 */
export type SettingsSection = 'general' | 'apiKey' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

/** 快捷键/菜单触发：仅在弹窗未打开时切到通用设置，避免覆盖用户当前正在看的分组 */
export const openSettingsFromShortcut = () => {
  if (!useSettingsDialog.getState().open) {
    openSettings('general')
  }
}

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有 API Key 时打开设置并选中「API 密钥」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (account.getApiKey()) {
    return true
  }
  openSettings('apiKey')
  return false
}
