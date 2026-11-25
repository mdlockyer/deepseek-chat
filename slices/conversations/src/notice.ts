import { noopNoticePort } from '@deepseek-chat/spine/ports'
import { deps } from './env.js'
import { translate, type LinkedMessage } from './messages.js'

/** Shows one of this slice's notices via the injected NoticePort, translated when shown. */
export const showNotice = (notice: LinkedMessage) => {
  const { key, params, type, link } = notice
  ;(deps().notify ?? noopNoticePort).show({
    text: () => translate(key, params),
    ...(type === 'error' ? { tone: 'error' as const } : {}),
    ...(link ? { link: { text: () => translate(link.key), href: link.href } } : {}),
  })
}
