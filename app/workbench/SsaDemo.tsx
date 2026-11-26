import type { ToolCapability } from '@deepseek-chat/lib-tools'
import {
  Badge,
  Button,
  IconCodeOutline14,
  SegmentedControl,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from '@deepseek-chat/lib-ui'
import { memoryStore, type HttpFetch } from '@deepseek-chat/spine/ports'
import type { CausalEnvelope } from '@deepseek-chat/spine/runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App } from '../App.js'
import { createAppRuntime, type AppRuntime, type EnabledSlices } from '../runtime.js'
import { AppRuntimeProvider } from '../RuntimeContext.js'
import styles from './SsaDemo.module.css'

type DemoView = 'composer' | 'dual'

type SliceToggleKey = keyof EnabledSlices

const OPTIONAL_SLICES: readonly {
  readonly key: SliceToggleKey
  readonly label: string
  readonly role: string
}[] = [
  { key: 'workspaceFiles', label: 'workspace-files', role: 'Preview panel & file tools' },
  { key: 'activityInspector', label: 'activity-inspector', role: 'Activity & Sources rail' },
  { key: 'askUser', label: 'ask-user', role: 'Interactive composer dock' },
  { key: 'webResearch', label: 'web-research', role: 'Search, scrape & research profile' },
  { key: 'python', label: 'python', role: 'Python sandbox toggle & runner' },
  { key: 'subagents', label: 'subagents', role: 'Parallel child agents & board' },
  { key: 'historyBackup', label: 'history-backup', role: 'ZIP import/export & Data tab' },
  { key: 'voice', label: 'voice', role: 'Mic input & read-aloud' },
  { key: 'preferences', label: 'preferences', role: 'Theme, locale & location settings' },
  { key: 'browser', label: 'browser', role: 'Desktop built-in browser slice' },
]

const FULL_SLICES: Required<EnabledSlices> = {
  preferences: true,
  voice: true,
  webResearch: true,
  python: true,
  workspaceFiles: true,
  browser: true,
  askUser: true,
  subagents: true,
  activityInspector: true,
  historyBackup: true,
}

const BARE_SLICES: Required<EnabledSlices> = {
  preferences: false,
  voice: false,
  webResearch: false,
  python: false,
  workspaceFiles: false,
  browser: false,
  askUser: false,
  subagents: false,
  activityInspector: false,
  historyBackup: false,
}

const DEMO_USAGE = {
  input_tokens: 42,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 32,
}

const sseFromBlocks = (
  blocks: Array<
    | { kind: 'thinking'; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'call'; id: string; name: string; input: unknown }
  >,
  stopReason: 'end_turn' | 'tool_use'
): Response => {
  const events = [
    {
      type: 'message_start',
      message: { id: 'demo-msg', role: 'assistant', content: [], usage: DEMO_USAGE },
    },
    ...blocks.flatMap((block, index) => [
      {
        type: 'content_block_start',
        index,
        content_block:
          block.kind === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : block.kind === 'text'
              ? { type: 'text', text: '' }
              : { type: 'tool_use', id: block.id, name: block.name, input: {} },
      },
      {
        type: 'content_block_delta',
        index,
        delta:
          block.kind === 'thinking'
            ? { type: 'thinking_delta', thinking: block.text }
            : block.kind === 'text'
              ? { type: 'text_delta', text: block.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      },
      { type: 'content_block_stop', index },
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: DEMO_USAGE,
    },
    { type: 'message_stop' },
  ]
  return new Response(
    events
      .map(
        (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}

/**
 * Offline scripted DeepSeek fetch used exclusively inside the dev SSA Workbench so every
 * slice interaction can be demonstrated live with zero API keys or network calls.
 */
const createDemoScriptedFetch = (instanceLabel: string): HttpFetch => {
  let seq = 0
  return async (url, init) => {
    if (!url.endsWith('/messages')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const body = JSON.parse(String(init.body)) as {
      tools?: { name: string }[]
      messages?: { role: string; content: unknown }[]
    }
    const toolNames = new Set((body.tools ?? []).map((t) => t.name))
    const messages = body.messages ?? []
    const last = messages.at(-1)
    const hasToolResult =
      last?.role === 'user' &&
      Array.isArray(last.content) &&
      (last.content as { type?: string }[]).some((part) => part.type === 'tool_result')

    if (hasToolResult) {
      const results = (last.content as { type?: string; content?: string }[])
        .filter((p) => p.type === 'tool_result')
        .map((p) => String(p.content ?? ''))
        .join('\n')
      return sseFromBlocks(
        [
          {
            kind: 'text',
            text: `[${instanceLabel}] Completed the scripted tool flow.\n\nObserved tool output:\n\`\`\`text\n${results.slice(0, 240)}\n\`\`\`\n\nNotice how the Spine EventLog recorded every fact and mounted slices reacted automatically.`,
          },
        ],
        'end_turn'
      )
    }

    const promptText =
      typeof last?.content === 'string'
        ? last.content
        : Array.isArray(last?.content)
          ? (last.content as { type?: string; text?: string }[]).map((p) => p.text ?? '').join(' ')
          : ''

    seq += 1
    if (/html|file|preview/i.test(promptText) && toolNames.has('present_file')) {
      return sseFromBlocks(
        [
          { kind: 'thinking', text: 'Delivering an interactive HTML report via present_file.' },
          {
            kind: 'call',
            id: `demo-file-${seq}`,
            name: 'present_file',
            input: {
              summary: 'Creating an SSA architecture summary card',
              path: 'ssa-report.html',
              title: 'SSA Summary Card',
              content:
                '<!doctype html><html><body style="font-family:system-ui;padding:24px"><h1>Sealed Slice Architecture</h1><p>Delivered via <code>ToolCapability</code> + <code>BlobStore</code> + <code>ToolFileDelivered</code>.</p></body></html>',
            },
          },
        ],
        'tool_use'
      )
    }

    if (/ask|clarif|question/i.test(promptText) && toolNames.has('ask_user')) {
      return sseFromBlocks(
        [
          {
            kind: 'call',
            id: `demo-ask-${seq}`,
            name: 'ask_user',
            input: {
              summary: 'Asking which layout preset to generate',
              questions: [
                {
                  id: 'preset',
                  header: 'Preset',
                  question: 'Which demo layout do you prefer?',
                  options: [{ label: 'Compact', recommended: true }, { label: 'Expanded' }],
                },
              ],
            },
          },
        ],
        'tool_use'
      )
    }

    if (/calc|multiply|6\s*\*\s*7/i.test(promptText) && toolNames.has('demo_calculate')) {
      return sseFromBlocks(
        [
          {
            kind: 'call',
            id: `demo-calc-${seq}`,
            name: 'demo_calculate',
            input: { summary: 'Multiplying 6 by 7 in the drop-in calculator', a: 6, b: 7 },
          },
        ],
        'tool_use'
      )
    }

    const activeList = [...toolNames].sort().join(', ') || '(none — bare 2-slice chat)'
    return sseFromBlocks(
      [
        {
          kind: 'thinking',
          text: `Running inside ${instanceLabel} with declared tools: ${activeList}.`,
        },
        {
          kind: 'text',
          text: `Hello from **${instanceLabel}**!\n\n- **Prompt:** ${promptText || '(empty)'}\n- **Active capabilities declared this turn:** \`${activeList}\`\n\nTry toggling slices on the left or running a scripted scenario to watch the EventLog and UI update live.`,
        },
      ],
      'end_turn'
    )
  }
}

/**
 * Zero-touch synthetic capability slice injected via `extraCapabilities` to prove live
 * extensibility without modifying any existing slice.
 */
const createDemoCalculatorCapability = (): ToolCapability => {
  let enabled = true
  const listeners = new Set<() => void>()
  return {
    id: 'demo-calculator',
    toggle: {
      id: 'demo-calculator',
      label: () => 'Drop-in Calculator',
      icon: <IconCodeOutline14 />,
      isEnabled: () => enabled,
      setEnabled: (next) => {
        enabled = next
        for (const listener of [...listeners]) {
          listener()
        }
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    declareTools: ({ enabledCapabilities }) =>
      enabledCapabilities['demo-calculator']
        ? [
            {
              name: 'demo_calculate',
              description: 'Multiply two numbers in a drop-in synthetic slice.',
              input_schema: {
                type: 'object',
                required: ['a', 'b'],
                properties: { a: { type: 'number' }, b: { type: 'number' } },
              },
            },
          ]
        : [],
    instructions: (names, audience) =>
      audience === 'reply' && names.has('demo_calculate')
        ? 'Drop-in Calculator (`demo_calculate`): exact arithmetic demo tool.'
        : null,
    handles: (name) => name === 'demo_calculate',
    effectOf: () => 'read',
    run: async (call) => {
      const input = (call.input ?? {}) as { a?: number; b?: number }
      const product = Number(input.a ?? 0) * Number(input.b ?? 0)
      return {
        status: 'ok',
        content: `${input.a ?? 0} * ${input.b ?? 0} = ${product}`,
        durationMs: 4,
      }
    },
    presenter: {
      summarize: (_call, result) => ({
        lane: 'calculator',
        icon: <IconCodeOutline14 />,
        liveVerb: 'Calculating',
        detail: result?.content ?? 'Computing product',
        tally: { key: 'calc', count: 1, label: (n) => `${n} calc` },
        stillRunning: !result || result.status === 'running',
      }),
      renderActivity: ({ entries }) => (
        <div>
          {entries.map((entry) => (
            <div key={entry.call.id} data-activity-call-id={entry.call.id}>
              <strong>{entry.call.name}</strong>: {entry.result?.content ?? 'running…'}
            </div>
          ))}
        </div>
      ),
    },
  }
}

const INSPECTED_FACT_TYPES = [
  'ActiveSessionChanged',
  'ReplyLifecycleChanged',
  'SessionFilesChanged',
  'ToolFileDelivered',
  'TurnInspectionRequested',
  'SessionDeleted',
  'SessionHistoryReplaced',
  'BrowserControlTakenOver',
] as const

const useManagedRuntime = (
  enabledSlices: Required<EnabledSlices>,
  includeDropIn: boolean,
  label: string
) => {
  const [envelopes, setEnvelopes] = useState<CausalEnvelope[]>([])
  const [clearedBeforeId, setClearedBeforeId] = useState<string | null>(null)
  const runtimeRef = useRef<AppRuntime | null>(null)

  const runtime = useMemo(() => {
    const next = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-demo-offline' }),
      fetch: createDemoScriptedFetch(label),
      enabledSlices,
      extraCapabilities: includeDropIn ? [createDemoCalculatorCapability()] : [],
      autoTitle: false,
      syncDocumentTheme: false,
    })
    return next
  }, [enabledSlices, includeDropIn, label])

  useEffect(() => {
    runtimeRef.current = runtime
    setClearedBeforeId(null)
    const sync = () => {
      setEnvelopes([...runtime.log.history().slice(-80)])
    }
    sync()
    const unsubs = INSPECTED_FACT_TYPES.map((type) =>
      runtime.log.subscribe(type, sync, { replaySticky: false, onTombstone: sync })
    )
    return () => {
      for (const unsub of unsubs) {
        unsub()
      }
      runtime.dispose()
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null
      }
    }
  }, [runtime])

  const visibleEnvelopes = useMemo(() => {
    if (!clearedBeforeId) {
      return envelopes
    }
    const idx = envelopes.findIndex((e) => e.id === clearedBeforeId)
    return idx === -1 ? envelopes : envelopes.slice(idx + 1)
  }, [clearedBeforeId, envelopes])

  return {
    runtime,
    envelopes: visibleEnvelopes,
    allEnvelopes: envelopes,
    clearEnvelopes: () => setClearedBeforeId(envelopes.at(-1)?.id ?? null),
  }
}

const formatFactPayload = (fact: CausalEnvelope['fact']): string => {
  const copy = { ...fact } as Record<string, unknown>
  delete copy.type
  const raw = JSON.stringify(copy)
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw
}

const EventInspector = ({
  runtime,
  envelopes,
  allEnvelopes,
  onClear,
}: {
  runtime: AppRuntime
  envelopes: readonly CausalEnvelope[]
  allEnvelopes: readonly CausalEnvelope[]
  onClear: () => void
}) => {
  const [tab, setTab] = useState<'stream' | 'sticky'>('stream')
  const stickyRows = useMemo(() => {
    const latest = new Map<string, CausalEnvelope>()
    for (const env of allEnvelopes) {
      if (env.fact.type === 'Tombstone') {
        const tomb = env.fact as { targetType?: string; key?: string }
        latest.delete(`${tomb.targetType}:${tomb.key}`)
      } else if (env.stickyKey !== null) {
        latest.set(`${env.fact.type}:${env.stickyKey}`, env)
      }
    }
    return [...latest.values()]
  }, [allEnvelopes])

  return (
    <div className={styles.panelCard}>
      <div className={styles.inspectorHeader}>
        <div>
          <h3 className={styles.panelTitle}>Spine EventLog Inspector</h3>
          <p className={styles.panelNote}>
            {envelopes.length} event(s) · {runtime.tools.capabilities.length} capability slice(s)
          </p>
        </div>
        <Button size="s" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>

      <Tabs value={tab} onChange={setTab}>
        <TabList ariaLabel="EventLog views">
          <Tab value="stream">Causal Stream ({envelopes.length})</Tab>
          <Tab value="sticky">Sticky State ({stickyRows.length})</Tab>
        </TabList>
        <TabPanel value="stream">
          <div className={styles.eventList}>
            {envelopes.length === 0 ? (
              <p className={styles.panelNote}>
                Run a scenario or send a message to watch Spine facts.
              </p>
            ) : (
              [...envelopes].reverse().map((env) => (
                <div key={env.id} className={styles.eventRow}>
                  <div className={styles.eventMeta}>
                    <span className={styles.eventSeq}>{env.id}</span>
                    <span className={styles.eventType}>{env.fact.type}</span>
                    {env.stickyKey !== null ? (
                      <Badge tone="accent">sticky:{env.stickyKey}</Badge>
                    ) : null}
                    {env.causationId !== null ? (
                      <span className={styles.eventBadgeText}>
                        cause:{env.causationId} hop:{env.hopDepth}
                      </span>
                    ) : null}
                  </div>
                  <code className={styles.eventPayload}>{formatFactPayload(env.fact)}</code>
                </div>
              ))
            )}
          </div>
        </TabPanel>
        <TabPanel value="sticky">
          <div className={styles.eventList}>
            {stickyRows.length === 0 ? (
              <p className={styles.panelNote}>No sticky facts published yet.</p>
            ) : (
              stickyRows.map((env) => (
                <div key={`${env.fact.type}:${env.stickyKey}`} className={styles.eventRow}>
                  <div className={styles.eventMeta}>
                    <span className={styles.eventType}>{env.fact.type}</span>
                    <Badge tone="success">key={env.stickyKey}</Badge>
                  </div>
                  <code className={styles.eventPayload}>{formatFactPayload(env.fact)}</code>
                </div>
              ))
            )}
          </div>
        </TabPanel>
      </Tabs>
    </div>
  )
}

const DualIsolatedInstances = () => {
  const instanceA = useManagedRuntime(FULL_SLICES, true, 'Instance A')
  const instanceB = useManagedRuntime(BARE_SLICES, false, 'Instance B (Bare 2-Slice)')

  const sendQuick = (runtime: AppRuntime, text: string) => {
    void runtime.slices.conversations.commands.init().then(() => {
      runtime.slices.conversations.commands.setDraft(null, text)
      runtime.slices.conversations.commands.send(null)
    })
  }

  return (
    <div className={styles.dualGrid}>
      <div className={styles.dualColumn}>
        <div className={styles.dualHeader}>
          <div>
            <strong>Instance A · Full 12 Slices + Drop-in Calc</strong>
            <div className={styles.panelNote}>
              EventLog events: {instanceA.envelopes.length} · Capabilities:{' '}
              {instanceA.runtime.tools.capabilities.length}
            </div>
          </div>
          <Button
            size="s"
            variant="outlined"
            onClick={() => sendQuick(instanceA.runtime, 'Create HTML preview in Instance A')}
          >
            Send in A
          </Button>
        </div>
        <div className={styles.dualViewport}>
          <AppRuntimeProvider runtime={instanceA.runtime}>
            <App embedded />
          </AppRuntimeProvider>
        </div>
      </div>

      <div className={styles.dualColumn}>
        <div className={styles.dualHeader}>
          <div>
            <strong>Instance B · Bare Chat (2 Slices Only)</strong>
            <div className={styles.panelNote}>
              EventLog events: {instanceB.envelopes.length} · Capabilities:{' '}
              {instanceB.runtime.tools.capabilities.length}
            </div>
          </div>
          <Button
            size="s"
            variant="outlined"
            onClick={() => sendQuick(instanceB.runtime, 'Hello from isolated Instance B')}
          >
            Send in B
          </Button>
        </div>
        <div className={styles.dualViewport}>
          <AppRuntimeProvider runtime={instanceB.runtime}>
            <App embedded />
          </AppRuntimeProvider>
        </div>
      </div>
    </div>
  )
}

/** Dev-only live Sealed Slice Architecture showcase (`pnpm dev:ssa` / `/?workbench=1&tab=ssa`). */
export const SsaDemo = () => {
  const [view, setView] = useState<DemoView>('composer')
  const [enabledSlices, setEnabledSlices] = useState<Required<EnabledSlices>>(FULL_SLICES)
  const [includeDropIn, setIncludeDropIn] = useState(true)

  const { runtime, envelopes, allEnvelopes, clearEnvelopes } = useManagedRuntime(
    enabledSlices,
    includeDropIn,
    'SSA Sandbox'
  )

  const toggleSlice = useCallback((key: SliceToggleKey, next: boolean) => {
    setEnabledSlices((prev) => ({ ...prev, [key]: next }))
  }, [])

  const runScenario = useCallback(
    (prompt: string) => {
      void runtime.slices.conversations.commands.init().then(() => {
        runtime.slices.conversations.commands.newChat()
        runtime.slices.conversations.commands.setDraft(null, prompt)
        runtime.slices.conversations.commands.send(null)
      })
    },
    [runtime]
  )

  const mountedCount =
    2 + Object.values(enabledSlices).filter(Boolean).length + (includeDropIn ? 1 : 0)

  return (
    <div className={styles.demoRoot}>
      <section className={styles.banner}>
        <div className={styles.bannerText}>
          <h2 className={styles.bannerTitle}>Live Sealed Slice Architecture (SSA) Demo</h2>
          <p className={styles.bannerSubtitle}>
            Toggle any optional slice below to dispose and reboot <code>createAppRuntime</code>{' '}
            live, run offline scripted tool flows, inspect real-time Spine <code>EventLog</code>{' '}
            envelopes, or mount two isolated app instances side by side in the same tab.
          </p>
        </div>
        <SegmentedControl<DemoView>
          ariaLabel="SSA demo view"
          value={view}
          onChange={setView}
          options={[
            { value: 'composer', label: 'Live Slice Composer' },
            { value: 'dual', label: 'Dual Isolated Instances' },
          ]}
        />
      </section>

      {view === 'dual' ? (
        <DualIsolatedInstances />
      ) : (
        <div className={styles.composerLayout}>
          <div className={styles.panelCard}>
            <div>
              <h3 className={styles.panelTitle}>Mounted Slices ({mountedCount})</h3>
              <p className={styles.panelNote}>
                Core: <code>account</code> + <code>conversations</code>. Toggling any switch below
                disposes the old runtime and boots a fresh isolated one.
              </p>
            </div>

            <div className={styles.presetRow}>
              <Button
                size="s"
                variant="outlined"
                onClick={() => {
                  setEnabledSlices(FULL_SLICES)
                  setIncludeDropIn(true)
                }}
              >
                Full App
              </Button>
              <Button
                size="s"
                variant="outlined"
                onClick={() => {
                  setEnabledSlices(BARE_SLICES)
                  setIncludeDropIn(false)
                }}
              >
                Bare 2-Slice
              </Button>
            </div>

            <div className={styles.switchList}>
              <Switch
                block
                label="Drop-in Calculator (extra)"
                checked={includeDropIn}
                onChange={setIncludeDropIn}
              />
              {OPTIONAL_SLICES.map((item) => (
                <Switch
                  key={item.key}
                  block
                  label={item.label}
                  checked={enabledSlices[item.key]}
                  onChange={(checked) => toggleSlice(item.key, checked)}
                />
              ))}
            </div>

            <div>
              <h3 className={styles.panelTitle}>Scripted Scenarios (Offline)</h3>
              <p className={styles.panelNote}>Zero API key needed — uses mock SSE stream.</p>
            </div>
            <div className={styles.buttonStack}>
              <Button
                size="s"
                variant="primary"
                onClick={() => runScenario('Deliver an HTML preview file')}
              >
                1. Deliver HTML File
              </Button>
              <Button
                size="s"
                variant="outlined"
                onClick={() => runScenario('Ask a clarifying question before building')}
              >
                2. Clarifying Question Dock
              </Button>
              <Button
                size="s"
                variant="outlined"
                onClick={() => runScenario('Calculate 6 * 7 using drop-in calculator')}
              >
                3. Drop-in Calculator Tool
              </Button>
              <Button
                size="s"
                variant="ghost"
                onClick={() => runScenario('Inspect mounted tools in this configuration')}
              >
                4. Inspect Active Capabilities
              </Button>
            </div>
          </div>

          <div className={styles.appViewport}>
            <AppRuntimeProvider runtime={runtime}>
              <App embedded />
            </AppRuntimeProvider>
          </div>

          <EventInspector
            runtime={runtime}
            envelopes={envelopes}
            allEnvelopes={allEnvelopes}
            onClear={clearEnvelopes}
          />
        </div>
      )}
    </div>
  )
}
