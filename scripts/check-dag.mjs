#!/usr/bin/env node
/**
 * Sealed Slice Architecture boundary & discipline check.
 *
 * Tiers: app (app/) -> slices/* -> libs/* -> spine. Enforces:
 * - DAG: strict tier ordering, zero lateral slice imports, single "." public export per package,
 *   no deep imports, tests import package names only;
 * - ANATOMY: each slice has SPEC.md, src/index.ts(x), tests/;
 * - S1 (NO-SINGLETON): no module-level Zustand `create(` or `indexedDB.open(`/`openDB(` in slices;
 * - S2 (DISPOSE): every slice entrypoint exports a `create*Slice` factory returning `dispose`;
 * - S3 (NO-LATE-BINDINGS): no `lateBindings` files or imports anywhere in `app/`;
 * - S4 (DOMAIN-BLIND-CONVERSATIONS): no sibling-slice tool/runtime identifiers in conversations/src;
 * - S5 (APP-OWNERSHIP): no direct `SettingRow` or feature `chat-demo:*` keys in production `app/`.
 *
 * Exits 1 with every violation listed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const spineDir = path.join(root, 'spine')
const slicesDir = path.join(root, 'slices')
const libsDir = path.join(root, 'libs')
const appDirs = [path.join(root, 'app')]

const SCOPE = '@deepseek-chat/'
const SPINE_PKG = `${SCOPE}spine`
const TEST_SUPPORT_PKG = `${SCOPE}test-support`
const SLICE_PKG_PREFIX = `${SCOPE}slice-`
const LIB_PKG_PREFIX = `${SCOPE}lib-`
const testSupportDir = path.join(root, 'test-support')
const DOMAIN_BLIND = ['runtime', 'ports', 'design'].map((dir) => path.join(spineDir, dir))
const FACTS_DIR = path.join(spineDir, 'facts')
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|css)$/
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/

const S4_BANNED_IN_CONVERSATIONS = [
  'pyodide',
  'firecrawl',
  'browserAction',
  'fileAction',
  'askAction',
  'ask_user',
  'AskUser',
  'present_file',
  'edit_file',
  'read_file',
  'web_scrape',
  'subagentRuntime',
]
const S4_REGEX = new RegExp(`\\b(?:${S4_BANNED_IN_CONVERSATIONS.join('|')})\\b`, 'g')
const S5_ALLOWED_APP_STORAGE_KEYS = new Set(['chat-demo:browser-panel-width'])

const errors = []
const fail = (kind, message) => errors.push(`[${kind}] ${message}`)
const rel = (file) => path.relative(root, file)
const isInside = (dir, file) => file === dir || file.startsWith(dir + path.sep)

const listSourceFiles = (dir) => {
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
      out.push(...listSourceFiles(full))
    } else if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  /@import\s+(?:url\()?['"]([^'"]+)['"]/g,
]

const extractImports = (file) => {
  const text = fs.readFileSync(file, 'utf8')
  const specs = new Set()
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      specs.add(match[1])
    }
  }
  return [...specs]
}

/**
 * Strips comments and string/template literals while preserving line numbers and brace structure,
 * returning only top-level (brace-depth 0) code segments for S1 module-scope checks.
 */
const extractTopLevelCode = (source) => {
  let out = ''
  let depth = 0
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    // Line comment
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        i += 1
      }
      continue
    }
    // Block comment
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
    // Single or double quoted string
    if (ch === "'" || ch === '"') {
      const quote = ch
      i += 1
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === '\n') {
          out += '\n'
        }
        i += 1
      }
      i += 1
      continue
    }
    // Template literal
    if (ch === '`') {
      i += 1
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === '\n') {
          out += '\n'
        }
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '{') {
      depth += 1
      out += ' '
      i += 1
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      out += ' '
      i += 1
      continue
    }
    if (depth === 0 || ch === '\n') {
      out += ch
    } else {
      out += ' '
    }
    i += 1
  }
  return out
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

