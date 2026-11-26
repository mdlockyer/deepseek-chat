import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEEPSEEK_MODELS, type ModelSpec } from '@deepseek-chat/lib-agent'
import { createToolRegistry, type ToolCapability } from '@deepseek-chat/lib-tools'
import {
  CHECKPOINT_ACK,
  appendBranch,
  buildCompactionLedgerText,
  buildVerbatimSection,
  computeCompactionPolicy,
  estimateSessionContext,
  estimateTextTokens,
  findActiveCheckpoint,
  getVisibleMessages,
  selectCompactionTrigger,
  selectVersion,
  toRequestMessages,
  validateCompactionSummary,
  type AssistantMessage,
  type CompactionCheckpoint,
  type Message,
  type Session,
  type UserMessage,
} from '@deepseek-chat/slice-conversations'

const makeSpec = (contextWindow: number, maxOutputTokens = 16_384): ModelSpec => ({
  id: `model-${contextWindow}`,
  provider: 'test',
  label: `Test ${contextWindow}`,
  contextWindow,
  maxOutputTokens,
  capabilities: {
    thinking: true,
    vision: true,
    documents: true,
    tools: true,
    promptCaching: true,
  },
})

const userMsg = (id: string, content: string, files: UserMessage['files'] = []): UserMessage => ({
  id,
  role: 'user',
  content,
  files,
  createdAt: 1,
})

const assistantMsg = (
  id: string,
  text: string,
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 2,
  model: 'deepseek-flash',
  provider: 'deepseek',
  status: 'done',
  blocks: text ? [{ type: 'text', text }] : [],
  ...overrides,
})

const makeCheckpoint = (
  id: string,
  anchorMessageId: string,
  overrides: Partial<CompactionCheckpoint> = {}
): CompactionCheckpoint => ({
  id,
  anchorMessageId,
  trigger: 'turnStart',
  createdAt: 100,
  renderedWireText: `<conversation_checkpoint>\nCheckpoint ${id}\n</conversation_checkpoint>`,
  summary: `## Goal\nFinish task ${id}.\n\n## Next Steps\nContinue work.`,
  keptMessagesCount: 2,
  droppedMessagesCount: 4,
  droppedReasoning: false,
  tokensBefore: 12_000,
  tokensAfter: 1_500,
  ...overrides,
})

describe('compaction: window-adaptive policy and trigger selection', () => {
  it('scales monotonically across 4K..2M windows and hits exact 200K and 1M DeepSeek Flash anchors', () => {
    const flashSpec = DEEPSEEK_MODELS.find((m) => m.id === 'deepseek-flash')
    assert.ok(flashSpec)
    const flashPolicy = computeCompactionPolicy(flashSpec)
    assert.equal(flashPolicy.contextWindow, 1_048_576)
    assert.equal(flashPolicy.thresholdPercent, 50)
    assert.equal(flashPolicy.line, 524_288)
    assert.equal(flashPolicy.keepRecentTokens, 40_000)
    assert.equal(flashPolicy.maxCheckpointTokens, 262_144)
    assert.equal(flashPolicy.meterVisibleTokens, Math.floor(524_288 * 0.4))
    // 393K maxOutputTokens is capped to 10% of 1M so responseReserve never eats a third of the window.
    assert.equal(flashPolicy.responseReserve, Math.floor(1_048_576 * 0.1) + 4_096)
    assert.ok(flashPolicy.line < flashPolicy.ceiling)

    const p200k = computeCompactionPolicy(makeSpec(200_000, 64_000))
    assert.equal(p200k.thresholdPercent, 70)
    assert.equal(p200k.line, 140_000)
    assert.equal(p200k.keepRecentTokens, 20_000)

    const p16k = computeCompactionPolicy(makeSpec(16_000, 4_096))
    assert.equal(p16k.thresholdPercent, 70)
    assert.equal(p16k.keepRecentTokens, 4_000) // capped at 25% of small window

    // Monotonicity sweep including transition boundaries around 220K where rounded percentages change.
    const windows = [
      4_096, 8_192, 16_000, 32_768, 128_000, 200_000, 219_999, 220_000, 220_001, 400_000, 600_000,
      800_000, 1_000_000, 1_048_576, 2_000_000,
    ]
    let prevLine = 0
    let prevCeiling = 0
    for (const w of windows) {
      const p = computeCompactionPolicy(makeSpec(w, 64_000))
      assert.ok(p.line >= prevLine, `line dipped at window=${w}: ${p.line} < ${prevLine}`)
      assert.ok(
        p.ceiling >= prevCeiling,
        `ceiling dipped at window=${w}: ${p.ceiling} < ${prevCeiling}`
      )
      assert.ok(p.line < p.ceiling, `line must remain strictly below ceiling at window=${w}`)
      assert.equal(p.maxCheckpointTokens, Math.floor(p.line * 0.5))
      assert.ok(p.keepRecentTokens <= Math.floor(p.contextWindow * 0.25))
      prevLine = p.line
      prevCeiling = p.ceiling
    }
    assert.ok(
      computeCompactionPolicy(makeSpec(1_048_576, 393_216)).line >
        computeCompactionPolicy(makeSpec(200_000, 64_000)).line
    )
  })

  it('prioritizes fit over proactive line and suppresses only line triggers after a line failure', () => {
    const policy = computeCompactionPolicy(makeSpec(16_000, 4_096))
    assert.equal(selectCompactionTrigger(policy.line - 1, policy, 'turnStart', false), null)
    assert.equal(selectCompactionTrigger(policy.line, policy, 'turnStart', false), 'turnStart')
    assert.equal(
      selectCompactionTrigger(policy.line, policy, 'betweenRounds', false),
      'betweenRounds'
    )
    assert.equal(selectCompactionTrigger(policy.line, policy, 'turnStart', true), null)
    assert.equal(selectCompactionTrigger(policy.ceiling, policy, 'turnStart', true), 'fit')
    assert.equal(selectCompactionTrigger(policy.ceiling, policy, 'betweenRounds', true), 'fit')
  })
})

