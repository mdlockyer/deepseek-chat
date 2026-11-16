// Prepares vendor/pyodide/ for builds that ship Pyodide with the app
// (`PYODIDE_LOCAL=1`, used by the desktop build).
//
// - Copies the runtime (pyodide.mjs, pyodide.asm.*, python_stdlib.zip) from the
//   `pyodide` npm package, whose version must match PYODIDE_VERSION in
//   src/services/python/kernel.ts.
// - Downloads the wheels for BUNDLED and everything they depend on from
//   jsDelivr, checking each against the sha256 in pyodide-lock.json. Wheels
//   already present with the right hash are kept.
// - Writes a lock file in which every package that is not bundled points at
//   jsDelivr by absolute URL, so it still loads when the user is online.
//
// Usage: node scripts/fetch-pyodide.mjs

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Packages shipped with the app, plus their dependencies. Others load from the CDN. */
const BUNDLED = ['micropip', 'numpy', 'pandas', 'matplotlib', 'pillow']

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'node_modules', 'pyodide')
const target = path.join(root, 'vendor', 'pyodide')
const RUNTIME = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip']

const { version } = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
const cdn = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`
const lock = JSON.parse(await readFile(path.join(source, 'pyodide-lock.json'), 'utf8'))

/** BUNDLED and all of their dependencies, by lock-file package name */
const closure = new Set()
const visit = (name) => {
  const key = name.toLowerCase()
  if (closure.has(key)) {
    return
  }
  const entry = lock.packages[key]
  if (!entry) {
    throw new Error(`${name} is not in pyodide-lock.json ${version}`)
  }
  closure.add(key)
  entry.depends.forEach(visit)
}
BUNDLED.forEach(visit)

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

await mkdir(target, { recursive: true })
for (const file of RUNTIME) {
  await copyFile(path.join(source, file), path.join(target, file))
}

let downloaded = 0
let bytes = 0
for (const key of closure) {
  const entry = lock.packages[key]
  const file = path.join(target, entry.file_name)
  let data = await readFile(file).catch(() => null)
  if (!data || sha256(data) !== entry.sha256) {
    const response = await fetch(cdn + entry.file_name)
    if (!response.ok) {
      throw new Error(`${cdn}${entry.file_name}: HTTP ${response.status}`)
    }
    data = Buffer.from(await response.arrayBuffer())
    if (sha256(data) !== entry.sha256) {
      throw new Error(`${entry.file_name}: sha256 does not match pyodide-lock.json`)
    }
    await writeFile(file, data)
    downloaded += 1
  }
  bytes += data.length
}

// Remove wheels left over from an earlier BUNDLED list or Pyodide version.
const keep = new Set([
  ...RUNTIME,
  'pyodide-lock.json',
  ...[...closure].map((key) => lock.packages[key].file_name),
])
for (const file of await readdir(target)) {
  if (!keep.has(file)) {
    await rm(path.join(target, file))
  }
}

for (const [key, entry] of Object.entries(lock.packages)) {
  if (!closure.has(key)) {
    entry.file_name = cdn + entry.file_name
  }
}
await writeFile(path.join(target, 'pyodide-lock.json'), JSON.stringify(lock))

console.log(
  `Pyodide ${version}: ${closure.size} packages bundled (${downloaded} downloaded), ` +
    `${(bytes / 1024 / 1024).toFixed(1)} MB of wheels in vendor/pyodide`
)
