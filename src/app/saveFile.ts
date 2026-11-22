import { isDesktopApp, saveFileWithDialog } from '../platform/desktop.js'

const triggerBrowserDownload = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  // 留出时间让浏览器开始下载再释放
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 交给用户保存文件：桌面端弹出系统保存对话框（取消不算失败），网页端触发下载 */
export const saveFile = async (name: string, blob: Blob) => {
  if (isDesktopApp) {
    await saveFileWithDialog(name, blob)
    return
  }
  triggerBrowserDownload(name, blob)
}
