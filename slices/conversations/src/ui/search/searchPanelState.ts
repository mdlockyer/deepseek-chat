import { create } from 'zustand'
import { deps } from '../../env.js'
import type { Source } from '../../view.js'

/** 右侧「搜索结果」面板：同一入口再次点击收起，换入口时替换内容，与浏览器、文件预览共用右侧栏位 */
type SearchPanelState = {
  /** 打开面板的入口，用于判断再次点击是否收起 */
  entry: string | null
  sources: Source[]
  /** 切换到其他右侧面板前保留最近一次结果，方便返回查看 */
  lastEntry: string | null
  lastSources: Source[]
}

export const useSearchPanel = create<SearchPanelState>(() => ({
  entry: null,
  sources: [],
  lastEntry: null,
  lastSources: [],
}))

const slot = () => deps().ui.panels.search
const activeSessionId = () => slot().getLayout().activeSessionId

/** 面板换成其他内容（或关闭）时，把当前结果收进「最近一次」（创建 slice 时调用一次） */
export const bindSearchPanel = () => {
  let wasOpen = slot().isOpen(activeSessionId())
  let lastSession = activeSessionId()
  return slot().subscribe(() => {
    const sessionId = activeSessionId()
    const open = slot().isOpen(sessionId)
    if (sessionId && sessionId === lastSession && wasOpen && !open) {
      useSearchPanel.setState((curr) =>
        curr.entry
          ? { entry: null, sources: [], lastEntry: curr.entry, lastSources: curr.sources }
          : curr
      )
    }
    wasOpen = open
    lastSession = sessionId
  })
}

export const toggleSearchPanel = (entry: string, sources: Source[]) => {
  const current = useSearchPanel.getState()
  const sessionId = activeSessionId()
  if (current.entry === entry && sessionId && slot().isOpen(sessionId)) {
    slot().close(sessionId)
    useSearchPanel.setState({ entry: null, sources: [] })
    return
  }
  if (sessionId) {
    slot().open(sessionId)
  }
  useSearchPanel.setState({ entry, sources, lastEntry: entry, lastSources: sources })
}

export const restoreLastSearchPanel = () => {
  const { lastEntry, lastSources } = useSearchPanel.getState()
  const sessionId = activeSessionId()
  if (!lastEntry || lastSources.length === 0 || !sessionId) {
    return
  }
  slot().open(sessionId)
  useSearchPanel.setState({ entry: lastEntry, sources: lastSources })
}

export const closeSearchPanel = () => {
  const sessionId = activeSessionId()
  if (sessionId) {
    slot().close(sessionId)
  }
  useSearchPanel.setState({ entry: null, sources: [], lastEntry: null, lastSources: [] })
}
