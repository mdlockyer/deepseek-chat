import type { NoticePort } from '@deepseek-chat/spine/ports'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { VoiceAudio } from './audio.js'
import { voiceMessages, type VoiceMessageKey } from './messages.js'
import { startRecording, type Recording } from './recorder.js'
import type { SpeechApi } from './speechApi.js'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

export type VoiceInputDeps = {
  api: SpeechApi
  audio: VoiceAudio
  apiKey: () => string | null
  notify: NoticePort
}

const describeRecordingError = (error: unknown): VoiceMessageKey => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'voiceInputPermissionDenied'
    }
    if (error.name === 'NotFoundError') {
      return 'voiceInputNoDevice'
    }
  }
  return 'voiceInputFailed'
}

/**
 * 语音输入（oneshot）：toggle 开始录音，再次 toggle 结束并转写，结果交给 onText。
 * 转写中再次 toggle 取消。录满 120 秒自动结束。
 * 每次开始或取消都换一个 operation 编号，迟到的异步结果按编号丢弃。
 */
export const createVoiceInput = (deps: VoiceInputDeps, onText: (text: string) => void) => {
  const toast = (key: VoiceMessageKey) =>
    deps.notify.show({ text: () => voiceMessages.translate(key) })
  /**
   * 录音依赖 getUserMedia，只在安全上下文可用（HTTPS、localhost、file://）。
   * 普通 HTTP 页面上直接禁用入口，避免点击后必然失败。
   */
  const available = deps.audio.secureContext
  let status: VoiceInputStatus = 'idle'
  let recording: Recording | null = null
  let controller: AbortController | null = null
  let operation = 0
  const listeners = new Set<() => void>()

  const setStatus = (next: VoiceInputStatus) => {
    if (next === status) {
      return
    }
    status = next
    for (const listener of [...listeners]) {
      listener()
    }
  }

  /** 作废当前操作并释放麦克风、中止转写；不改状态（卸载时用） */
  const dispose = () => {
    operation++
    recording?.cancel()
    recording = null
    controller?.abort()
    controller = null
  }

  const cancel = () => {
    dispose()
    setStatus('idle')
  }

  const finish = async () => {
    const current = recording
    if (!current) {
      // 仍在等待麦克风授权时也允许取消；迟到的录音对象会立即释放。
      cancel()
      return
    }
    const op = operation
    recording = null
    let own: AbortController | null = null
    try {
      let audio: Blob | null
      try {
        audio = await current.stop()
      } finally {
        current.cancel()
      }
      if (operation !== op || !audio) {
        return
      }
      own = new AbortController()
      controller = own
      setStatus('transcribing')
      const text = await deps.api.transcribe(deps.apiKey() ?? '', audio, own.signal)
      if (own.signal.aborted || operation !== op) {
        return
      }
      if (text.trim()) {
        onText(text.trim())
      } else {
        toast('voiceInputEmpty')
      }
    } catch {
      if (operation === op && !own?.signal.aborted) {
        toast('voiceInputFailed')
      }
    } finally {
      if (operation === op) {
        controller = null
        setStatus('idle')
      }
    }
  }

  const toggle = async () => {
    if (!available) {
      return
    }
    if (status === 'recording') {
      await finish()
      return
    }
    if (status === 'transcribing') {
      cancel()
      return
    }
    const op = ++operation
    setStatus('recording')
    try {
      const started = await startRecording(deps.audio, () => {
        if (operation === op) {
          toast('voiceInputLimitReached')
          void finish()
        }
      })
      if (operation !== op) {
        started.cancel()
        return
      }
      recording = started
    } catch (error) {
      if (operation === op) {
        setStatus('idle')
        toast(describeRecordingError(error))
      }
    }
  }

  return {
    available,
    toggle,
    cancel,
    dispose,
    getStatus: () => status,
    /** 当前录音的频谱分析节点，未录音时为 null */
    getAnalyser: () => recording?.analyser ?? null,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type VoiceInput = ReturnType<typeof createVoiceInput>

/** React binding: one voice input per component; released on unmount. */
export const createUseVoiceInput = (deps: VoiceInputDeps) => (onText: (text: string) => void) => {
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const [input] = useState(() => createVoiceInput(deps, (text) => onTextRef.current(text)))
  const status = useSyncExternalStore(input.subscribe, input.getStatus, input.getStatus)
  /** 本次录音已录秒数，只在录音中递增 */
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = Date.now()
    setSeconds(0)
    // 半秒刷新一次，让显示的秒数与实际录音时长保持一致
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => input.dispose, [input])

  return {
    status,
    seconds,
    getAnalyser: input.getAnalyser,
    toggle: input.toggle,
    cancel: input.cancel,
    available: input.available,
  }
}
