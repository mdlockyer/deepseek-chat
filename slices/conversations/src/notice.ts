import { showToast } from '@deepseek-chat/spine/design'
import { translate, type LinkedMessage } from './messages.js'

/** Shows one of this slice's notices as a toast, translated when shown (follows the locale). */
export const showNotice = (notice: LinkedMessage) => {
  const { key, params, type, link } = notice
  showToast({
    text: () => translate(key, params),
    ...(type === 'error' ? { tone: 'error' as const } : {}),
    ...(link ? { link: { text: () => translate(link.key), href: link.href } } : {}),
  })
}
