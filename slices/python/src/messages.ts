import { defineMessages } from '@deepseek-chat/spine/i18n'

export const pythonMessages = defineMessages({
  'zh-CN': {
    settingsPythonRuntime: 'Python 运行环境',
    settingsPythonRuntimeChecking: '正在检查 Python 环境…',
    settingsPythonRuntimeReady: 'Python {version} · 已就绪（{packages}）',
    settingsPythonRuntimeNotInstalled: 'Python {version} · 首次运行时自动配置',
    settingsPythonRuntimeReset: '重置环境',
    settingsPythonRuntimeResetting: '正在重置…',
    settingsPythonRuntimeResetDone: '已清除 Python 环境，下次运行时将重新配置。',
    settingsPythonRuntimeResetFailed: '重置失败：{message}',
    settingsPythonRuntimeLoadFailed: '无法检查 Python 环境：{message}',
  },
  'en-US': {
    settingsPythonRuntime: 'Python environment',
    settingsPythonRuntimeChecking: 'Checking Python environment…',
    settingsPythonRuntimeReady: 'Python {version} · Ready ({packages})',
    settingsPythonRuntimeNotInstalled: 'Python {version} · Sets up automatically on first use',
    settingsPythonRuntimeReset: 'Reset',
    settingsPythonRuntimeResetting: 'Resetting…',
    settingsPythonRuntimeResetDone: 'Python environment cleared. It will be rebuilt on next use.',
    settingsPythonRuntimeResetFailed: 'Reset failed: {message}',
    settingsPythonRuntimeLoadFailed: 'Unable to check Python environment: {message}',
  },
})
