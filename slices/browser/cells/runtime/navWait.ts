import {
  findTabOwner,
  type BrowserKernelState,
  type NavigationWatch,
  type WaitForNavigationOptions,
} from '../../kernel/index.js'

type NavWaitPhase =
  | { readonly kind: 'watching' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'settled' }

export const createNavWaitTracker = (getState: () => BrowserKernelState) => {
  const loadWaiters = new Map<string, Set<() => void>>()
  const navCompletedSeq = new Map<string, number>()
  const navListeners = new Map<string, Set<() => void>>()

  const notifyNavListeners = (tabId: string) => {
    const listeners = navListeners.get(tabId)
    if (!listeners) {
      return
    }
    for (const listener of [...listeners]) {
      listener()
    }
  }

  const resolveLoadWaiters = (tabId: string) => {
    const waiters = loadWaiters.get(tabId)
    if (!waiters) {
      return
    }
    loadWaiters.delete(tabId)
    for (const resolve of waiters) {
      resolve()
    }
  }

  const markLoadCompleted = (tabId: string) => {
    navCompletedSeq.set(tabId, (navCompletedSeq.get(tabId) ?? 0) + 1)
    resolveLoadWaiters(tabId)
  }

  const clearTab = (tabId: string) => {
    resolveLoadWaiters(tabId)
    notifyNavListeners(tabId)
    navListeners.delete(tabId)
    navCompletedSeq.delete(tabId)
  }

  const beginNavigationWatch = (tabId: string): NavigationWatch => {
    const owner = findTabOwner(getState(), tabId)
    return {
      tabId,
      startUrl: owner?.tab.url ?? '',
      startCompletedSeq: navCompletedSeq.get(tabId) ?? 0,
    }
  }

  const waitForNavigation = (
    watch: NavigationWatch,
    options: WaitForNavigationOptions
  ): Promise<{ readonly navigated: boolean }> => {
    const {
      expectsNavigation,
      settleMs,
      startWindowMs = 2_000,
      loadTimeoutMs = 10_000,
      signal,
    } = options
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }

    return new Promise((resolve, reject) => {
      let phase: NavWaitPhase = { kind: 'watching' }
      let startTimer: ReturnType<typeof setTimeout> | null = null
      let loadTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (startTimer !== null) {
          clearTimeout(startTimer)
          startTimer = null
        }
        if (loadTimer !== null) {
          clearTimeout(loadTimer)
          loadTimer = null
        }
        signal.removeEventListener('abort', onAbort)
        navListeners.get(watch.tabId)?.delete(checkState)
      }

      const finish = (navigated: boolean) => {
        if (phase.kind === 'settled') {
          return
        }
        phase = { kind: 'settled' }
        cleanup()
        resolve({ navigated })
      }

      const enterLoading = () => {
        if (phase.kind !== 'watching') {
          return
        }
        if (startTimer !== null) {
          clearTimeout(startTimer)
          startTimer = null
        }
        phase = { kind: 'loading' }
        loadTimer = setTimeout(() => {
          finish(true)
        }, loadTimeoutMs)
      }

      const checkState = () => {
        if (phase.kind === 'settled') {
          return
        }
        const tab = findTabOwner(getState(), watch.tabId)?.tab
        if (!tab) {
          finish(false)
          return
        }
        if (phase.kind === 'watching') {
          if (tab.isLoading) {
            enterLoading()
            return
          }
          const completed = (navCompletedSeq.get(watch.tabId) ?? 0) > watch.startCompletedSeq
          if (completed || (watch.startUrl !== '' && tab.url !== watch.startUrl)) {
            finish(true)
          }
        } else if (!tab.isLoading) {
          finish(true)
        }
      }

      const onAbort = () => {
        if (phase.kind === 'settled') {
          return
        }
        phase = { kind: 'settled' }
        cleanup()
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }

      let listeners = navListeners.get(watch.tabId)
      if (!listeners) {
        listeners = new Set()
        navListeners.set(watch.tabId, listeners)
      }
      listeners.add(checkState)
      signal.addEventListener('abort', onAbort, { once: true })

      checkState()
      if (phase.kind === 'watching') {
        startTimer = setTimeout(
          () => {
            finish(false)
          },
          expectsNavigation ? startWindowMs : settleMs
        )
      }
    })
  }

  const waitForTabLoad = (
    tabId: string,
    signal: AbortSignal,
    timeoutMs = 15_000
  ): Promise<void> => {
    const owner = findTabOwner(getState(), tabId)
    const tab = owner?.tab
    if (!tab || !tab.isLoading) {
      return Promise.resolve()
    }
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        loadWaiters.get(tabId)?.delete(onDone)
      }
      const onDone = () => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve()
      }
      const onAbort = () => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      const timer = setTimeout(() => {
        // Timed out waiting for full network load; resolve so snapshot can inspect partially rendered SPAs
        onDone()
      }, timeoutMs)
      let setForTab = loadWaiters.get(tabId)
      if (!setForTab) {
        setForTab = new Set()
        loadWaiters.set(tabId, setForTab)
      }
      setForTab.add(onDone)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    notifyNavListeners,
    resolveLoadWaiters,
    markLoadCompleted,
    clearTab,
    beginNavigationWatch,
    waitForNavigation,
    waitForTabLoad,
  }
}
