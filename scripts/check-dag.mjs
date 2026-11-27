#!/usr/bin/env node
/**
 * Clean-Slate Architecture (CSA) / Sealed Slice boundary & discipline check.
 *
 * Workspace isolation (`pnpm`) + TypeScript Project References (`tsc -b`) enforce package walls
 * natively at compile time. This script enforces the structural invariants the compiler cannot:
 * - MANIFEST & TSCONFIG: tier DAG in `package.json`, single `"."` public export, `tsconfig.json`
 *   references matching declared workspace deps, `tsconfig.prod.json` banning `test-support`,
 *   and every package registered in the root solution `tsconfig.json`;
 * - SPINE: domain-blind parts (`runtime`, `ports`, `design`) never touch `facts`, `spine/design`
 *   has no `.tsx` components, and zero orphan Spine facts (each fact used by >= 2 prod packages);
 * - RELATIVE / TEST BOUNDARIES: no relative escapes across package boundaries (including CSS and
 *   `new URL(...)`), and `tests/` never reaches into `../src`;
 * - ANATOMY & LIFECYCLE (S1–S5): `SPEC.md` + `src/index.ts(x)` + `tests/`, factory-scoped stores
 *   and IndexedDB handles (S1), `create*Slice` returning `dispose` (S2), no `lateBindings` (S3),
 *   domain-blind conversations (S4), and slice-owned settings/storage keys (S5).
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
const testSupportDir = path.join(root, 'test-support')
const appDir = path.join(root, 'app')
const workbenchDir = path.join(appDir, 'workbench')
const appTestsDir = path.join(appDir, 'tests')

const SCOPE = '@deepseek-chat/'
const SPINE_PKG = `${SCOPE}spine`
const TEST_SUPPORT_PKG = `${SCOPE}test-support`
const SLICE_PKG_PREFIX = `${SCOPE}slice-`
const LIB_PKG_PREFIX = `${SCOPE}lib-`
const LIB_UI_PKG = `${LIB_PKG_PREFIX}ui`
const DOMAIN_BLIND = ['runtime', 'ports', 'design'].map((dir) => path.join(spineDir, dir))
const FACTS_DIR = path.join(spineDir, 'facts')
const SPINE_DESIGN_DIR = path.join(spineDir, 'design')
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|css)$/
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/
const LIBS_REQUIRING_SPEC = new Set(['ui', 'stage', 'tools'])

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
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

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
    out += depth === 0 || ch === '\n' ? ch : ' '
    i += 1
  }
  return out
}

const listSubdirs = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : []

const sliceNames = listSubdirs(slicesDir)
const libNames = listSubdirs(libsDir)
const sliceDirs = new Map(sliceNames.map((name) => [name, path.join(slicesDir, name)]))
const libDirs = new Map(libNames.map((name) => [name, path.join(libsDir, name)]))

const workspaceDirForPkg = (pkgName) => {
  if (pkgName === SPINE_PKG) {
    return spineDir
  }
  if (pkgName === TEST_SUPPORT_PKG) {
    return testSupportDir
  }
  if (pkgName.startsWith(LIB_PKG_PREFIX)) {
    return libDirs.get(pkgName.slice(LIB_PKG_PREFIX.length)) ?? null
  }
  if (pkgName.startsWith(SLICE_PKG_PREFIX)) {
    return sliceDirs.get(pkgName.slice(SLICE_PKG_PREFIX.length)) ?? null
  }
  return null
}

const resolveTsconfigRef = (fromDir, refPath) => {
  const full = path.resolve(fromDir, refPath)
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    return path.join(full, 'tsconfig.json')
  }
  return full
}

const rootSolution = readJson(path.join(root, 'tsconfig.json'))
const rootRefSet = new Set(
  (rootSolution.references ?? []).map((ref) => resolveTsconfigRef(root, ref.path))
)
const prodTsconfigPath = path.join(root, 'tsconfig.prod.json')

const checkPackageTsconfigs = (kind, name, dir, workspaceProdDeps) => {
  const prodCfgPath = path.join(dir, 'tsconfig.json')
  const testCfgPath = path.join(dir, 'tsconfig.test.json')

  if (!fs.existsSync(prodCfgPath)) {
    fail('TSCONFIG', `${kind} "${name}" is missing tsconfig.json`)
    return
  }
  if (!fs.existsSync(testCfgPath)) {
    fail('TSCONFIG', `${kind} "${name}" is missing tsconfig.test.json`)
  }
  if (!rootRefSet.has(prodCfgPath)) {
    fail('TSCONFIG', `${rel(prodCfgPath)} is not listed in root tsconfig.json references`)
  }
  if (fs.existsSync(testCfgPath) && !rootRefSet.has(testCfgPath)) {
    fail('TSCONFIG', `${rel(testCfgPath)} is not listed in root tsconfig.json references`)
  }

  const prodCfg = readJson(prodCfgPath)
  const expectedExtends =
    kind === 'test-support' ? path.join(root, 'tsconfig.base.json') : prodTsconfigPath
  const actualExtends = prodCfg.extends ? path.resolve(dir, prodCfg.extends) : null
  if (actualExtends !== expectedExtends) {
    fail(
      'TSCONFIG',
      `${rel(prodCfgPath)} must extend ${rel(expectedExtends)} (found ${prodCfg.extends ?? 'none'})`
    )
  }

  const expectedRefs = new Set()
  for (const dep of workspaceProdDeps) {
    const depDir = workspaceDirForPkg(dep)
    if (depDir) {
      expectedRefs.add(path.join(depDir, 'tsconfig.json'))
    }
  }
  const actualRefs = new Set(
    (prodCfg.references ?? []).map((ref) => resolveTsconfigRef(dir, ref.path))
  )
  for (const ref of expectedRefs) {
    if (!actualRefs.has(ref)) {
      fail('TSCONFIG', `${rel(prodCfgPath)} is missing project reference to ${rel(ref)}`)
    }
  }
  for (const ref of actualRefs) {
    if (!expectedRefs.has(ref)) {
      fail(
        'TSCONFIG',
        `${rel(prodCfgPath)} references ${rel(ref)} without a matching package.json dependency`
      )
    }
  }
}

const checkManifest = (kind, name, dir, expectedPkg) => {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    fail('ANATOMY', `${kind} "${name}" is missing package.json`)
    return []
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
  return prodDeps.filter((dep) => dep.startsWith(SCOPE))
}

/** Verifies relative imports stay inside `dir` and `tests/` never reaches into `src/`. */
const checkRelativeBoundaries = (kind, name, dir, expectedPkg, file, imports) => {
  const testsDir = path.join(dir, 'tests')
  const srcDir = path.join(dir, 'src')
  for (const spec of imports) {
    if (spec.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), spec)
      if (!isInside(dir, resolved)) {
        fail('DAG', `${kind} "${name}" file ${rel(file)} crosses its boundary via "${spec}"`)
      } else if (isInside(testsDir, file) && isInside(srcDir, resolved)) {
        fail(
          'TESTS',
          `${kind} "${name}" test ${rel(file)} reaches into src/ via "${spec}"; import ${expectedPkg}`
        )
      }
    }
  }
}

