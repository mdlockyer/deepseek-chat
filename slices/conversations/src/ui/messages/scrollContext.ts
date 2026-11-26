import { createContext, useContext } from 'react'

/** 渲染更新后请求滚到底部；用户上滑离开底部时由列表忽略 */
export const ScrollToBottomContext = createContext<() => void>(() => {})

export const useScrollToBottom = () => useContext(ScrollToBottomContext)

/**
 * Lets an inline disclosure pause and resume the list's stick-to-bottom behaviour.
 * - `stop`: the reader opened something to read in place; growth must not scroll it away.
 * - `sync`: re-derive following from the current scroll position (follow only when at the bottom).
 */
export type ScrollFollow = { stop: () => void; sync: () => void }

export const ScrollFollowContext = createContext<ScrollFollow>({ stop: () => {}, sync: () => {} })

export const useScrollFollow = () => useContext(ScrollFollowContext)
