// Generates a Sparkle 2 appcast.xml feed for a signed macOS release archive.
//
// Usage:
//   node scripts/generate-appcast.mjs \
//     --version 0.3.1 \
//     --build 4 \
//     --min-system-version 12.0 \
//     --url https://github.com/mdlockyer/deepseek-chat/releases/download/v0.3.1/DeepSeek_0.3.1_universal.zip \
//     --signature "<base64-ed25519-signature>" \
//     --length 27000000 \
//     --full-notes-url https://github.com/mdlockyer/deepseek-chat/releases/tag/v0.3.1 \
//     --output appcast.xml

import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_URL = 'https://github.com/mdlockyer/deepseek-chat'
const ED25519_SIGNATURE_BYTES = 64

export const escapeXml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const assertHttpsUrl = (value, label) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`)
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid URL: ${value}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must use https://: ${value}`)
  }
  return value.trim()
}

const assertEdSignature = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('edSignature is required')
  }
  const trimmed = value.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error('edSignature must be valid base64')
  }
  const decoded = Buffer.from(trimmed, 'base64')
  if (decoded.length !== ED25519_SIGNATURE_BYTES) {
    throw new Error(
      `edSignature must decode to ${ED25519_SIGNATURE_BYTES} bytes, got ${decoded.length}`
    )
  }
  return trimmed
}

/**
 * Builds a Sparkle 2 appcast.xml document for a single macOS release item.
 */
export const buildAppcastXml = (options) => {
  const version = typeof options.version === 'string' ? options.version.trim() : ''
  if (!version) {
    throw new Error('version is required')
  }

  const build =
    typeof options.build === 'string' ? options.build.trim() : String(options.build ?? '')
  if (!/^[1-9]\d*$/.test(build)) {
    throw new Error(`build (CFBundleVersion) must be a positive integer string, got "${build}"`)
  }

  const minimumSystemVersion =
    typeof options.minimumSystemVersion === 'string' ? options.minimumSystemVersion.trim() : ''
  if (!/^\d+(?:\.\d+){1,2}$/.test(minimumSystemVersion)) {
    throw new Error(
      `minimumSystemVersion must be a macOS version like "12.0", got "${minimumSystemVersion}"`
    )
  }

  const downloadUrl = assertHttpsUrl(options.downloadUrl, 'downloadUrl')
  const edSignature = assertEdSignature(options.edSignature)

  const length = Number(options.length)
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error(`length must be a positive integer byte count, got "${options.length}"`)
  }

  const fullNotesUrl = options.fullNotesUrl
    ? assertHttpsUrl(options.fullNotesUrl, 'fullNotesUrl')
    : null
  const channelTitle = options.channelTitle?.trim() || 'DeepSeek'
  const channelLink = assertHttpsUrl(options.channelLink ?? REPO_URL, 'channelLink')
  const pubDate = options.pubDate?.trim() || new Date().toUTCString()

  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${escapeXml(channelTitle)}</title>`,
    `    <link>${escapeXml(channelLink)}</link>`,
    '    <description>Most recent releases of DeepSeek for macOS.</description>',
    '    <language>en</language>',
    '    <item>',
    `      <title>Version ${escapeXml(version)}</title>`,
    `      <sparkle:version>${escapeXml(build)}</sparkle:version>`,
    `      <sparkle:shortVersionString>${escapeXml(version)}</sparkle:shortVersionString>`,
    `      <sparkle:minimumSystemVersion>${escapeXml(minimumSystemVersion)}</sparkle:minimumSystemVersion>`,
    `      <pubDate>${escapeXml(pubDate)}</pubDate>`,
  ]

  if (fullNotesUrl) {
    lines.push(
      `      <sparkle:fullReleaseNotesLink>${escapeXml(fullNotesUrl)}</sparkle:fullReleaseNotesLink>`
    )
  }

  lines.push(
    `      <enclosure url="${escapeXml(downloadUrl)}" length="${length}" type="application/octet-stream" sparkle:edSignature="${escapeXml(edSignature)}" />`,
    '    </item>',
    '  </channel>',
    '</rss>',
    ''
  )

  return lines.join('\n')
}

export const parseCliArgs = (argv) => {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`)
    }
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    args[key] = value
    i += 1
  }
  return args
}

const main = async () => {
  const args = parseCliArgs(process.argv.slice(2))
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const tauriConf = JSON.parse(
    await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')
  )

  let length = args.length ? Number(args.length) : undefined
  if (args.archive) {
    const info = await stat(args.archive)
    length = info.size
  }

  const xml = buildAppcastXml({
    version: args.version ?? pkg.version,
    build: args.build ?? tauriConf.bundle?.macOS?.bundleVersion,
    minimumSystemVersion:
      args['min-system-version'] ?? tauriConf.bundle?.macOS?.minimumSystemVersion,
    downloadUrl: args.url,
    edSignature: args.signature,
    length,
    fullNotesUrl: args['full-notes-url'],
    pubDate: args['pub-date'],
  })

  if (args.output) {
    await writeFile(args.output, xml, 'utf8')
    process.stdout.write(`Wrote Sparkle appcast to ${args.output}\n`)
  } else {
    process.stdout.write(xml)
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main()
}