describe('compaction: CJK-aware estimation and hybrid session context', () => {
  it('weights Chinese prose significantly higher per character than Latin prose', () => {
    const english = 'a'.repeat(600)
    const chinese = '中'.repeat(600)
    const enTokens = estimateTextTokens(english)
    const zhTokens = estimateTextTokens(chinese)
    assert.equal(enTokens, 150)
    assert.equal(zhTokens, 400)
    assert.ok(zhTokens > enTokens * 2.5)
  })

  it('anchors on newest post-checkpoint usage + delta and ignores stale pre-checkpoint usage', () => {
    const spec = makeSpec(100_000)
    const u1 = userMsg('u1', 'First turn')
    const a1 = assistantMsg('a1', 'First answer', {
      usage: {
        input_tokens: 50_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10_000,
        output_tokens: 2_000,
      },
    })
    const u2 = userMsg('u2', 'Second question')

    // Without checkpoint: anchors on a1.usage (62_000) + u2 delta.
    const uncompacted = estimateSessionContext({
      visibleMessages: [u1, a1, u2],
      modelSpec: spec,
    })
    assert.equal(uncompacted.source, 'usage+delta')
    assert.ok(uncompacted.tokens > 62_000 && uncompacted.tokens < 62_100)

    // With checkpoint anchored on a1: ignores stale 62k pre-checkpoint usage!
    const cp = makeCheckpoint('cp1', 'a1')
    const compacted = estimateSessionContext({
      visibleMessages: [u1, a1, u2],
      checkpoints: [cp],
      modelSpec: spec,
    })
    assert.equal(compacted.source, 'local')
    assert.equal(compacted.activeCheckpoint?.id, 'cp1')
    assert.ok(compacted.tokens < 5_000)

    // Mid-turn checkpoint at afterBlockIndex === lastBlockIndex: ignores stale pre-compaction reply.usage.
    const midReply = assistantMsg('a2', '', {
      blocks: [
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
        { type: 'tool_result', tool_use_id: 't1', content: 'big output', status: 'ok' },
      ],
      usage: {
        input_tokens: 75_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1_000,
      },
    })
    const midCp = makeCheckpoint('cp-mid', 'a2', { afterBlockIndex: 1, trigger: 'betweenRounds' })
    const midEstimate = estimateSessionContext({
      visibleMessages: [u1, a1, u2],
      checkpoints: [midCp],
      inProgressReply: midReply,
      modelSpec: spec,
    })
    assert.equal(midEstimate.source, 'local')
    assert.ok(midEstimate.tokens < 5_000)
  })
})