const sliceNames = fs.existsSync(slicesDir)
  ? fs
      .readdirSync(slicesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : []
const libNames = fs.existsSync(libsDir)
  ? fs
      .readdirSync(libsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : []
const libDirs = new Map(libNames.map((name) => [name, path.join(libsDir, name)]))
const libOfFile = (file) => libNames.find((name) => isInside(libDirs.get(name), file))
const libOfPackage = (spec) => {
  if (!spec.startsWith(LIB_PKG_PREFIX)) {
    return null
  }
  const [name, ...subpath] = spec.slice(LIB_PKG_PREFIX.length).split('/')
  return { name, deep: subpath.length > 0 }
}

const sliceDirs = new Map(sliceNames.map((name) => [name, path.join(slicesDir, name)]))
const sliceOfFile = (file) => sliceNames.find((name) => isInside(sliceDirs.get(name), file))
const sliceOfPackage = (spec) => {
  if (!spec.startsWith(SLICE_PKG_PREFIX)) {
    return null
  }
  const [name, ...subpath] = spec.slice(SLICE_PKG_PREFIX.length).split('/')
  return { name, deep: subpath.length > 0 }
}

// 1. Spine: imports nothing above it; domain-blind parts don't touch facts; spine/design holds no .tsx components.
const SPINE_DESIGN_DIR = path.join(spineDir, 'design')
for (const file of listSourceFiles(spineDir)) {
  if (isInside(SPINE_DESIGN_DIR, file) && file.endsWith('.tsx')) {
    fail(
      'SPINE',
      `spine/design file ${rel(file)} contains UI components (.tsx); move interactive primitives to libs/ui`
    )
  }
  const domainBlind = DOMAIN_BLIND.some((dir) => isInside(dir, file))
  for (const spec of extractImports(file)) {
    if (
      spec.startsWith(SLICE_PKG_PREFIX) ||
      spec.startsWith(LIB_PKG_PREFIX) ||
      spec === TEST_SUPPORT_PKG ||
      spec.startsWith(`${TEST_SUPPORT_PKG}/`)
    ) {
      fail('DAG', `spine file ${rel(file)} imports "${spec}"`)
    }
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(file), spec)
      if (!isInside(spineDir, target)) {
        fail('DAG', `spine file ${rel(file)} escapes spine/ via "${spec}"`)
      } else if (domainBlind && isInside(FACTS_DIR, target)) {
        fail('SPINE', `domain-blind file ${rel(file)} imports spine/facts via "${spec}"`)
      }
    }
    if (domainBlind && spec.startsWith(`${SPINE_PKG}/facts`)) {
      fail('SPINE', `domain-blind file ${rel(file)} imports "${spec}"`)
    }
  }
}

const LIB_UI_PKG = `${LIB_PKG_PREFIX}ui`
const LIBS_REQUIRING_SPEC = new Set(['ui', 'stage', 'tools'])

const checkManifest = (kind, name, dir, expectedPkg) => {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    fail('ANATOMY', `${kind} "${name}" is missing package.json`)
    return
  }
  const pkg = readJson(pkgPath)
  if (pkg.name !== expectedPkg) {
    fail('ANATOMY', `${kind} "${name}" package name is "${pkg.name}", expected "${expectedPkg}"`)
  }
  const exportKeys = pkg.exports && typeof pkg.exports === 'object' ? Object.keys(pkg.exports) : []
  if (exportKeys.length !== 1 || exportKeys[0] !== '.') {
    fail(
      'ANATOMY',
      `${kind} "${name}" must export exactly "." (found ${JSON.stringify(exportKeys)})`
    )
  }
  const prodDeps = Object.keys({
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  })
  const devDeps = Object.keys({ ...pkg.devDependencies })
  for (const dep of prodDeps) {
    const allowed =
      dep === SPINE_PKG ||
      (kind === 'slice' && dep.startsWith(LIB_PKG_PREFIX)) ||
      (kind === 'library' && name !== 'ui' && dep === LIB_UI_PKG)
    if (dep.startsWith(SCOPE) && !allowed) {
      fail('DAG', `${kind} "${name}" depends on workspace package "${dep}"`)
    }
  }
  for (const dep of devDeps) {
    const allowed =
      dep === SPINE_PKG ||
      dep === TEST_SUPPORT_PKG ||
      (kind === 'slice' && dep.startsWith(LIB_PKG_PREFIX)) ||
      (kind === 'library' && name !== 'ui' && dep === LIB_UI_PKG)
    if (dep.startsWith(SCOPE) && !allowed) {
      fail('DAG', `${kind} "${name}" devDepends on workspace package "${dep}"`)
    }
  }
}

