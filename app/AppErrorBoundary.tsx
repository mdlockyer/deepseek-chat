import { Component, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-chat/spine/design'
import { translate } from './i18n/index.js'
import styles from './App.module.css'

type Props = {
  children: ReactNode
  /** 传入会话 ID 等标识：切换时自动清除已捕获的错误状态 */
  resetKey?: string | null
  fullScreen?: boolean
}

type State = {
  hasError: boolean
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  override componentDidUpdate(prevProps: Props): void {
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
    return (
      <div
        className={clsx(styles.errorBoundary, this.props.fullScreen && styles.errorBoundaryFull)}
        role="alert"
      >
        <h2 className={styles.errorTitle}>{translate('errorBoundaryTitle')}</h2>
        <p className={styles.errorDescription}>{translate('errorBoundaryDescription')}</p>
        <div className={styles.errorActions}>
          <Button variant="outlined" size="m" onClick={this.handleRetry}>
            {translate('retry')}
          </Button>
          <Button variant="primary" size="m" onClick={this.handleReload}>
            {translate('errorBoundaryReload')}
          </Button>
        </div>
      </div>
    )
  }
}
