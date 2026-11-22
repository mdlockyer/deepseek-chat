#!/usr/bin/env node
/**
 * Sealed Slice Architecture boundary check.
 *
 * Tiers: app (app/) -> slices/* -> libs/* -> spine. Enforces:
 * - spine imports no library, slice or app code, and spine/{runtime,ports,design} import no
 *   spine/facts;
 * - a library (domain-free code shared by slices) imports only itself, the spine's domain-blind
 *   parts, and external packages;
 * - a slice imports only itself, @deepseek-chat/spine/*, libraries, and external packages;
 * - a slice's or library's package.json depends on no slice and exports exactly ".";
 * - code outside a slice or library reaches it only through its package name, never a deep or
 *   relative path;
 * - each slice has SPEC.md, src/index.ts(x), and tests/; each library has src/index.ts(x) and
 *   tests/.
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
const SLICE_PKG_PREFIX = `${SCOPE}slice-`
const LIB_PKG_PREFIX = `${SCOPE}lib-`
const DOMAIN_BLIND = ['runtime', 'ports', 'design'].map((dir) => path.join(spineDir, dir))
const FACTS_DIR = path.join(spineDir, 'facts')
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|css)$/

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
  // import x from '…', import '…', export … from '…', import type … from '…'
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  // import('…')
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  // new URL('…', import.meta.url) — workers and assets
  /\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  // CSS @import '…'
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

// 1. Spine: imports nothing above it; domain-blind parts don't touch facts.
for (const file of listSourceFiles(spineDir)) {
  const domainBlind = DOMAIN_BLIND.some((dir) => isInside(dir, file))
  for (const spec of extractImports(file)) {
    if (spec.startsWith(SLICE_PKG_PREFIX) || spec.startsWith(LIB_PKG_PREFIX)) {
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

/** package.json shape shared by slices and libraries. */
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
  const deps = Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  })
  for (const dep of deps) {
    const allowed = dep === SPINE_PKG || (kind === 'slice' && dep.startsWith(LIB_PKG_PREFIX))
    if (dep.startsWith(SCOPE) && !allowed) {
      fail('DAG', `${kind} "${name}" depends on workspace package "${dep}"`)
    }
  }
}

// 2. Libraries: anatomy, manifest, and imports (spine's domain-blind parts and externals only).
for (const [name, dir] of libDirs) {
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
      if (spec.startsWith(SCOPE) && !ownPackage) {
        if (!spec.startsWith(`${SPINE_PKG}/`)) {
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

// 3. Slices: anatomy, manifest, and imports.
for (const [name, dir] of sliceDirs) {
  const expectedPkg = `${SLICE_PKG_PREFIX}${name}`
  const hasEntry = ['index.ts', 'index.tsx'].some((entry) =>
    fs.existsSync(path.join(dir, 'src', entry))
  )
  if (!fs.existsSync(path.join(dir, 'SPEC.md'))) {
    fail('ANATOMY', `slice "${name}" is missing SPEC.md`)
  }
  if (!hasEntry) {
    fail('ANATOMY', `slice "${name}" is missing src/index.ts(x)`)
  }
  if (!fs.existsSync(path.join(dir, 'tests'))) {
    fail('ANATOMY', `slice "${name}" is missing tests/`)
  }
  checkManifest('slice', name, dir, expectedPkg)

  const testsDir = path.join(dir, 'tests')
  const srcDir = path.join(dir, 'src')
  for (const file of listSourceFiles(dir)) {
    for (const spec of extractImports(file)) {
      const target = sliceOfPackage(spec)
      if (target) {
        if (target.name !== name) {
          fail('DAG', `slice "${name}" file ${rel(file)} imports slice "${spec}"`)
        }
      } else if (libOfPackage(spec)?.deep) {
        fail('DAG', `slice "${name}" file ${rel(file)} deep-imports library internals "${spec}"`)
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
  }
}

// 4. App tier and everything else: slices and libraries only through their single public export.
for (const appDir of appDirs) {
  for (const file of listSourceFiles(appDir)) {
    for (const spec of extractImports(file)) {
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
  }, app tier. No lateral imports.\n`
)