// 2. Libraries: anatomy, manifest, and imports.
for (const [name, dir] of libDirs) {
  if (LIBS_REQUIRING_SPEC.has(name) && !fs.existsSync(path.join(dir, 'SPEC.md'))) {
    fail('ANATOMY', `library "${name}" is missing SPEC.md`)
  }
  const hasEntry = ['index.ts', 'index.tsx'].some((entry) =>
    fs.existsSync(path.join(dir, 'src', entry))
  )
  if (!hasEntry) {
    fail('ANATOMY', `library "${name}" is missing src/index.ts(x)`)
  }
  if (!fs.existsSync(path.join(dir, 'tests'))) {
    fail('ANATOMY', `library "${name}" is missing tests/`)
  }
  checkManifest('library', name, dir, `${LIB_PKG_PREFIX}${name}`)
  const testsDir = path.join(dir, 'tests')
  const srcDir = path.join(dir, 'src')
  for (const file of listSourceFiles(dir)) {
    for (const spec of extractImports(file)) {
      const ownPackage = libOfPackage(spec)?.name === name && !libOfPackage(spec)?.deep
      const importsLibUi = name !== 'ui' && spec === LIB_UI_PKG
      const importsTestSupport = spec === TEST_SUPPORT_PKG && isInside(testsDir, file)
      if (spec.startsWith(SCOPE) && !ownPackage && !importsLibUi && !importsTestSupport) {
        if (spec === TEST_SUPPORT_PKG || spec.startsWith(`${TEST_SUPPORT_PKG}/`)) {
          fail(
            'TEST-SUPPORT',
            `library "${name}" production file ${rel(file)} imports dev-only "${spec}"`
          )
        } else if (!spec.startsWith(`${SPINE_PKG}/`)) {
          fail('DAG', `library "${name}" file ${rel(file)} imports workspace package "${spec}"`)
        } else if (
          spec.startsWith(`${SPINE_PKG}/facts`) ||
          spec.startsWith(`${SPINE_PKG}/runtime`)
        ) {
          fail('DAG', `library "${name}" file ${rel(file)} imports domain spine part "${spec}"`)
        }
      }
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec)
        if (!isInside(dir, resolved)) {
          fail('DAG', `library "${name}" file ${rel(file)} crosses its boundary via "${spec}"`)
        } else if (isInside(testsDir, file) && isInside(srcDir, resolved)) {
          fail(
            'TESTS',
            `library "${name}" test ${rel(file)} reaches into src/ via "${spec}"; import ${LIB_PKG_PREFIX}${name}`
          )
        }
      }
    }
  }
}