describe('compaction: verbatim selection, deterministic ledger, and summary validation', () => {
  it('selects newest user messages first, fills with assistant replies in chronological order, and skips refusals', () => {
    const messages: Message[] = [
      userMsg('u1', 'Old user prompt ' + 'x'.repeat(200)),
      assistantMsg('a1', 'Old assistant reply ' + 'y'.repeat(200)),
      userMsg('u2', 'Refused question'),
      assistantMsg('a2', 'Should be skipped', { stopReason: 'refusal' }),
      userMsg('u3', 'Newest user prompt'),
      assistantMsg('a3', 'Newest assistant reply'),
    ]

    const tight = buildVerbatimSection(messages, 45)
    assert.match(tight.text, /Newest user prompt/)
    assert.match(tight.text, /Refused question/)
    assert.doesNotMatch(tight.text, /Should be skipped/)
    assert.ok(tight.droppedMessagesCount > 0)
    // Chronological order preserved: Refused question appears before Newest user prompt.
    assert.ok(tight.text.indexOf('Refused question') < tight.text.indexOf('Newest user prompt'))
  })

  it('assembles uploaded files, user decisions, and domain-blind capability ledgers under token cap', () => {
    const syntheticCap: ToolCapability = {
      id: 'synth',
      declareTools: () => [],
      instructions: () => null,
      handles: (name) => name === 'synth_write',
      effectOf: () => 'artifact',
      run: async () => ({ content: 'ok', status: 'ok' }),
      buildCompactionLedger: (entries) => ({
        title: 'Synthetic tool outcomes',
        lines: entries.map(({ call, result }) => `- ${call.name}: ${result?.status ?? 'pending'}`),
      }),
    }
    const registry = createToolRegistry([syntheticCap])
    const messages: Message[] = [
      userMsg('u1', 'Analyze this', [
        {
          id: 'f1',
          serverId: null,
          name: 'quarterly.pdf',
          size: 2048,
          isImage: false,
          mimeType: 'application/pdf',
        },
      ]),
      assistantMsg('a1', 'Done', {
        blocks: [
          { type: 'tool_use', id: 'c1', name: 'synth_write', input: {} },
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            capability: 'synth',
            content: 'wrote',
            status: 'ok',
            frontStageNote: {
              status: 'done',
              items: [{ id: 'q1', label: 'Target format', value: 'Markdown' }],
            },
          },
          { type: 'tool_use', id: 'c2', name: 'synth_write', input: {} },
          {
            type: 'tool_result',
            tool_use_id: 'c2',
            capability: 'synth',
            content: 'boom',
            status: 'error',
          },
        ],
      }),
    ]

    const ledger = buildCompactionLedgerText({ messages, tools: registry, maxTokens: 2_000 })
    assert.match(ledger, /quarterly\.pdf/)
    assert.match(ledger, /Target format: Markdown/)
    assert.match(ledger, /Synthetic tool outcomes/)
    assert.match(ledger, /- synth_write: ok/)
    assert.match(ledger, /- synth_write: error/)

    // Enforces strict token cap on huge ledgers.
    const capped = buildCompactionLedgerText({ messages, tools: registry, maxTokens: 45 })
    assert.ok(estimateTextTokens(capped) <= 70)
    assert.match(capped, /omitted to stay within the checkpoint budget/)
  })

  it('rejects trivial or structurally broken summaries and accepts valid English or Chinese headings', () => {
    assert.equal(validateCompactionSummary('').ok, false)
    assert.equal(validateCompactionSummary('OK').ok, false)
    assert.equal(
      validateCompactionSummary('## Goal\nOnly goal section with enough characters here.').ok,
      false
    )
    assert.equal(
      validateCompactionSummary('## Next Steps\nOnly next steps with enough characters here.').ok,
      false
    )
    assert.equal(
      validateCompactionSummary(
        '## Goal\nShip compaction cleanly.\n\n## Next Steps\nWrite boundary tests.'
      ).ok,
      true
    )
    assert.equal(
      validateCompactionSummary('## 目标\n实现对话压缩系统。\n\n## 下一步\n补充边界测试。').ok,
      true
    )
  })
})

