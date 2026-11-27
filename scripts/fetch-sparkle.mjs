// Downloads and verifies the pinned Sparkle 2 macOS framework & CLI tools into
// `vendor/sparkle/` (gitignored). Idempotent: skips network access when the
// matching version is already extracted.
//
// Usage: node scripts/fetch-sparkle.mjs

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SPARKLE_VERSION = '2.10.1'
export const SPARKLE_ARCHIVE_SHA256 =
  '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27'
export const SPARKLE_ARCHIVE_URL = `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz`

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = path.join(root, 'vendor', 'sparkle')
const versionStampPath = path.join(targetDir, '.version')
const frameworkBinaryPath = path.join(targetDir, 'Sparkle.framework', 'Versions', 'B', 'Sparkle')
const signUpdatePath = path.join(targetDir, 'bin', 'sign_update')

const exists = async (filePath) => {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

const isCurrent = async () => {
  const stamp = await readFile(versionStampPath, 'utf8').catch(() => null)
  if (stamp?.trim() !== SPARKLE_VERSION) {
    return false
  }
  return (await exists(frameworkBinaryPath)) && (await exists(signUpdatePath))
}

const main = async () => {
  if (process.platform !== 'darwin') {
    process.stdout.write(
      `Sparkle ${SPARKLE_VERSION}: skipped on ${process.platform} (macOS only)\n`
    )
    return
  }
  if (await isCurrent()) {
    process.stdout.write(`Sparkle ${SPARKLE_VERSION}: already ready in vendor/sparkle\n`)
    return
  }

  process.stdout.write(`Downloading Sparkle ${SPARKLE_VERSION}...\n`)
  const response = await fetch(SPARKLE_ARCHIVE_URL)
  if (!response.ok) {
    throw new Error(`Failed to download ${SPARKLE_ARCHIVE_URL}: HTTP ${response.status}`)
  }
  const archiveBytes = Buffer.from(await response.arrayBuffer())
  const actualSha = createHash('sha256').update(archiveBytes).digest('hex')
  if (actualSha !== SPARKLE_ARCHIVE_SHA256) {
    throw new Error(
      `Sparkle ${SPARKLE_VERSION} sha256 mismatch: expected ${SPARKLE_ARCHIVE_SHA256}, got ${actualSha}`
    )
  }

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  const archivePath = path.join(targetDir, `Sparkle-${SPARKLE_VERSION}.tar.xz`)
  await writeFile(archivePath, archiveBytes)

  try {
    execFileSync('tar', ['-xf', archivePath, '-C', targetDir], { stdio: 'inherit' })
  } finally {
    await rm(archivePath, { force: true })
  }

  if (!(await exists(frameworkBinaryPath)) || !(await exists(signUpdatePath))) {
    throw new Error(`Sparkle ${SPARKLE_VERSION} extraction is missing expected binaries`)
  }
  await writeFile(versionStampPath, `${SPARKLE_VERSION}\n`, 'utf8')
  process.stdout.write(`Sparkle ${SPARKLE_VERSION}: extracted and verified in vendor/sparkle\n`)
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main()
}
