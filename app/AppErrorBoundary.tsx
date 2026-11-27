import { Component, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-chat/lib-ui'
import { useLocale, type Locale } from '@deepseek-chat/spine/i18n'
import { translate } from './i18n/index.js'
import styles from './App.module.css'

type BoundaryProps = {
  children: ReactNode
  /** 传入会话 ID 等标识：切换时自动清除已捕获的错误状态 */
  resetKey?: string | null
  fullScreen?: boolean
  locale: Locale
}

type State = {
  hasError: boolean
}

class ErrorBoundaryInner extends Component<BoundaryProps, State> {
  override state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  override componentDidUpdate(prevProps: BoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  private readonly handleRetry = () => {
    this.setState({ hasError: false })
  }

  private readonly handleReload = () => {
    window.location.reload()
  }

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children
    }
    const { locale } = this.props
    return (
      <div
        className={clsx(styles.errorBoundary, this.props.fullScreen && styles.errorBoundaryFull)}
        role="alert"
      >
        <h2 className={styles.errorTitle}>{translate(locale, 'errorBoundaryTitle')}</h2>
        <p className={styles.errorDescription}>{translate(locale, 'errorBoundaryDescription')}</p>
        <div className={styles.errorActions}>
          <Button variant="outlined" size="m" onClick={this.handleRetry}>
            {translate(locale, 'retry')}
          </Button>
          <Button variant="primary" size="m" onClick={this.handleReload}>
            {translate(locale, 'errorBoundaryReload')}
          </Button>
        </div>
      </div>
    )
  }
}

export const AppErrorBoundary = (props: Omit<BoundaryProps, 'locale'>) => {
  const locale = useLocale()
  return <ErrorBoundaryInner {...props} locale={locale} />
}