// 3. Slices: anatomy, manifest, imports, plus SSA mechanical rules S1, S2, S4.
for (const [name, dir] of sliceDirs) {
  const expectedPkg = `${SLICE_PKG_PREFIX}${name}`
  const entryPath = ['index.ts', 'index.tsx']
    .map((entry) => path.join(dir, 'src', entry))
    .find((candidate) => fs.existsSync(candidate))
  if (!fs.existsSync(path.join(dir, 'SPEC.md'))) {
    fail('ANATOMY', `slice "${name}" is missing SPEC.md`)
  }
  if (!entryPath) {
    fail('ANATOMY', `slice "${name}" is missing src/index.ts(x)`)
  } else {
    // S2: every slice entrypoint must export a `create*Slice` factory returning `dispose`.
    const entrySource = fs.readFileSync(entryPath, 'utf8')
    const factoryMatch = /export\s+const\s+(create[A-Z]\w*Slice)\b/.exec(entrySource)
    if (!factoryMatch) {
      fail('S2-DISPOSE', `slice "${name}" entrypoint ${rel(entryPath)} must export create*Slice`)
    } else if (!/\bdispose\b/.test(entrySource.slice(factoryMatch.index))) {
      fail(
        'S2-DISPOSE',
        `slice "${name}" factory ${factoryMatch[1]} in ${rel(entryPath)} must return a dispose() method`
      )
    }
  }
  if (!fs.existsSync(path.join(dir, 'tests'))) {
    fail('ANATOMY', `slice "${name}" is missing tests/`)
  }
  checkManifest('slice', name, dir, expectedPkg)

  const testsDir = path.join(dir, 'tests')
  const srcDir = path.join(dir, 'src')
  for (const file of listSourceFiles(dir)) {
    const imports = extractImports(file)
    for (const spec of imports) {
      const target = sliceOfPackage(spec)
      if (target) {
        if (target.name !== name) {
          fail('DAG', `slice "${name}" file ${rel(file)} imports slice "${spec}"`)
        }
      } else if (libOfPackage(spec)?.deep) {
        fail('DAG', `slice "${name}" file ${rel(file)} deep-imports library internals "${spec}"`)
      } else if (spec === TEST_SUPPORT_PKG || spec.startsWith(`${TEST_SUPPORT_PKG}/`)) {
        if (!isInside(testsDir, file) || spec !== TEST_SUPPORT_PKG) {
          fail(
            'TEST-SUPPORT',
            `slice "${name}" file ${rel(file)} may only import "${TEST_SUPPORT_PKG}" inside tests/`
          )
        }
      } else if (
        spec.startsWith(SCOPE) &&
        spec !== SPINE_PKG &&
        !spec.startsWith(`${SPINE_PKG}/`) &&
        !libOfPackage(spec)
      ) {
        fail('DAG', `slice "${name}" file ${rel(file)} imports workspace package "${spec}"`)
      }
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec)
        if (!isInside(dir, resolved)) {
          fail('DAG', `slice "${name}" file ${rel(file)} crosses its boundary via "${spec}"`)
        } else if (isInside(testsDir, file) && isInside(srcDir, resolved)) {
          fail(
            'TESTS',
            `slice "${name}" test ${rel(file)} reaches into src/ via "${spec}"; import ${SLICE_PKG_PREFIX}${name}`
          )
        }
      }
    }

    if (isInside(srcDir, file) && CODE_EXT.test(file)) {
      const source = fs.readFileSync(file, 'utf8')
      const topLevel = extractTopLevelCode(source)

      // S1: no module-level Zustand `create(` or `indexedDB.open(`/`openDB(` in slices.
      const importsZustand = imports.includes('zustand')
      if (importsZustand && /\bcreate\s*(?:<[^()]*>)?\s*\(/.test(topLevel)) {
        fail(
          'S1-SINGLETON',
          `slice "${name}" file ${rel(file)} creates a Zustand store at module scope; create stores inside a factory`
        )
      }
      if (/\b(?:indexedDB\.open|openDB)\s*\(/.test(topLevel)) {
        fail(
          'S1-SINGLETON',
          `slice "${name}" file ${rel(file)} opens IndexedDB at module scope; scope DB handles inside a factory`
        )
      }

      // S4: conversations must stay domain-blind to sibling tool slices.
      if (name === 'conversations') {
        const hits = [...new Set([...source.matchAll(S4_REGEX)].map((m) => m[0]))]
        if (hits.length > 0) {
          fail(
            'S4-DOMAIN-BLIND',
            `conversations file ${rel(file)} references sibling-slice identifier(s): ${hits.join(', ')}`
          )
        }
      }
    }
  }
}

// 4. Dev-only test-support package: may import only spine (domain-blind parts) and itself.
if (fs.existsSync(testSupportDir)) {
  checkManifest('test-support', 'test-support', testSupportDir, TEST_SUPPORT_PKG)
  const tsTestsDir = path.join(testSupportDir, 'tests')
  const tsSrcDir = path.join(testSupportDir, 'src')
  for (const file of listSourceFiles(testSupportDir)) {
    for (const spec of extractImports(file)) {
      const own = spec === TEST_SUPPORT_PKG
      if (spec.startsWith(SCOPE) && !own && !spec.startsWith(`${SPINE_PKG}/`)) {
        fail('DAG', `test-support file ${rel(file)} imports "${spec}"`)
      }
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec)
        if (!isInside(testSupportDir, resolved)) {
          fail('DAG', `test-support file ${rel(file)} escapes boundary via "${spec}"`)
        } else if (isInside(tsTestsDir, file) && isInside(tsSrcDir, resolved)) {
          fail(
            'TESTS',
            `test-support test ${rel(file)} reaches into src/ via "${spec}"; import ${TEST_SUPPORT_PKG}`
          )
        }
      }
    }
  }
}

