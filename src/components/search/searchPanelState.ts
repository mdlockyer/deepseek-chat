import { create } from 'zustand'
import type { Source } from '../../services/chat/view.js'
import {
  closeActiveRightPanelKind,
  getActiveRightPanel,
  openRightPanel,
  useSidePanelStore,
} from '../../app/rightPanel/state.js'

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

useSidePanelStore.subscribe((state, prev) => {
  const sessionId = state.activeSessionId
  if (!sessionId) {
    return
  }
  const nextKind = getActiveRightPanel(sessionId, state)
  const prevKind = getActiveRightPanel(sessionId, prev)
  if (prevKind === 'search' && nextKind !== 'search') {
    useSearchPanel.setState((curr) =>
      curr.entry
        ? { entry: null, sources: [], lastEntry: curr.entry, lastSources: curr.sources }
        : curr
    )
  }
})

export const toggleSearchPanel = (entry: string, sources: Source[]) => {
  const current = useSearchPanel.getState()
  const sessionId = useSidePanelStore.getState().activeSessionId
  if (current.entry === entry && sessionId && getActiveRightPanel(sessionId) === 'search') {
    closeActiveRightPanelKind('search')
    useSearchPanel.setState({ entry: null, sources: [] })
    return
  }
  if (sessionId) {
    openRightPanel(sessionId, 'search')
  }
  useSearchPanel.setState({ entry, sources, lastEntry: entry, lastSources: sources })
}

export const restoreLastSearchPanel = () => {
  const { lastEntry, lastSources } = useSearchPanel.getState()
  const sessionId = useSidePanelStore.getState().activeSessionId
  if (!lastEntry || lastSources.length === 0 || !sessionId) {
    return
  }
  openRightPanel(sessionId, 'search')
  useSearchPanel.setState({ entry: lastEntry, sources: lastSources })
}

export const closeSearchPanel = () => {
  closeActiveRightPanelKind('search')
  useSearchPanel.setState({ entry: null, sources: [], lastEntry: null, lastSources: [] })
}
