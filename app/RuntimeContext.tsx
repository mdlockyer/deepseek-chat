import { LocaleProvider } from '@deepseek-chat/spine/i18n'
import { createContext, useContext, type ReactNode } from 'react'
import type { AppRuntime } from './runtime.js'

const AppRuntimeContext = createContext<AppRuntime | null>(null)

export const AppRuntimeProvider = ({
  runtime,
  children,
}: {
  runtime: AppRuntime
  children: ReactNode
}) => (
  <LocaleProvider store={runtime.locale}>
    <AppRuntimeContext.Provider value={runtime}>{children}</AppRuntimeContext.Provider>
  </LocaleProvider>
)

export const useAppRuntime = (): AppRuntime => {
  const runtime = useContext(AppRuntimeContext)
  if (!runtime) {
    throw new Error('useAppRuntime must be used inside <AppRuntimeProvider>.')
  }
  return runtime
}
