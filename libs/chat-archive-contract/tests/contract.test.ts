import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  ArchiveAssistantMessage,
  ArchiveSession,
  ArchiveSessionSummary,
  ChatArchiveSessionsPort,
} from '@deepseek-chat/lib-chat-archive-contract'

describe('lib-chat-archive-contract', () => {
  it('models persisted sessions, branching messages, and bidirectional port wiring without casts', async () => {
    const reply: ArchiveAssistantMessage = {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      createdAt: 2_000,
      model: null,
      provider: null,
      thinking: true,
      enabledCapabilities: { 'web-research': true },
      status: 'done',
      blocks: [
        { type: 'thinking', thinking: 'Plan', elapsedSeconds: 1 },
        { type: 'tool_use', id: 'c1', name: 'web_search', input: { query: 'csa' } },
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          capability: 'web-research',
          content: 'ok',
          status: 'ok',
          sources: [],
        },
        { type: 'text', text: 'Done.' },
      ],
    }
    const stored: ArchiveSession = {
      id: 's1',
      title: 'Archive contract check',
      createdAt: 1_000,
      updatedAt: 2_000,
      rootMessageId: 'u1',
      messages: [
        {
          id: 'u1',
          parentId: null,
          selectedChildId: 'a1',
          role: 'user',
          content: 'Hello',
          files: [
            {
              id: 'f1',
              serverId: null,
              serverProvider: null,
              name: 'note.txt',
              size: 5,
              isImage: false,
              mimeType: 'text/plain',
            },
          ],
          createdAt: 1_000,
        },
        reply,
      ],
    }

    let current: ArchiveSession[] = [stored]
    const port: ChatArchiveSessionsPort = {
      snapshotForExport: () => ({
        summaries: current.map(
          ({ id, title, createdAt, updatedAt }): ArchiveSessionSummary => ({
            id,
            title,
            createdAt,
            updatedAt,
          })
        ),
        loadSession: async (id) => current.find((session) => session.id === id),
      }),
      replaceHistory: async (prepare) => {
        const next = await prepare()
        current = [...next.sessions]
        return current.length
      },
      useState: () => ({ replacing: false, empty: current.length === 0 }),
      describeReplyNotice: (message) => (message.status === 'error' ? 'failed' : null),
    }

    const snap = port.snapshotForExport()
    assert.equal(snap.summaries.length, 1)
    assert.equal((await snap.loadSession('s1'))?.title, 'Archive contract check')
    assert.equal(port.describeReplyNotice?.(reply), null)
    assert.equal(await port.replaceHistory(async () => ({ sessions: [], blobs: [] })), 0)
    assert.equal(port.useState().empty, true)
  })
})
