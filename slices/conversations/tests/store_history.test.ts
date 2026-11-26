import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Session } from '@deepseek-chat/slice-conversations'
import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import { createStoreEnv, say, seeded } from './store_harness.js'

const env = createStoreEnv()
const { commands } = env.slice
let replyCounter = 0
env.respondWith(() => ({ text: `r${++replyCounter}` }))

const deleted = env.facts<SessionDeleted>('SessionDeleted')
const replaced = env.facts<SessionHistoryReplaced>('SessionHistoryReplaced')

/** A chat's visible branch as `role:text` (replies by their text blocks). */
const visible = (sessionId: string) =>
  env.slice
    .getChatMessages(sessionId)
    .map((message) =>
      message.role === 'user'
        ? `user:${message.content}`
        : `assistant:${message.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')}`
    )

/** Waits until a chat's messages are loaded (after selecting it). */
const loaded = async (sessionId: string) => {
  for (let i = 0; i < 200 && env.slice.getChatMessages(sessionId).length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return visible(sessionId)
}

// ---------- reference model of SPEC invariant 6 ----------

type Node = {
  readonly label: string // `role:text`
  readonly children: Node[]
  selected: Node | null
  id?: string
  readonly parent: Node | null
}
const node = (label: string, parent: Node | null): Node => ({
  label,
  children: [],
  selected: null,
  parent,
})
const visiblePath = (root: Node) => {
  const path: Node[] = []
  for (let current = root.selected; current; current = current.selected) {
    path.push(current)
  }
  return path
}
/** Adds `labels` as a chain below `parent`, selecting each new node. */
const addChain = (parent: Node, labels: string[]) => {
  let at = parent
  for (const label of labels) {
    const next = node(label, at)
    at.children.push(next)
    at.selected = next
    at = next
  }
}

describe('conversations store: branches follow the tree model (randomized)', () => {
  it('matches the reference tree after every send, edit, regenerate and version switch', async () => {
    await commands.init()
    for (let seed = 1; seed <= 12; seed += 1) {
      const random = seeded(seed)
      const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]
      const root = node('root', null)
      let sessionId: string | null = null
      let questions = 0
      const nextReply = () => `assistant:r${replyCounter + 1}`

      // Same visible branch in the slice and the model; learn ids of newly visible nodes.
      const check = (step: string) => {
        assert.ok(sessionId)
        const path = visiblePath(root)
        const messages = env.slice.getChatMessages(sessionId)
        assert.deepEqual(
          visible(sessionId),
          path.map((n) => n.label),
          `seed ${seed}, ${step}`
        )
        messages.forEach((message, index) => {
          assert.equal(message.role, index % 2 === 0 ? 'user' : 'assistant', 'alternates')
          const model = path[index]
          if (model && !model.id) {
            model.id = message.id
          }
        })
      }

      // Start the chat.
      const first = `q${seed}-${++questions}`
      addChain(root, [`user:${first}`, nextReply()])
      commands.newChat()
      assert.equal(await say(env, null, first), true)
      const chatId = env.slice.getState().activeId
      assert.ok(chatId, 'the first send opened a chat')
      sessionId = chatId
      check('first send')

      for (let step = 0; step < 14; step += 1) {
        const path = visiblePath(root)
        const op = pick(['send', 'edit', 'regenerate', 'select', 'select'] as const)
        if (op === 'send') {
          const text = `q${seed}-${++questions}`
          addChain(path.at(-1) ?? root, [`user:${text}`, nextReply()])
          assert.equal(await say(env, sessionId, text), true)
        } else if (op === 'edit') {
          const target = pick(path.filter((n) => n.label.startsWith('user:')))
          assert.ok(target?.id && target.parent)
          const text = `q${seed}-${++questions}`
          addChain(target.parent, [`user:${text}`, nextReply()])
          assert.equal(commands.edit(chatId, target.id, text), true)
          await commands.whenIdle()
        } else if (op === 'regenerate') {
          const target = pick(path.filter((n) => n.label.startsWith('assistant:')))
          assert.ok(target?.id && target.parent)
          addChain(target.parent, [nextReply()])
          commands.regenerate(chatId, target.id)
          await commands.whenIdle()
        } else {
          const withSiblings = path.filter((n) => n.parent && n.parent.children.length > 1)
          const target = pick(withSiblings)
          if (!target?.parent) {
            continue
          }
          const choice = pick(target.parent.children.filter((n) => n !== target))
          assert.ok(choice?.id, 'every node was visible once, so its id is known')
          target.parent.selected = choice
          commands.selectVersion(chatId, choice.id)
        }
        check(`step ${step} (${op})`)
      }
    }
  })
})

describe('conversations store: facts and history', () => {
  it('deletes one chat: one SessionDeleted for it, gone from the list, others untouched', async () => {
    const ids: string[] = []
    for (const text of ['keep A', 'delete me', 'keep B']) {
      commands.newChat()
      await say(env, null, text)
      const id = env.slice.getState().activeId
      assert.ok(id)
      ids.push(id)
    }
    const [keepA, victim, keepB] = ids as [string, string, string]
    const keptBefore = [visible(keepA), visible(keepB)]
    const factsBefore = deleted.length

    assert.equal(await commands.removeSession(victim), true)
    assert.deepEqual(deleted.slice(factsBefore), [{ type: 'SessionDeleted', sessionId: victim }])
    const listed = env.slice.getState().sessions.map((s) => s.id)
    assert.ok(!listed.includes(victim))
    assert.ok(listed.includes(keepA) && listed.includes(keepB))
    assert.deepEqual([visible(keepA), visible(keepB)], keptBefore)

    // Deleting it again changes nothing and publishes nothing.
    assert.equal(await commands.removeSession(victim), false)
    assert.equal(deleted.length, factsBefore + 1)
  })

  it('replaces all sessions atomically and publishes one SessionHistoryReplaced; failures change nothing', async () => {
    const snapshot = async () => {
      const chats: string[] = []
      for (const summary of env.slice.getState().sessions) {
        commands.selectSession(summary.id)
        chats.push(JSON.stringify([summary.title, await loaded(summary.id)]))
      }
      return chats.sort()
    }
    const before = await snapshot()
    assert.ok(before.length >= 3, 'the earlier tests left several chats, some with branches')
    const exportedSessions: Session[] = []
    const snap = env.slice.snapshotForExport()
    for (const summary of snap.summaries) {
      const full = await snap.loadSession(summary.id)
      assert.ok(full)
      exportedSessions.push(full)
    }

    // A failing prepare changes nothing and publishes no fact.
    const replacedBefore = replaced.length
    await assert.rejects(() =>
      env.slice.replaceSessions(async () => {
        throw new Error('corrupt backup')
      })
    )
    assert.equal(replaced.length, replacedBefore)
    assert.deepEqual(await snapshot(), before)

    // Clearing: one fact, no chats.
    await env.slice.replaceSessions(async () => ({ sessions: [], blobs: [] }))
    assert.equal(replaced.length, replacedBefore + 1)
    assert.deepEqual(env.slice.getState().sessions, [])

    // Restoring: one fact, the same chats.
    const count = await env.slice.replaceSessions(async () => ({
      sessions: exportedSessions,
      blobs: [],
    }))
    assert.equal(replaced.length, replacedBefore + 2)
    assert.equal(count, before.length)
    assert.deepEqual(await snapshot(), before)
  })
})
