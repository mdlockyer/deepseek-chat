import { SegmentedControl } from '@deepseek-chat/lib-ui'
import { memoryStore, type HttpFetch } from '@deepseek-chat/spine/ports'
import { useEffect, useMemo, useState } from 'react'
import { App } from '../App.js'
import { createAppRuntime } from '../runtime.js'
import { AppRuntimeProvider } from '../RuntimeContext.js'
import styles from './MinimapStudy.module.css'
import { MINIMAP_STUDY_TURNS } from './minimapStudyScript.js'

const LENGTHS = ['8', '40', '150'] as const
type Length = (typeof LENGTHS)[number]

const params = new URLSearchParams(window.location.search)
const LENGTH: Length = (LENGTHS as readonly string[]).includes(params.get('turns') ?? '')
  ? (params.get('turns') as Length)
  : '8'

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
  const turn = MINIMAP_STUDY_TURNS[Math.max(0, prompts - 1) % MINIMAP_STUDY_TURNS.length]
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
 * The real app replaying a scripted chat of 8, 40 or 150 turns, to try the transcript's minimap
 * on short and long chats without an API key. Open with `/?workbench=1&study=minimap`
 * (add `&turns=40` or `&turns=150`).
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
  const [ready, setReady] = useState(false)
  const [replayed, setReplayed] = useState(0)

  useEffect(() => () => runtime.dispose(), [runtime])

  useEffect(() => {
    let cancelled = false
    const chats = runtime.slices.conversations
    void (async () => {
      await chats.commands.init()
      chats.setThinking(true)
      for (let i = 0; i < Number(LENGTH); i += 1) {
        const turn = MINIMAP_STUDY_TURNS[i % MINIMAP_STUDY_TURNS.length]
        if (cancelled || !turn) {
          return
        }
        setReplayed(i)
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

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <SegmentedControl<Length>
          size="sm"
          ariaLabel="Chat length"
          value={LENGTH}
          onChange={(next) => {
            const url = new URL(window.location.href)
            url.searchParams.set('turns', next)
            window.location.assign(url)
          }}
          options={LENGTHS.map((value) => ({ value, label: `${value} turns` }))}
        />
        <span className={styles.barHint}>
          {ready
            ? 'Scroll, drag the window, or click the minimap.'
            : `Replaying turn ${replayed + 1} of ${LENGTH}…`}
        </span>
      </div>
      <div className={styles.app}>
        <AppRuntimeProvider runtime={runtime}>
          <App embedded />
        </AppRuntimeProvider>
      </div>
    </div>
  )
}
