import { defineMessages } from '@deepseek-chat/spine/i18n'

export const markdownMessages = defineMessages({
  'zh-CN': {
    copy: '复制',
    copied: '已复制',
    copyFailed: '复制失败，请长按或选中文本后复制',
    mermaidDiagram: '图表',
    mermaidCode: '代码',
    mermaidEmpty: '图表为空',
    mermaidLoading: '图表生成中...',
    mermaidRenderFail: '渲染失败',
    mermaidSwitchLabel: 'Mermaid 图表与代码切换',
  },
  'en-US': {
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed. Please long-press or select the text to copy.',
    mermaidDiagram: 'Diagram',
    mermaidCode: 'Code',
    mermaidEmpty: 'This diagram is empty.',
    mermaidLoading: 'Rendering diagram...',
    mermaidRenderFail: 'Mermaid rendering failed.',
    mermaidSwitchLabel: 'Toggle between Mermaid diagram and code',
  },
})
