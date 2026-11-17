import { useEffect, useState } from 'react'

/** 与 theme.css 的 --ds-transition-duration-panel 一致：面板退场动画的播放时长 */
export const PANEL_DURATION_MS = 280

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * 为条件渲染的浮层保留退场动画的播放时间：open 变 false 后继续渲染 duration
 * 毫秒（exiting 为 true，供退场动画类名使用），到时再卸载。
 * 系统「减弱动态效果」时立即卸载，不播放退场。
 */
export const usePresence = (open: boolean, duration: number) => {
  const [mounted, setMounted] = useState(open)
  // 打开时同步置为 mounted，确保入场首帧立即渲染（避免异步 useEffect 晚一帧闪烁）
  if (open && !mounted) {
    setMounted(true)
  }

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    if (duration <= 0 || window.matchMedia(REDUCED_MOTION_QUERY).matches) {
      setMounted(false)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), duration)
    return () => window.clearTimeout(timer)
  }, [open, duration])

  return { mounted, exiting: mounted && !open }
}
