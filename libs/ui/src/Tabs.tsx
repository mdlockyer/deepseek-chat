import clsx from 'clsx'
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import styles from './Tabs.module.css'

type TabsContextValue = {
  readonly baseId: string
  readonly value: string
  readonly orientation: 'horizontal' | 'vertical'
  readonly onChange: (value: string) => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

const useTabsContext = (): TabsContextValue => {
  const ctx = useContext(TabsContext)
  if (!ctx) {
    throw new Error('Tab, TabList, and TabPanel must be rendered inside <Tabs>.')
  }
  return ctx
}

export type TabsProps<T extends string = string> = {
  value: T
  onChange: (value: T) => void
  orientation?: 'horizontal' | 'vertical'
  className?: string
  children?: ReactNode
}

/** Accessible Tabs coordinator (`tablist`, roving arrow-key `tab`, and linked `tabpanel`). */
export const Tabs = <T extends string = string>({
  value,
  onChange,
  orientation = 'horizontal',
  className,
  children,
}: TabsProps<T>) => {
  const baseId = useId()
  const handleChange = useCallback((next: string) => onChange(next as T), [onChange])
  const ctx = useMemo<TabsContextValue>(
    () => ({ baseId, value, orientation, onChange: handleChange }),
    [baseId, handleChange, orientation, value]
  )
  return (
    <TabsContext.Provider value={ctx}>
      {className ? <div className={className}>{children}</div> : children}
    </TabsContext.Provider>
  )
}

export type TabListProps = {
  ariaLabel?: string
  className?: string
  children?: ReactNode
}

export const TabList = ({ ariaLabel, className, children }: TabListProps) => {
  const { orientation } = useTabsContext()
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const root = listRef.current
      if (!root) {
        return
      }
      const tabs = Array.from(
        root.querySelectorAll<HTMLButtonElement>('button[role="tab"]:not(:disabled)')
      )
      if (tabs.length === 0) {
        return
      }
      const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
      if (index < 0) {
        return
      }
      const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight'
      const prevKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
      let target: HTMLButtonElement | undefined
      if (event.key === nextKey) {
        target = tabs[(index + 1) % tabs.length]
      } else if (event.key === prevKey) {
        target = tabs[(index - 1 + tabs.length) % tabs.length]
      } else if (event.key === 'Home') {
        target = tabs[0]
      } else if (event.key === 'End') {
        target = tabs.at(-1)
      }
      if (target) {
        event.preventDefault()
        target.focus({ preventScroll: true })
        target.click()
      }
    },
    [orientation]
  )

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      className={clsx(
        styles.list,
        orientation === 'vertical' ? styles.vertical : styles.horizontal,
        className
      )}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}

export type TabProps = {
  value: string
  icon?: ReactNode
  badge?: ReactNode
  disabled?: boolean
  className?: string
  children?: ReactNode
}

export const Tab = ({ value, icon, badge, disabled = false, className, children }: TabProps) => {
  const ctx = useTabsContext()
  const selected = ctx.value === value
  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${ctx.baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      className={clsx(styles.tab, selected && styles.tabSelected, className)}
      onClick={() => {
        if (!disabled) {
          ctx.onChange(value)
        }
      }}
    >
      {icon}
      <span>{children}</span>
      {badge}
    </button>
  )
}

export type TabPanelProps = {
  value: string
  keepMounted?: boolean
  className?: string
  children?: ReactNode
}

export const TabPanel = ({ value, keepMounted = false, className, children }: TabPanelProps) => {
  const ctx = useTabsContext()
  const selected = ctx.value === value
  if (!selected && !keepMounted) {
    return null
  }
  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-panel-${value}`}
      aria-labelledby={`${ctx.baseId}-tab-${value}`}
      hidden={!selected}
      className={clsx(styles.panel, className)}
    >
      {children}
    </div>
  )
}
