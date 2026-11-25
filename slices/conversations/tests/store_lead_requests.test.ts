import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import type { AssistantMessage } from '@deepseek-chat/slice-conversations'
import {
  createStoreEnv,
  fileGoneError,
  seeded,
  sendWhenUploaded,
  type ApiReply,
  type ApiRequest,
} from './store_harness.js'

const NETWORK_RETRY_LIMIT = 3
const FILE_REUPLOAD_LIMIT = 1

const env = createStoreEnv({
  toolNames: ['find_web'],
  effects: { find_web: 'read' },
  params: {
    networkRetryLimit: NETWORK_RETRY_LIMIT,
    fileReuploadLimit: FILE_REUPLOAD_LIMIT,
    retryBaseDelayMs: 1,
  },
})

const NETWORK_LOST: ApiReply = { networkError: 'The network connection was lost.' }

const lastReply = (): AssistantMessage => {
  const { activeId } = env.slice.getState()
  assert.ok(activeId, 'a chat is on screen')
  const reply = env.slice.getChatMessages(activeId).at(-1)
  return reply?.role === 'assistant' ? reply : assert.fail('the last message is a reply')
}

const replyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

const turn = async (
  respond: (index: number, request: ApiRequest) => ApiReply,
  files: File[] = []
): Promise<ApiRequest[]> => {
  const first = env.requests.length
  env.respondWith((request) => respond(env.requests.length - first - 1, request))
  env.slice.commands.newChat()
  env.slice.commands.setDraft(null, 'question')
  if (files.length > 0) {
    assert.equal(env.slice.commands.attach(null, files), null, 'the files are accepted')
  }
  await sendWhenUploaded(env, null)
  return env.requests.slice(first)
}

const mentions = (request: ApiRequest, fileId: string) =>
  JSON.stringify(request.messages).includes(fileId)

describe('conversations store: reply requests (SPEC invariant 8)', () => {
  before(() => env.slice.commands.init())

  it('sends a request again after network errors before any content, up to the limit', async () => {
    const random = seeded(8)
    const failureCounts = Array.from({ length: NETWORK_RETRY_LIMIT + 3 }, (_, n) => n)
    failureCounts.sort(() => random() - 0.5)

    for (const failures of failureCounts) {
      const requests = await turn((index) => (index < failures ? NETWORK_LOST : { text: 'answer' }))
      const reply = lastReply()
      if (failures <= NETWORK_RETRY_LIMIT) {
        assert.equal(reply.status, 'done', `${failures} failures`)
        assert.equal(replyText(reply), 'answer')
        assert.equal(requests.length, failures + 1, 'one request per failure, then the answer')
      } else {
        assert.equal(reply.status, 'error', `${failures} failures`)
        assert.equal(reply.error?.kind, 'network')
        assert.equal(requests.length, NETWORK_RETRY_LIMIT + 1, 'no request past the limit')
      }
    }
  })

  it('counts network retries for the whole turn, across tool rounds', async () => {
    const random = seeded(81)
    for (let trial = 0; trial < 6; trial += 1) {
      const total = NETWORK_RETRY_LIMIT + (trial % 2)
      const before = 1 + Math.floor(random() * (total - 1))
      const after = total - before
      const requests = await turn((index) => {
        if (index < before) {
          return NETWORK_LOST
        }
        if (index === before) {
          return { calls: [{ name: 'find_web', input: { query: 'q' } }] }
        }
        return index - before - 1 < after ? NETWORK_LOST : { text: 'answer' }
      })
      const reply = lastReply()
      if (total <= NETWORK_RETRY_LIMIT) {
        assert.equal(reply.status, 'done', `${before} + ${after} failures`)
        assert.equal(requests.length, total + 2)
      } else {
        assert.equal(reply.status, 'error', `${before} + ${after} failures`)
        assert.equal(reply.error?.kind, 'network')
        assert.equal(requests.length, NETWORK_RETRY_LIMIT + 2, 'no request past the limit')
      }
    }
  })

  it('does not send a request again once content arrived, and keeps what arrived', async () => {
    const requests = await turn(() => ({ text: 'partial answer', cutAfterContent: true }))
    const reply = lastReply()
    assert.equal(requests.length, 1)
    assert.equal(reply.status, 'error')
    assert.equal(replyText(reply), 'partial answer')
  })

  it('counts a stream that ends after its stop reason as complete', async () => {
    const requests = await turn((index) =>
      index === 0
        ? { calls: [{ name: 'find_web', input: { query: 'q' } }], dropMessageStop: true }
        : { text: 'whole answer', dropMessageStop: true }
    )
    const reply = lastReply()
    assert.equal(requests.length, 2, 'the tool round goes on after the cut stream')
    assert.equal(reply.status, 'done')
    assert.equal(replyText(reply), 'whole answer')
  })

  it('uploads a dropped file again and resends, counting re-uploads per request', async () => {
    const firstUpload = env.uploads.length
    const idOfUpload = (n: number) => `file-api-${firstUpload + n + 1}`
    const requests = await turn(
      (index) => {
        switch (index) {
          case 0:
            return fileGoneError(idOfUpload(0))
          case 1:
            return { calls: [{ name: 'find_web', input: { query: 'q' } }] }
          case 2:
            return fileGoneError(idOfUpload(1))
          default:
            return { text: 'read it' }
        }
      },
      [new File(['notes'], 'notes.txt', { type: 'text/plain' })]
    )
    const reply = lastReply()
    assert.equal(reply.status, 'done')
    assert.deepEqual(env.uploads.slice(firstUpload), ['notes.txt', 'notes.txt', 'notes.txt'])
    assert.equal(requests.length, 4)
    assert.ok(mentions(requests[0], idOfUpload(0)))
    assert.ok(mentions(requests[1], idOfUpload(1)), 'the resend names the new upload')
    assert.ok(mentions(requests[3], idOfUpload(2)), 'the resend names the new upload')
  })

  it("ends failed with the server's error past the re-upload limit", async () => {
    const firstUpload = env.uploads.length
    const requests = await turn(
      (index) => fileGoneError(`file-api-${firstUpload + index + 1}`),
      [new File(['notes'], 'notes.txt', { type: 'text/plain' })]
    )
    const reply = lastReply()
    assert.equal(requests.length, FILE_REUPLOAD_LIMIT + 1)
    assert.equal(env.uploads.length - firstUpload, FILE_REUPLOAD_LIMIT + 1)
    assert.equal(reply.status, 'error')
    assert.equal(reply.error?.kind, 'http')
    assert.equal(reply.error?.status, 400)
  })

  it('ends as an upload error, without sending, when a re-upload fails', async () => {
    const firstUpload = env.uploads.length
    env.respondToUploadsWith((_name, index) =>
      index === firstUpload
        ? { id: `file-api-${index + 1}` }
        : { errorStatus: 500, errorMessage: 'storage unavailable' }
    )
    try {
      const requests = await turn(
        () => fileGoneError(`file-api-${firstUpload + 1}`),
        [new File(['notes'], 'notes.txt', { type: 'text/plain' })]
      )
      const reply = lastReply()
      assert.equal(env.uploads.length - firstUpload, 2, 'the original upload and one re-upload')
      assert.equal(requests.length, 1, 'the request is not sent again')
      assert.equal(reply.status, 'error')
      assert.equal(reply.error?.kind, 'upload')
    } finally {
      env.respondToUploadsWith((_name, index) => ({ id: `file-api-${index + 1}` }))
    }
  })
})
