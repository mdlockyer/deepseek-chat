import { SegmentedControl } from '@deepseek-chat/lib-ui'
import { memoryStore, type HttpFetch } from '@deepseek-chat/spine/ports'
import { useEffect, useMemo, useRef, useState } from 'react'
import { App } from '../App.js'
import { createAppRuntime } from '../runtime.js'
import { AppRuntimeProvider } from '../RuntimeContext.js'
import { mountMinimapRail, type MinimapStyle } from './minimapRail.js'
import styles from './MinimapStudy.module.css'
import { MINIMAP_STUDY_TURNS } from './minimapStudyScript.js'

type Choice = 'today' | MinimapStyle

const USAGE = {
  input_tokens: 42,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 32,
}

const sse = (blocks: readonly { kind: 'thinking' | 'text'; text: string }[]) => {
  const events = [
    {
      type: 'message_start',
      message: { id: 'study', role: 'assistant', content: [], usage: USAGE },
    },
    ...blocks.flatMap((block, index) => [
      {
        type: 'content_block_start',
        index,
        content_block:
          block.kind === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index,
        delta:
          block.kind === 'thinking'
            ? { type: 'thinking_delta', thinking: block.text }
            : { type: 'text_delta', text: block.text },
      },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: USAGE },
    { type: 'message_stop' },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}

/** Answers each prompt with the scripted reply for its position in the conversation. */
const studyFetch: HttpFetch = async (url, init) => {
  if (!url.endsWith('/messages')) {
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
  }
  const body = JSON.parse(String(init.body)) as { messages?: { role: string; content: unknown }[] }
  const prompts = (body.messages ?? []).filter(
    (m) =>
      m.role === 'user' &&
      !(
        Array.isArray(m.content) &&
        (m.content as { type?: string }[]).some((p) => p.type === 'tool_result')
      )
  ).length
  const turn = MINIMAP_STUDY_TURNS[Math.max(0, Math.min(prompts, MINIMAP_STUDY_TURNS.length) - 1)]
  if (!turn) {
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
  }
  return sse([
    ...(turn.thinking ? [{ kind: 'thinking' as const, text: turn.thinking }] : []),
    { kind: 'text' as const, text: turn.reply },
  ])
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Prototype: the real app, replaying a scripted eight-turn chat, with the transcript's chapter
 * rail swapped for one of the minimap options. Open with `/?workbench=1&study=minimap`.
 */
export const MinimapStudy = () => {
  const runtime = useMemo(
    () =>
      createAppRuntime({
        store: memoryStore({ 'chat-demo:api-key': 'sk-demo-offline' }),
        fetch: studyFetch,
        autoTitle: false,
        syncDocumentTheme: true,
      }),
    []
  )
  const [choice, setChoice] = useState<Choice>(
    () => (new URLSearchParams(window.location.search).get('style') as Choice | null) ?? 'text'
  )
  const [ready, setReady] = useState(false)
  const appRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => runtime.dispose(), [runtime])

  useEffect(() => {
    let cancelled = false
    const chats = runtime.slices.conversations
    void (async () => {
      await chats.commands.init()
      chats.setThinking(true)
      for (const turn of MINIMAP_STUDY_TURNS) {
        if (cancelled) {
          return
        }
        const id = chats.getState().activeId
        chats.commands.setDraft(id, turn.prompt)
        chats.commands.send(id)
        await pause(30)
        await chats.commands.whenIdle()
      }
      if (!cancelled) {
        setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runtime])

  useEffect(() => {
    const root = appRef.current
    if (!ready || !root || choice === 'today') {
      return
    }
    const scroll = root.querySelector<HTMLElement>('[data-message-scroll]')
    const area = scroll?.parentElement
    const column = scroll?.firstElementChild as HTMLElement | null
    if (!scroll || !area || !column) {
      return
    }
    return mountMinimapRail(area, scroll, column, choice)
  }, [ready, choice])

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <span className={styles.barTitle}>Transcript minimap study</span>
        <SegmentedControl<Choice>
          size="sm"
          ariaLabel="Rail style"
          value={choice}
          onChange={setChoice}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'text', label: 'B · Text minimap' },
            { value: 'stems', label: 'D · Ticks on stems' },
          ]}
        />
        <span className={styles.barHint}>
          {ready
            ? 'Scroll the chat, drag the window on the rail, or click the rail to jump.'
            : 'Replaying the conversation…'}
        </span>
      </div>
      <div ref={appRef} className={styles.app}>
        <AppRuntimeProvider runtime={runtime}>
          <App embedded />
        </AppRuntimeProvider>
      </div>
    </div>
  )
}