describe('compaction: branch isolation and KV-cache wire stability', () => {
  it('isolates checkpoints to their owning branch and emits byte-identical checkpoint prefixes across turns', () => {
    let session: Session = {
      id: 's1',
      title: 'Branch test',
      createdAt: 1,
      updatedAt: 1,
      rootMessageId: null,
      messages: [],
    }
    session = appendBranch(session, null, [userMsg('u1', 'Turn 1'), assistantMsg('a1', 'Reply 1')])
    session = appendBranch(session, 'a1', [
      userMsg('u2a', 'Branch A'),
      assistantMsg('a2a', 'A reply'),
    ])
    session = appendBranch(session, 'a1', [
      userMsg('u2b', 'Branch B'),
      assistantMsg('a2b', 'B reply'),
    ])

    // Checkpoint anchored on Branch A's a2a.
    const cpA = makeCheckpoint('cp-a', 'a2a')
    session = { ...session, checkpoints: [cpA] }

    // Currently on Branch B: cpA must be ignored!
    const visibleB = getVisibleMessages(session)
    assert.equal(findActiveCheckpoint(visibleB, session.checkpoints), null)
    const wireB = toRequestMessages(visibleB, userMsg('u3b', 'Follow-up on B'), {
      checkpoint: findActiveCheckpoint(visibleB, session.checkpoints) ?? undefined,
    })
    assert.equal(wireB[0]?.content, 'Turn 1')
    assert.equal(
      wireB.some((m) => String(m.content).includes('Checkpoint cp-a')),
      false
    )

    // Switch back to Branch A: Turn 3 and Turn 4 send byte-identical prefix [checkpoint, CHECKPOINT_ACK].
    const sessionA = selectVersion(session, 'u2a')
    const visibleA = getVisibleMessages(sessionA)
    const activeA = findActiveCheckpoint(visibleA, sessionA.checkpoints)
    assert.equal(activeA?.id, 'cp-a')

    const wireTurn3 = toRequestMessages(visibleA, userMsg('u3a', 'Turn 3'), {
      checkpoint: activeA ?? undefined,
    })
    assert.deepEqual(wireTurn3[0], { role: 'user', content: cpA.renderedWireText })
    assert.deepEqual(wireTurn3[1], {
      role: 'assistant',
      content: [{ type: 'text', text: CHECKPOINT_ACK }],
    })
    assert.deepEqual(wireTurn3[2], { role: 'user', content: 'Turn 3' })

    const visibleATurn4 = [...visibleA, userMsg('u3a', 'Turn 3'), assistantMsg('a3a', 'Reply 3')]
    const wireTurn4 = toRequestMessages(visibleATurn4, userMsg('u4a', 'Turn 4'), {
      checkpoint: findActiveCheckpoint(visibleATurn4, sessionA.checkpoints) ?? undefined,
    })
    assert.deepEqual(wireTurn4[0], wireTurn3[0])
    assert.deepEqual(wireTurn4[1], wireTurn3[1])
    assert.equal(wireTurn4.length, 5)
    // Strict user/assistant alternation.
    for (let i = 0; i < wireTurn4.length; i += 1) {
      assert.equal(wireTurn4[i]?.role, i % 2 === 0 ? 'user' : 'assistant')
    }
  })

  it('replays only post-checkpoint blocks after a mid-turn checkpoint and ignores it on regenerated siblings', () => {
    const history: Message[] = [userMsg('u1', 'Old turn'), assistantMsg('a1', 'Old reply')]
    const question = userMsg('u2', 'Run multi-step tool')
    const inProgress = assistantMsg('a2-v1', '', {
      status: 'streaming',
      blocks: [
        { type: 'thinking', thinking: 'pre-checkpoint thought', signature: 'sig1' },
        { type: 'tool_use', id: 'c1', name: 'tool_a', input: { step: 1 } },
        { type: 'tool_result', tool_use_id: 'c1', content: 'huge output 1', status: 'ok' },
        { type: 'tool_use', id: 'c2', name: 'tool_a', input: { step: 2 } },
        { type: 'tool_result', tool_use_id: 'c2', content: 'small output 2', status: 'ok' },
      ],
    })
    const midCp = makeCheckpoint('cp-mid', 'a2-v1', {
      trigger: 'betweenRounds',
      afterBlockIndex: 2,
      droppedReasoning: true,
    })

    // Right after round 2 tool_result: replays only blocks[3..4] after the checkpoint!
    const wireActive = toRequestMessages(history, question, {
      checkpoint: midCp,
      inProgress,
      includeInProgressThinking: true,
    })
    assert.deepEqual(wireActive[0], { role: 'user', content: midCp.renderedWireText })
    assert.equal(wireActive[1]?.role, 'assistant')
    assert.equal(wireActive[2]?.role, 'user')
    assert.equal(JSON.stringify(wireActive).includes('pre-checkpoint thought'), false)
    assert.equal(JSON.stringify(wireActive).includes('huge output 1'), false)
    assert.equal(JSON.stringify(wireActive).includes('small output 2'), true)

    // After turn finishes, next turn's messages[0] is byte-identical to wireActive[0].
    const finished: AssistantMessage = {
      ...inProgress,
      status: 'done',
      blocks: [...inProgress.blocks, { type: 'text', text: 'Final answer' }],
    }
    const wireNextTurn = toRequestMessages(
      [...history, question, finished],
      userMsg('u3', 'Next'),
      {
        checkpoint: midCp,
      }
    )
    assert.deepEqual(wireNextTurn[0], wireActive[0])
    assert.equal(wireNextTurn.at(-1)?.content, 'Next')

    // Regenerating a2 creates sibling a2-v2: findActiveCheckpoint ignores a2-v1's checkpoint.
    assert.equal(findActiveCheckpoint(history, [midCp], 'a2-v2'), null)
  })
})