// 5. App tier: single-export DAG rules plus S3, S5, and dev-only test-support guard.
const workbenchDir = path.join(root, 'app', 'workbench')
const appTestsDir = path.join(root, 'app', 'tests')
for (const appDir of appDirs) {
  for (const file of listSourceFiles(appDir)) {
    // S3: no lateBindings files or imports in app/.
    if (/latebindings/i.test(path.basename(file))) {
      fail('S3-LATE-BINDINGS', `forbidden late-bindings module ${rel(file)}`)
    }
    const imports = extractImports(file)
    for (const spec of imports) {
      if (/latebindings/i.test(spec)) {
        fail('S3-LATE-BINDINGS', `${rel(file)} imports forbidden late-bindings module "${spec}"`)
      }
      if (spec === TEST_SUPPORT_PKG || spec.startsWith(`${TEST_SUPPORT_PKG}/`)) {
        if (!isInside(appTestsDir, file) && !isInside(workbenchDir, file)) {
          fail('TEST-SUPPORT', `production app file ${rel(file)} imports dev-only "${spec}"`)
        } else if (spec !== TEST_SUPPORT_PKG) {
          fail('DAG', `${rel(file)} deep-imports test-support internals "${spec}"`)
        }
      }
      const target = sliceOfPackage(spec)
      if (target?.deep) {
        fail('DAG', `${rel(file)} deep-imports slice internals "${spec}"`)
      }
      if (libOfPackage(spec)?.deep) {
        fail('DAG', `${rel(file)} deep-imports library internals "${spec}"`)
      }
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec)
        const slice = sliceOfFile(resolved)
        if (slice) {
          fail('DAG', `${rel(file)} reaches into slice "${slice}" by path "${spec}"`)
        }
        const lib = libOfFile(resolved)
        if (lib) {
          fail('DAG', `${rel(file)} reaches into library "${lib}" by path "${spec}"`)
        }
        if (isInside(spineDir, resolved)) {
          fail('DAG', `${rel(file)} reaches into spine/ by path "${spec}"; import ${SPINE_PKG}/*`)
        }
      }
    }

    // S5: production app/ owns no SettingRow rows and no feature chat-demo:* storage keys.
    if (CODE_EXT.test(file) && !isInside(workbenchDir, file) && !isInside(appTestsDir, file)) {
      const source = fs.readFileSync(file, 'utf8')
      if (/\bSettingRow\b/.test(source)) {
        fail(
          'S5-APP-OWNERSHIP',
          `app file ${rel(file)} renders SettingRow directly; settings rows belong to their owning slice`
        )
      }
      const keyMatches = [...source.matchAll(/['"](chat-demo:[a-z0-9-]+)['"]/gi)].map((m) => m[1])
      const forbiddenKeys = [
        ...new Set(keyMatches.filter((k) => !S5_ALLOWED_APP_STORAGE_KEYS.has(k))),
      ]
      if (forbiddenKeys.length > 0) {
        fail(
          'S5-APP-OWNERSHIP',
          `app file ${rel(file)} hardcodes slice-owned storage key(s): ${forbiddenKeys.join(', ')}`
        )
      }
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(
    `SSA boundary check FAILED (${errors.length} violation(s)):\n${errors
      .map((error) => `  - ${error}`)
      .join('\n')}\n`
  )
  process.exit(1)
}

process.stdout.write(
  `SSA boundary check passed: spine, ${libNames.length} library(ies)${
    libNames.length > 0 ? ` (${libNames.join(', ')})` : ''
  }, ${sliceNames.length} slice(s)${
    sliceNames.length > 0 ? ` (${sliceNames.join(', ')})` : ''
  }, app tier. Rules S1–S5 verified. No lateral imports.\n`
)
