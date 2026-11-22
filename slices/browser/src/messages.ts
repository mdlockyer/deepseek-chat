import { defineMessages } from '@deepseek-chat/spine/i18n'

export const browserMessages = defineMessages({
  'zh-CN': {
    browserAddressPlaceholder: '输入网址或搜索内容',
    browserAllowLocalhostDescription:
      '开启后模型可在内置浏览器中访问 localhost 与内网服务，存在提示词注入风险。',
    browserAllowLocalhostLabel: '允许模型访问本地网络地址',
    browserAllowLocalhostOff: '仅公网（推荐）',
    browserAllowLocalhostOn: '允许',
    browserBack: '后退',
    browserClearSiteData: '清除网站数据',
    browserCloseTab: '关闭标签页',
    browserControlling: 'DeepSeek 控制中',
    browserDownloadBlocked: '内置浏览器出于安全考虑已拦截自动下载',
    browserEmptyDescription:
      '在上方输入网址，或开启输入框中的「浏览器」开关让 DeepSeek 自动浏览网页。',
    browserEmptyTitle: '内置浏览器',
    browserForward: '前进',
    browserMoreActions: '更多操作',
    browserNavigationBlocked: '已拦截不安全导航（{url}）：{reason}',
    browserNewTab: '新标签页',
    browserOpenDevtools: '网页检查器',
    browserOpenExternal: '在默认浏览器中打开',
    browserReload: '刷新',
    browserStopLoad: '停止加载',
    browserTakeOver: '接管',
    closeBrowser: '关闭浏览器',
  },
  'en-US': {
    browserAddressPlaceholder: 'Enter URL or search',
    browserAllowLocalhostDescription:
      'Lets DeepSeek navigate the built-in browser to localhost and private network addresses.',
    browserAllowLocalhostLabel: 'Allow model access to localhost',
    browserAllowLocalhostOff: 'Public only',
    browserAllowLocalhostOn: 'Allowed',
    browserBack: 'Back',
    browserClearSiteData: 'Clear website data',
    browserCloseTab: 'Close tab',
    browserControlling: 'DeepSeek controlling',
    browserDownloadBlocked:
      'Automatic downloads inside the built-in browser are blocked for safety',
    browserEmptyDescription:
      'Enter a URL above, or enable Browser in the composer so DeepSeek can open and control pages here.',
    browserEmptyTitle: 'Built-in browser',
    browserForward: 'Forward',
    browserMoreActions: 'Browser actions',
    browserNavigationBlocked: 'Blocked navigation ({url}): {reason}',
    browserNewTab: 'New tab',
    browserOpenDevtools: 'Inspect element',
    browserOpenExternal: 'Open in default browser',
    browserReload: 'Reload',
    browserStopLoad: 'Stop loading',
    browserTakeOver: 'Take over',
    closeBrowser: 'Close browser',
  },
})
