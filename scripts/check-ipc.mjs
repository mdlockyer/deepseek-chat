#!/usr/bin/env node
/**
 * Rust <-> TypeScript IPC & shared policy parity gate.
 *
 * Verifies the cross-language seam between `src-tauri/` and `app/platform/desktop.ts`:
 * 1. Every `#[tauri::command]` in `src-tauri/src/*.rs` matches `tauri::generate_handler![...]` in `lib.rs` 1-to-1.
 * 2. Every registered Rust command matches an `invoke('...')` call in `app/platform/desktop.ts` 1-to-1,
 *    and no other TS module imports `@tauri-apps/api/core` or `@tauri-apps/api/event`.
 * 3. Every Rust `.emit(...)` / `.emit_to(...)` event name matches a listener in `app/platform/desktop.ts` 1-to-1.
 * 4. Shared security/UX policy constants across Rust, native Python, Web Pyodide, and TypeScript stay in sync.
 *
 * Exits 1 with every violation listed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rustSrcDir = path.join(root, 'src-tauri', 'src')
const desktopBridgePath = path.join(root, 'app', 'platform', 'desktop.ts')

const errors = []
const fail = (kind, message) => errors.push(`[${kind}] ${message}`)
const rel = (file) => path.relative(root, file)

const read = (file) => fs.readFileSync(file, 'utf8')

/**
 * Strips `//` and `/* ... *\/` comments while keeping string literals intact
 * (so URLs / event names like `"browser://state"` are never truncated).
 */
const stripLineAndBlockComments = (source, allowSingleQuote) => {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') {
          out += '\n'
        }
        i += 1
      }
      i += 2
      continue
    }
    if (ch === '"' || (allowSingleQuote && (ch === "'" || ch === '`'))) {
      const quote = ch
      out += ch
      i += 1
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          out += source[i] + source[i + 1]
          i += 2
          continue
        }
        out += source[i]
        i += 1
      }
      if (i < n) {
        out += source[i]
        i += 1
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const stripRustComments = (source) => stripLineAndBlockComments(source, false)
const stripJsComments = (source) => stripLineAndBlockComments(source, true)

/**
 * Evaluates a simple numeric constant expression consisting only of numbers
 * (with optional `_` separators) and `*` / `+` / `-` / `/` operators.
 */
const parseNumericExpr = (raw) => {
  const cleaned = raw.replace(/_/g, '').trim()
  if (!/^[0-9.+*/\s-]+$/.test(cleaned)) {
    return null
  }
  const addTerms = cleaned.split('+').map((term) => term.trim())
  let sum = 0
  for (const term of addTerms) {
    const factors = term.split('*').map((factor) => factor.trim())
    let product = 1
    for (const factor of factors) {
      const value = Number(factor)
      if (!Number.isFinite(value)) {
        return null
      }
      product *= value
    }
    sum += product
  }
  return sum
}

const readConstant = (filePath, pattern, label) => {
  const source = read(filePath)
  const match = pattern.exec(source)
  if (!match) {
    fail('POLICY', `Could not find ${label} in ${rel(filePath)}`)
    return null
  }
  const value = parseNumericExpr(match[1])
  if (value === null) {
    fail('POLICY', `Could not parse numeric value "${match[1]}" for ${label} in ${rel(filePath)}`)
    return null
  }
  return value
}

const listTsFiles = (dir) => {
  if (!fs.existsSync(dir)) {
    return []
  }
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full))
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

// 1. Parse Rust `#[tauri::command]` definitions and `generate_handler![]` registrations.
const rustFiles = fs
  .readdirSync(rustSrcDir)
  .filter((name) => name.endsWith('.rs'))
  .sort()
  .map((name) => path.join(rustSrcDir, name))

const definedCommands = new Map()
const emittedEvents = new Map()

