import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BrowserControlTakenOver } from '@deepseek-chat/spine/facts/browser'
import type {
  ActiveSessionChanged,
  ReplyLifecycleChanged,
  SessionFilesChanged,
  ToolFileDelivered,
} from '@deepseek-chat/spine/facts/session'
import { createStoreEnv, say } from './store_harness.js'

describe('conversations store: TurnLifecycleHooks and Spine facts', () => {
  it('runs onTurnEndWithoutToolCalls synthetic calls, persists capabilityState, and invokes onTurnSettled', async () => {
    const settledReasons: string[] = []
    let injectedOnce = false

    const env = createStoreEnv({
      toolNames: ['start_job', 'collect_job'],
      effects: { start_job: 'spawn', collect_job: 'session' },
      turnHooks: {
        onTurnEndWithoutToolCalls: ({ readReplyState }) => {
          const state = readReplyState() as { pending?: boolean } | undefined
          if (state?.pending && !injectedOnce) {
            injectedOnce = true
            return {
              syntheticCall: {
                id: 'synthetic-collect-1',
                name: 'collect_job',
                input: { wait: true },
              },
            }
          }
          return null
        },
        onTurnSettled: ({ reason, readReplyState, writeReplyState }) => {
          settledReasons.push(reason)
          const state = readReplyState() as { pending?: boolean } | undefined
          if (state?.pending) {
            writeReplyState({ pending: false, settledBy: reason })
          }
        },
        onReplyHydrated: (raw) => {
          const obj = raw as { pending?: boolean } | undefined
          return obj?.pending ? { pending: false, hydrated: true } : raw
        },
      },
    })

    await env.slice.commands.init()
    const lifecycles = env.facts<ReplyLifecycleChanged>('ReplyLifecycleChanged')
    const delivered = env.facts<ToolFileDelivered>('ToolFileDelivered')
    const sessionFiles = env.facts<SessionFilesChanged>('SessionFilesChanged')
    const activeSessions = env.facts<ActiveSessionChanged>('ActiveSessionChanged')

    let turnStep = 0
    env.respondWith(() => {
      turnStep += 1
      if (turnStep === 1) {
        return { calls: [{ name: 'start_job', input: {} }] }
      }
      if (turnStep === 2) {
        // Model stops without calling collect_job -> hook must inject it!
        return { text: 'Interim draft.' }
      }
      return { text: 'Final synthesized answer.' }
    })

    env.runToolsWith(async (call, ctx) => {
      if (call.name === 'start_job') {
        ctx.writeReplyState({ pending: true })
        return { content: 'job-started', status: 'ok' }
      }
      ctx.writeReplyState({ pending: false })
      return {
        content: 'job-collected',
        status: 'ok',
        files: [
          {
            id: 'blob-report',
            name: 'report.md',
            path: 'report.md',
            size: 128,
            mimeType: 'text/markdown',
            version: 1,
            producer: 'test-tools',
          },
        ],
      }
    })

    await say(env, null, 'Kick off background work')

    const sessionId = env.slice.getState().activeId
    assert.ok(sessionId)
    assert.equal(injectedOnce, true)
    assert.deepEqual(settledReasons, ['done'])
    assert.equal(
      env.requests.length,
      3,
      'round 0 spawn, round 1 premature end, round 2 after synthetic collect'
    )

    // Spine facts emitted properly:
    assert.ok(activeSessions.some((f) => f.sessionId === sessionId))
    assert.deepEqual(
      lifecycles.map((f) => f.phase),
      ['started', 'settled']
    )
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0]?.file.fileId, 'blob-report')
    assert.ok(
      sessionFiles.at(-1)?.files.some((f) => f.kind === 'delivered' && f.fileId === 'blob-report')
    )

    // Hydrating a persisted session with pending capabilityState invokes onReplyHydrated.
    await env.sessions.saveSession({
      id: 'hydrated-session',
      title: 'Hydrated',
      createdAt: 1,
      updatedAt: 2,
      rootMessageId: 'u-h',
      messages: [
        { id: 'u-h', role: 'user', content: 'hi', files: [], createdAt: 1, selectedChildId: 'a-h' },
        {
          id: 'a-h',
          role: 'assistant',
          parentId: 'u-h',
          createdAt: 2,
          model: 'deepseek-flash',
          prefix: false,
          status: 'streaming',
          blocks: [],
          capabilityState: { 'test-tools': { pending: true } },
        },
      ],
    })
    const hydratedStored = await env.sessions.loadSession('hydrated-session')
    assert.ok(hydratedStored)
    await env.slice.replaceSessions(async () => ({
      sessions: [hydratedStored],
      blobs: [],
    }))
    env.slice.commands.selectSession('hydrated-session')
    for (let i = 0; i < 50 && env.slice.getChatMessages('hydrated-session').length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const hydratedReply = env.slice.getChatMessages('hydrated-session').at(-1)
    assert.equal(hydratedReply?.role, 'assistant')
    if (hydratedReply?.role === 'assistant') {
      assert.equal(hydratedReply.status, 'stopped')
      assert.deepEqual(hydratedReply.capabilityState?.['test-tools'], {
        pending: false,
        hydrated: true,
      })
    }
    env.slice.dispose()
  })

  it('aborts an active reply when BrowserControlTakenOver is published on EventLog', async () => {
    const env = createStoreEnv({
      toolNames: ['slow_tool'],
      effects: { slow_tool: 'session' },
    })
    await env.slice.commands.init()

    let toolAborted = false
    env.respondWith(() => ({ calls: [{ name: 'slow_tool', input: {} }] }))
    env.runToolsWith(
      (_call, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              toolAborted = true
              resolve({ content: 'aborted', status: 'aborted' })
            },
            { once: true }
          )
          // Publish BrowserControlTakenOver from outside conversations!
          env.log.publish<BrowserControlTakenOver>({
            type: 'BrowserControlTakenOver',
            sessionId: ctx.sessionId,
          })
        })
    )

    await say(env, null, 'Browse interactively')
    assert.equal(toolAborted, true)
    const activeId = env.slice.getState().activeId
    assert.ok(activeId)
    const last = env.slice.getChatMessages(activeId).at(-1)
    assert.equal(last?.role === 'assistant' ? last.status : null, 'stopped')
    env.slice.dispose()
  })
})
