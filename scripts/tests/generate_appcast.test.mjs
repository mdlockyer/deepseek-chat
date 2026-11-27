import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAppcastXml, escapeXml, parseCliArgs } from '../generate-appcast.mjs'

const VALID_ED_SIGNATURE = Buffer.alloc(64, 0xab).toString('base64')

const baseOptions = () => ({
  version: '0.3.1',
  build: '4',
  minimumSystemVersion: '12.0',
  downloadUrl:
    'https://github.com/mdlockyer/deepseek-chat/releases/download/v0.3.1/DeepSeek_0.3.1_universal.zip',
  edSignature: VALID_ED_SIGNATURE,
  length: 27_123_456,
  fullNotesUrl: 'https://github.com/mdlockyer/deepseek-chat/releases/tag/v0.3.1',
  pubDate: 'Thu, 27 Nov 2026 12:00:00 GMT',
})

describe('generate-appcast', () => {
  it('emits a valid Sparkle 2 appcast XML document with required metadata', () => {
    const xml = buildAppcastXml(baseOptions())

    assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/)
    assert.match(xml, /xmlns:sparkle="http:\/\/www\.andymatuschak\.org\/xml-namespaces\/sparkle"/)
    assert.match(xml, /<sparkle:version>4<\/sparkle:version>/)
    assert.match(xml, /<sparkle:shortVersionString>0\.3\.1<\/sparkle:shortVersionString>/)
    assert.match(xml, /<sparkle:minimumSystemVersion>12\.0<\/sparkle:minimumSystemVersion>/)
    assert.match(xml, /<pubDate>Thu, 27 Nov 2026 12:00:00 GMT<\/pubDate>/)
    assert.match(
      xml,
      /<sparkle:fullReleaseNotesLink>https:\/\/github\.com\/mdlockyer\/deepseek-chat\/releases\/tag\/v0\.3\.1<\/sparkle:fullReleaseNotesLink>/
    )
    assert.match(
      xml,
      new RegExp(
        `<enclosure url="https://github\\.com/mdlockyer/deepseek-chat/releases/download/v0\\.3\\.1/DeepSeek_0\\.3\\.1_universal\\.zip" length="27123456" type="application/octet-stream" sparkle:edSignature="${VALID_ED_SIGNATURE.replaceAll('+', '\\+')}" />`
      )
    )
  })

  it('escapes XML special characters in URLs and text fields', () => {
    assert.equal(escapeXml(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;')

    const xml = buildAppcastXml({
      ...baseOptions(),
      channelTitle: 'DeepSeek & Friends <Mac>',
      downloadUrl:
        'https://github.com/mdlockyer/deepseek-chat/releases/download/v0.3.1/DeepSeek.zip?a=1&b=2',
    })
    assert.match(xml, /<title>DeepSeek &amp; Friends &lt;Mac&gt;<\/title>/)
    assert.match(
      xml,
      /url="https:\/\/github\.com\/mdlockyer\/deepseek-chat\/releases\/download\/v0\.3\.1\/DeepSeek\.zip\?a=1&amp;b=2"/
    )
  })

  it('rejects non-HTTPS download URLs, invalid build numbers, bad lengths, and non-64-byte signatures', () => {
    assert.throws(
      () => buildAppcastXml({ ...baseOptions(), downloadUrl: 'http://example.com/app.zip' }),
      /https:\/\//
    )
    assert.throws(() => buildAppcastXml({ ...baseOptions(), build: '0' }), /positive integer/)
    assert.throws(() => buildAppcastXml({ ...baseOptions(), build: '0.3.1' }), /positive integer/)
    assert.throws(() => buildAppcastXml({ ...baseOptions(), length: 0 }), /positive integer/)
    assert.throws(() => buildAppcastXml({ ...baseOptions(), length: -10 }), /positive integer/)
    assert.throws(
      () => buildAppcastXml({ ...baseOptions(), edSignature: Buffer.alloc(32).toString('base64') }),
      /64 bytes/
    )
    assert.throws(
      () => buildAppcastXml({ ...baseOptions(), minimumSystemVersion: 'invalid' }),
      /minimumSystemVersion/
    )
  })

  it('parses CLI flags and rejects malformed arguments', () => {
    assert.deepEqual(parseCliArgs(['--version', '0.3.1', '--build', '4']), {
      version: '0.3.1',
      build: '4',
    })
    assert.throws(() => parseCliArgs(['positional']), /Unexpected positional/)
    assert.throws(() => parseCliArgs(['--version']), /Missing value/)
    assert.throws(() => parseCliArgs(['--version', '--build', '4']), /Missing value/)
  })
})
