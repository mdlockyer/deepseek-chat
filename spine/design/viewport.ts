import { useSyncExternalStore } from 'react'

/** 窄于 768px 按移动端布局 */
const MOBILE_QUERY = 'not all and (min-width: 768px)'

let query: MediaQueryList | null = null
const getQuery = () => {
  query ??= window.matchMedia(MOBILE_QUERY)
  return query
}

const subscribe = (onChange: () => void) => {
  const media = getQuery()
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export const useIsMobile = () =>
  useSyncExternalStore(
    subscribe,
    () => getQuery().matches,
    () => false
  )