for (const file of rustFiles) {
  const source = stripRustComments(read(file))

  // Local `const NAME: &str = "value";` lookup table for resolving event names.
  const strConsts = new Map()
  for (const match of source.matchAll(
    /\b(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Z0-9_]+)\s*:\s*&str\s*=\s*"([^"]+)"\s*;/g
  )) {
    strConsts.set(match[1], match[2])
  }

  for (const match of source.matchAll(
    /#\[tauri::command(?:\([^\]]*\))?\][\s\S]*?(?:\bpub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(/g
  )) {
    const cmd = match[1]
    if (definedCommands.has(cmd)) {
      fail('IPC-CMD', `Duplicate #[tauri::command] "${cmd}" in ${rel(file)}`)
    }
    definedCommands.set(cmd, rel(file))
  }

  const recordEvent = (rawArg) => {
    const token = rawArg.trim()
    let resolved = null
    if (token.startsWith('"') && token.endsWith('"')) {
      resolved = token.slice(1, -1)
    } else if (strConsts.has(token)) {
      resolved = strConsts.get(token)
    }
    if (!resolved) {
      fail('IPC-EVENT', `Unresolvable Rust event expression "${token}" in ${rel(file)}`)
      return
    }
    if (!emittedEvents.has(resolved)) {
      emittedEvents.set(resolved, new Set())
    }
    emittedEvents.get(resolved).add(rel(file))
  }

  for (const match of source.matchAll(/\.emit\(\s*("(?:[^"]+)"|[A-Z0-9_]+)\s*,/g)) {
    recordEvent(match[1])
  }
  for (const match of source.matchAll(/\.emit_to\(\s*[^,]+,\s*("(?:[^"]+)"|[A-Z0-9_]+)\s*,/g)) {
    recordEvent(match[1])
  }
}

const libRsPath = path.join(rustSrcDir, 'lib.rs')
const libRsSource = stripRustComments(read(libRsPath))
const handlerMatch = /tauri::generate_handler!\s*\[([\s\S]*?)\]/.exec(libRsSource)
const registeredCommands = new Set()

if (!handlerMatch) {
  fail('IPC-CMD', `Missing tauri::generate_handler![...] in ${rel(libRsPath)}`)
} else {
  for (const rawEntry of handlerMatch[1].split(',')) {
    const entry = rawEntry.trim()
    if (!entry) {
      continue
    }
    const name = entry.split('::').at(-1)?.trim() ?? ''
    if (!name) {
      continue
    }
    if (registeredCommands.has(name)) {
      fail('IPC-CMD', `Duplicate command "${name}" in generate_handler![]`)
    }
    registeredCommands.add(name)
  }
}

for (const cmd of registeredCommands) {
  if (!definedCommands.has(cmd)) {
    fail('IPC-CMD', `Registered command "${cmd}" in lib.rs has no #[tauri::command] definition`)
  }
}
for (const [cmd, file] of definedCommands) {
  if (!registeredCommands.has(cmd)) {
    fail('IPC-CMD', `Defined #[tauri::command] "${cmd}" in ${file} is not registered in lib.rs`)
  }
}

// 2. Parse TypeScript IPC calls & listeners in `app/platform/desktop.ts` and ensure no scattered Tauri IPC.
for (const dir of ['app', 'slices', 'libs', 'spine']) {
  for (const file of listTsFiles(path.join(root, dir))) {
    if (file === desktopBridgePath) {
      continue
    }
    const source = read(file)
    if (/@tauri-apps\/api\/(?:core|event)/.test(source)) {
      fail(
        'IPC-BOUNDARY',
        `${rel(file)} imports @tauri-apps/api/core or /event directly; route IPC through ${rel(desktopBridgePath)}`
      )
    }
  }
}

const desktopSource = stripJsComments(read(desktopBridgePath))
const invokedCommands = new Set()
for (const match of desktopSource.matchAll(/\binvoke(?:<[^()]*>)?\(\s*['"]([^'"]+)['"]/g)) {
  invokedCommands.add(match[1])
}

for (const cmd of invokedCommands) {
  if (!registeredCommands.has(cmd)) {
    fail(
      'IPC-CMD',
      `TS invokes "${cmd}" in ${rel(desktopBridgePath)}, which is not registered in src-tauri/src/lib.rs`
    )
  }
}
for (const cmd of registeredCommands) {
  if (!invokedCommands.has(cmd)) {
    fail(
      'IPC-CMD',
      `Rust command "${cmd}" in src-tauri/src/lib.rs is never invoked in ${rel(desktopBridgePath)}`
    )
  }
}

const listenedEvents = new Set()
for (const match of desktopSource.matchAll(
  /\b(?:listen|listenEvent)(?:<[^()]*>)?\(\s*['"]([^'"]+)['"]/g
)) {
  listenedEvents.add(match[1])
}

for (const eventName of listenedEvents) {
  if (!emittedEvents.has(eventName)) {
    fail(
      'IPC-EVENT',
      `TS listens for "${eventName}" in ${rel(desktopBridgePath)}, which Rust never emits`
    )
  }
}
for (const eventName of emittedEvents.keys()) {
  if (!listenedEvents.has(eventName)) {
    fail(
      'IPC-EVENT',
      `Rust emits "${eventName}" (${[...emittedEvents.get(eventName)].join(', ')}), which TS never listens for`
    )
  }
}

// 3. Shared policy constants parity across Rust, native Python, Web Pyodide, and TypeScript.
const rustMinZoom = readConstant(
  path.join(rustSrcDir, 'browser.rs'),
  /\bconst\s+MIN_VIEWPORT_ZOOM\s*:\s*f64\s*=\s*([^;]+);/,
  'MIN_VIEWPORT_ZOOM'
)
const tsMinZoom = readConstant(
  path.join(root, 'libs', 'stage', 'src', 'viewport.ts'),
  /\bexport\s+const\s+MIN_VIEWPORT_ZOOM\s*=\s*([^\n;]+)/,
  'MIN_VIEWPORT_ZOOM'
)
if (rustMinZoom !== null && tsMinZoom !== null && rustMinZoom !== tsMinZoom) {
  fail('POLICY', `MIN_VIEWPORT_ZOOM mismatch: Rust (${rustMinZoom}) !== libs/stage (${tsMinZoom})`)
}

const rustMaxTabs = readConstant(
  path.join(rustSrcDir, 'browser.rs'),
  /\bconst\s+MAX_OPEN_TABS\s*:\s*usize\s*=\s*([^;]+);/,
  'MAX_OPEN_TABS'
)
const tsMaxLiveTabs = readConstant(
  path.join(root, 'slices', 'browser', 'kernel', 'types.ts'),
  /\bconst\s+MAX_LIVE_NATIVE_TABS\s*=\s*([^\n;]+)/,
  'MAX_LIVE_NATIVE_TABS'
)
if (rustMaxTabs !== null && tsMaxLiveTabs !== null && tsMaxLiveTabs > rustMaxTabs) {
  fail(
    'POLICY',
    `MAX_LIVE_NATIVE_TABS (${tsMaxLiveTabs}) exceeds Rust MAX_OPEN_TABS (${rustMaxTabs})`
  )
}

const rustMaxFiles = readConstant(
  path.join(rustSrcDir, 'python.rs'),
  /\bconst\s+MAX_PRESENTED_FILES\s*:\s*usize\s*=\s*([^;]+);/,
  'MAX_PRESENTED_FILES'
)
const nativePyMaxFiles = readConstant(
  path.join(rustSrcDir, 'python_worker.py'),
  /^MAX_FILES\s*=\s*([^\n#]+)/m,
  'MAX_FILES'
)
const webPyMaxFiles = readConstant(
  path.join(root, 'slices', 'python', 'src', 'worker.ts'),
  /^__MAX_FILES\s*=\s*([^\n#]+)/m,
  '__MAX_FILES'
)
if (
  rustMaxFiles !== null &&
  nativePyMaxFiles !== null &&
  webPyMaxFiles !== null &&
  !(rustMaxFiles === nativePyMaxFiles && nativePyMaxFiles === webPyMaxFiles)
) {
  fail(
    'POLICY',
    `Python presented-files cap mismatch: Rust (${rustMaxFiles}), native worker (${nativePyMaxFiles}), web worker (${webPyMaxFiles})`
  )
}

const rustMaxFileBytes = readConstant(
  path.join(rustSrcDir, 'python.rs'),
  /\bconst\s+MAX_PRESENTED_FILE_BYTES\s*:\s*u64\s*=\s*([^;]+);/,
  'MAX_PRESENTED_FILE_BYTES'
)
const nativePyMaxFileBytes = readConstant(
  path.join(rustSrcDir, 'python_worker.py'),
  /^MAX_FILE_BYTES\s*=\s*([^\n#]+)/m,
  'MAX_FILE_BYTES'
)
const webPyMaxFileBytes = readConstant(
  path.join(root, 'slices', 'python', 'src', 'worker.ts'),
  /^__MAX_FILE_BYTES\s*=\s*([^\n#]+)/m,
  '__MAX_FILE_BYTES'
)
if (
  rustMaxFileBytes !== null &&
  nativePyMaxFileBytes !== null &&
  webPyMaxFileBytes !== null &&
  !(rustMaxFileBytes === nativePyMaxFileBytes && nativePyMaxFileBytes === webPyMaxFileBytes)
) {
  fail(
    'POLICY',
    `Python presented-file byte limit mismatch: Rust (${rustMaxFileBytes}), native worker (${nativePyMaxFileBytes}), web worker (${webPyMaxFileBytes})`
  )
}

if (errors.length > 0) {
  process.stderr.write(
    `IPC parity check FAILED (${errors.length} violation(s)):\n${errors
      .map((error) => `  - ${error}`)
      .join('\n')}\n`
  )
  process.exit(1)
}

process.stdout.write(
  `IPC parity check passed: ${registeredCommands.size} command(s), ${emittedEvents.size} event(s), 4 shared policy invariants verified.\n`
)
