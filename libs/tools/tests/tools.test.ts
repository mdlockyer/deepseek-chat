import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createToolRegistry,
  withSummaryParam,
  type ToolCapability,
  type ToolRunContext,
} from '@deepseek-chat/lib-tools'

const runCtx = (): ToolRunContext => ({
  sessionId: 's1',
  replyId: 'r1',
  signal: new AbortController().signal,
  caller: { kind: 'reply' },
  citedUrls: new Map(),
  isActive: () => true,
  onProgress: () => undefined,
  readReplyState: () => undefined,
  writeReplyState: () => undefined,
})

const makeEchoCapability = (id: string, toolName: string): ToolCapability => ({
  id,
  declareTools: ({ enabledCapabilities }) =>
    enabledCapabilities[id] === false
      ? []
      : [
          {
            name: toolName,
            description: `Echo tool for ${id}.`,
            input_schema: {
              type: 'object',
              required: ['value'],
              properties: { value: { type: 'string' } },
            },
          },
        ],
  instructions: (names) => (names.has(toolName) ? `Instructions for ${id}` : null),
  handles: (name) => name === toolName,
  effectOf: () => 'read',
  run: async (call) => ({
    status: 'ok',
    content: `echo:${JSON.stringify(call.input)}`,
  }),
  serializeForArchive: (call) => [{ type: 'MARKDOWN', content: `archived:${call.name}` }],
})

describe('lib-tools: withSummaryParam', () => {
  it('prepends required summary first without mutating input schema', () => {
    const original = {
      name: 'calc',
      description: 'Calculate an expression.',
      input_schema: {
        type: 'object',
        required: ['expr'],
        properties: { expr: { type: 'string' } },
      },
    }
    const wrapped = withSummaryParam(original)
    const props = wrapped.input_schema.properties as Record<string, unknown>
    assert.deepEqual(Object.keys(props), ['summary', 'expr'])
    assert.deepEqual(wrapped.input_schema.required, ['summary', 'expr'])
    // Original was not mutated
    assert.deepEqual(Object.keys(original.input_schema.properties), ['expr'])
  })

  it('keeps an existing summary property without duplicating it', () => {
    const custom = {
      name: 'custom',
      description: 'Custom.',
      input_schema: {
        type: 'object',
        required: ['summary', 'a'],
        properties: { summary: { type: 'string', description: 'Own' }, a: { type: 'number' } },
      },
    }
    const wrapped = withSummaryParam(custom)
    assert.deepEqual(wrapped.input_schema.required, ['summary', 'a'])
    const props = wrapped.input_schema.properties as Record<string, { description?: string }>
    assert.equal(props.summary?.description, 'Own')
  })
})

describe('lib-tools: createToolRegistry', () => {
  it('rejects duplicate capability IDs', () => {
    assert.throws(
      () => createToolRegistry([makeEchoCapability('dup', 'a'), makeEchoCapability('dup', 'b')]),
      /Duplicate ToolCapability id/
    )
  })

  it('declares tools in order with summary injected and emits composition notes only when all required capabilities are active', () => {
    const reg = createToolRegistry(
      [makeEchoCapability('alpha', 'alpha_run'), makeEchoCapability('beta', 'beta_run')],
      [{ requires: ['alpha', 'beta'], audience: 'reply', text: 'Combined alpha+beta note.' }]
    )

    const both = reg.declare({
      questionText: '',
      enabledCapabilities: { alpha: true, beta: true },
    })
    assert.deepEqual(
      both.map((t) => t.name),
      ['alpha_run', 'beta_run']
    )
    for (const tool of both) {
      const props = tool.input_schema.properties as Record<string, unknown>
      assert.equal(Object.keys(props)[0], 'summary')
    }
    assert.deepEqual(reg.instructions(new Set(['alpha_run', 'beta_run']), 'reply'), [
      'Instructions for alpha',
      'Instructions for beta',
      'Combined alpha+beta note.',
    ])
    // Note omitted when only alpha is active or audience mismatches
    assert.deepEqual(reg.instructions(new Set(['alpha_run']), 'reply'), ['Instructions for alpha'])
    assert.deepEqual(reg.instructions(new Set(['alpha_run', 'beta_run']), 'agent'), [
      'Instructions for alpha',
      'Instructions for beta',
    ])
  })

  it('routes calls, resolves unknown tools as errors, and delegates archive serialization', async () => {
    const reg = createToolRegistry([makeEchoCapability('alpha', 'alpha_run')])
    assert.equal(reg.capabilityIdOf('alpha_run'), 'alpha')
    assert.equal(reg.capabilityIdOf('missing'), null)
    assert.equal(reg.effectOf('alpha_run'), 'read')
    assert.equal(reg.effectOf('missing'), 'session')

    const ok = await reg.run({ id: '1', name: 'alpha_run', input: { value: 'hi' } }, runCtx())
    assert.equal(ok.status, 'ok')
    assert.equal(ok.capabilityId, 'alpha')
    assert.equal(ok.content, 'echo:{"value":"hi"}')

    const err = await reg.run({ id: '2', name: 'missing', input: {} }, runCtx())
    assert.equal(err.status, 'error')
    assert.match(err.content, /Unknown tool: missing/)

    assert.deepEqual(
      reg.serializeForArchive({ id: '1', name: 'alpha_run', input: {} }, undefined),
      [{ type: 'MARKDOWN', content: 'archived:alpha_run' }]
    )
    assert.equal(reg.serializeForArchive({ id: '2', name: 'missing', input: {} }, undefined), null)
  })

  it('aggregates capability compaction ledger sections in registration order and skips empty ones', () => {
    const withLedger: ToolCapability = {
      ...makeEchoCapability('alpha', 'alpha_run'),
      buildCompactionLedger: (entries) =>
        entries.length > 0
          ? { title: 'Alpha facts', lines: entries.map((e) => `- ${e.call.name}`) }
          : null,
    }
    const emptyLedger: ToolCapability = {
      ...makeEchoCapability('beta', 'beta_run'),
      buildCompactionLedger: () => ({ title: 'Empty', lines: [] }),
    }
    const reg = createToolRegistry([withLedger, emptyLedger])
    const sections = reg.buildCompactionLedger(
      new Map([
        ['alpha', [{ call: { id: 'c1', name: 'alpha_run', input: {} } }]],
        ['beta', [{ call: { id: 'c2', name: 'beta_run', input: {} } }]],
      ]),
      new Map()
    )
    assert.deepEqual(sections, [{ title: 'Alpha facts', lines: ['- alpha_run'] }])
  })
})
