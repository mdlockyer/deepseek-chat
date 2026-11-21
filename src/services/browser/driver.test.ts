import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildClickScript,
  buildHideSomBadgesScript,
  buildPageEvalScript,
  buildPressKeyScript,
  buildScrollScript,
  buildSelectScript,
  buildShowSomBadgesScript,
  buildSnapshotScript,
  buildTypeScript,
  buildWaitProbeScript,
} from './driver.js'

describe('browser driver scripts', () => {
  it('compiles every synchronous DOM driver script cleanly without syntax errors', () => {
    const scripts = [
      buildSnapshotScript(),
      buildShowSomBadgesScript(),
      buildShowSomBadgesScript(0.4),
      buildHideSomBadgesScript(),
      buildClickScript({ ref: 'e1' }),
      buildClickScript({ x: 120, y: 240, button: 'right', doubleClick: true }),
      buildTypeScript({ ref: 'e2', text: 'hello "world"', clear: true, submit: true }),
      buildPressKeyScript({ key: 'Enter', modifiers: ['meta', 'shift'] }),
      buildScrollScript({ direction: 'down', amount: 400 }),
      buildSelectScript({ ref: 'e3', values: ['US', 'CA'] }),
      buildWaitProbeScript({ selector: '.ready', text: 'Done', urlContains: 'example.com' }),
    ]

    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script))
    }
  })

  it('redacts password input values inside buildSnapshotScript', () => {
    const script = buildSnapshotScript()
    assert.match(script, /el\.type === 'password'/)
    assert.match(script, /\[REDACTED\]/)
  })

  it('wraps single expressions and statement bodies without eval or new Function inside buildPageEvalScript', () => {
    const exprScript = buildPageEvalScript('document.title')
    assert.doesNotMatch(exprScript, /new Function/)
    assert.match(exprScript, /return \(document\.title\);/)

    const bodyScript = buildPageEvalScript('const x = 1; return x + 2;')
    assert.doesNotMatch(bodyScript, /new Function/)
    assert.match(bodyScript, /const x = 1; return x \+ 2;/)
  })

  it('executes buildPageEvalScript via AsyncFunction on both expressions and async bodies', async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      body: string
    ) => () => Promise<string>

    const exprOut = JSON.parse(await new AsyncFunction(buildPageEvalScript('40 + 2'))()) as {
      ok: boolean
      value: unknown
    }
    assert.deepEqual(exprOut, { ok: true, value: 42 })

    const errOut = JSON.parse(
      await new AsyncFunction(buildPageEvalScript('throw new Error("boom")'))()
    ) as {
      ok: boolean
      error: string
    }
    assert.equal(errOut.ok, false)
    assert.match(errOut.error, /boom/)
  })

  it('scales SoM badge font size inversely when zoomed down', () => {
    const zoomed = buildShowSomBadgesScript(0.4)
    assert.match(zoomed, /600 25px\/30px/)
  })
})