// 1. Spine: tsconfig, domain-blind rules, no .tsx in spine/design, zero orphan facts.
checkPackageTsconfigs('spine', 'spine', spineDir, [])
for (const file of listSourceFiles(spineDir)) {
  if (isInside(SPINE_DESIGN_DIR, file) && file.endsWith('.tsx')) {
    fail(
      'SPINE',
      `spine/design file ${rel(file)} contains UI components (.tsx); move interactive primitives to libs/ui`
    )
  }
  const domainBlind = DOMAIN_BLIND.some((dir) => isInside(dir, file))
  for (const spec of extractImports(file)) {
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

// 2. Libraries: anatomy, manifest, tsconfig, relative/test boundaries, domain-free spine usage.
for (const [name, dir] of libDirs) {
  const expectedPkg = `${LIB_PKG_PREFIX}${name}`
  if (LIBS_REQUIRING_SPEC.has(name) && !fs.existsSync(path.join(dir, 'SPEC.md'))) {
    fail('ANATOMY', `library "${name}" is missing SPEC.md`)
  }
  if (!['index.ts', 'index.tsx'].some((entry) => fs.existsSync(path.join(dir, 'src', entry)))) {
    fail('ANATOMY', `library "${name}" is missing src/index.ts(x)`)
  }
  if (!fs.existsSync(path.join(dir, 'tests'))) {
    fail('ANATOMY', `library "${name}" is missing tests/`)
  }
  const wsProdDeps = checkManifest('library', name, dir, expectedPkg)
  checkPackageTsconfigs('library', name, dir, wsProdDeps)

  for (const file of listSourceFiles(dir)) {
    const imports = extractImports(file)
    checkRelativeBoundaries('library', name, dir, expectedPkg, file, imports)
    for (const spec of imports) {
      if (spec.startsWith(`${SPINE_PKG}/facts`) || spec.startsWith(`${SPINE_PKG}/runtime`)) {
        fail('DAG', `library "${name}" file ${rel(file)} imports domain spine part "${spec}"`)
      }
    }
  }
}

// 3. Slices: anatomy, manifest, tsconfig, relative/test boundaries, plus S1, S2, S4.
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
  const wsProdDeps = checkManifest('slice', name, dir, expectedPkg)
  checkPackageTsconfigs('slice', name, dir, wsProdDeps)

  const srcDir = path.join(dir, 'src')
  for (const file of listSourceFiles(dir)) {
    const imports = extractImports(file)
    checkRelativeBoundaries('slice', name, dir, expectedPkg, file, imports)

    if (isInside(srcDir, file) && CODE_EXT.test(file)) {
      const source = fs.readFileSync(file, 'utf8')
      const topLevel = extractTopLevelCode(source)

      if (imports.includes('zustand') && /\bcreate\s*(?:<[^()]*>)?\s*\(/.test(topLevel)) {
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

// 4. Dev-only test-support package: manifest, tsconfig, relative boundaries.
if (fs.existsSync(testSupportDir)) {
  const wsProdDeps = checkManifest('test-support', 'test-support', testSupportDir, TEST_SUPPORT_PKG)
  checkPackageTsconfigs('test-support', 'test-support', testSupportDir, wsProdDeps)
  for (const file of listSourceFiles(testSupportDir)) {
    checkRelativeBoundaries(
      'test-support',
      'test-support',
      testSupportDir,
      TEST_SUPPORT_PKG,
      file,
      extractImports(file)
    )
  }
}

// 5. App tier: core tsconfig extends tsconfig.prod.json, no path escapes, S3, S5.
const appCoreCfgPath = path.join(appDir, 'tsconfig.core.json')
if (!fs.existsSync(appCoreCfgPath)) {
  fail('TSCONFIG', 'app/tsconfig.core.json is missing')
} else {
  const appCoreCfg = readJson(appCoreCfgPath)
  const actualExtends = appCoreCfg.extends ? path.resolve(appDir, appCoreCfg.extends) : null
  if (actualExtends !== prodTsconfigPath) {
    fail('TSCONFIG', `app/tsconfig.core.json must extend ${rel(prodTsconfigPath)}`)
  }
  if (!rootRefSet.has(appCoreCfgPath)) {
    fail('TSCONFIG', 'app/tsconfig.core.json is not listed in root tsconfig.json references')
  }
}

for (const file of listSourceFiles(appDir)) {
  if (/latebindings/i.test(path.basename(file))) {
    fail('S3-LATE-BINDINGS', `forbidden late-bindings module ${rel(file)}`)
  }
  const imports = extractImports(file)
  for (const spec of imports) {
    if (/latebindings/i.test(spec)) {
      fail('S3-LATE-BINDINGS', `${rel(file)} imports forbidden late-bindings module "${spec}"`)
    }
    if (spec.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), spec)
      if (!isInside(appDir, resolved) && !isInside(root, resolved)) {
        fail('DAG', `${rel(file)} escapes repo via "${spec}"`)
      } else if (
        isInside(slicesDir, resolved) ||
        isInside(libsDir, resolved) ||
        isInside(spineDir, resolved) ||
        isInside(testSupportDir, resolved)
      ) {
        fail(
          'DAG',
          `${rel(file)} reaches into workspace package by path "${spec}"; use package name`
        )
      }
    }
  }

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

// 6. Zero orphan Spine facts: every exported fact type must be used by >= 2 distinct prod packages.
const spinePkg = readJson(path.join(spineDir, 'package.json'))
const spineExportTargets = new Set(
  Object.values(spinePkg.exports ?? {}).map((target) => path.resolve(spineDir, target))
)

const factDefinitions = []
for (const factFile of listSourceFiles(FACTS_DIR)) {
  if (!spineExportTargets.has(factFile)) {
    fail('ORPHAN-FACT', `spine fact file ${rel(factFile)} is not exported in spine/package.json`)
  }
  const source = fs.readFileSync(factFile, 'utf8')
  for (const match of source.matchAll(
    /export\s+type\s+([A-Z]\w*)\s*=\s*\{[\s\S]*?readonly\s+type\s*:\s*['"]([A-Z]\w*)['"]/g
  )) {
    factDefinitions.push({ name: match[1], file: rel(factFile) })
  }
}

const prodUnits = [
  ...sliceNames.map((name) => ({
    unit: `slice:${name}`,
    files: listSourceFiles(path.join(slicesDir, name, 'src')).filter((f) => CODE_EXT.test(f)),
  })),
  ...libNames.map((name) => ({
    unit: `lib:${name}`,
    files: listSourceFiles(path.join(libsDir, name, 'src')).filter((f) => CODE_EXT.test(f)),
  })),
  {
    unit: 'app',
    files: listSourceFiles(appDir).filter(
      (f) => CODE_EXT.test(f) && !isInside(workbenchDir, f) && !isInside(appTestsDir, f)
    ),
  },
]

const unitBodies = prodUnits.map(({ unit, files }) => ({
  unit,
  text: files.map((file) => fs.readFileSync(file, 'utf8')).join('\n'),
}))

for (const fact of factDefinitions) {
  const re = new RegExp(`\\b${fact.name}\\b`)
  const users = unitBodies.filter(({ text }) => re.test(text)).map(({ unit }) => unit)
  if (users.length < 2) {
    fail(
      'ORPHAN-FACT',
      `Spine fact "${fact.name}" (${fact.file}) is only referenced by ${users.length} prod package(s) [${users.join(', ')}]; facts belong in spine/facts only when >= 2 packages communicate`
    )
  }
}

if (errors.length > 0) {
  process.stderr.write(
    `CSA boundary check FAILED (${errors.length} violation(s)):\n${errors
      .map((error) => `  - ${error}`)
      .join('\n')}\n`
  )
  process.exit(1)
}

process.stdout.write(
  `CSA boundary check passed: spine (${factDefinitions.length} active facts), ${libNames.length} library(ies) (${libNames.join(', ')}), ${sliceNames.length} slice(s) (${sliceNames.join(', ')}), app tier, tsconfig refs, and S1–S5 verified.\n`
)
