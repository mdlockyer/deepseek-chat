import { showToast as showDesignToast } from '@deepseek-chat/spine/design'
import { translate, type LinkedMessage } from '../../i18n/index.js'

/**
 * Legacy toast entry for app-tier code that speaks in keys of the app catalogue. Translation is
 * deferred to render time, so an open toast follows a locale change. Slices call the design
 * `showToast` with their own strings instead.
 */
export const showToast = (message: LinkedMessage | string) => {
  if (typeof message === 'string') {
    showDesignToast({ text: () => message })
    return
  }
  const { key, params, type, link } = message
  showDesignToast({
    text: () => translate(key, params),
    ...(type === 'error' ? { tone: 'error' as const } : {}),
    ...(link ? { link: { text: () => translate(link.key), href: link.href } } : {}),
  })
}
