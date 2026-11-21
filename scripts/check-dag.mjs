#!/usr/bin/env node
/**
 * Sealed Slice Architecture boundary check.
 *
 * Tiers: app (src/, transitional) -> slices/* -> spine. Enforces:
 * - spine imports no slice or app code, and spine/{runtime,ports,design} import no spine/facts;
 * - a slice imports only itself, @deepseek-chat/spine/*, and external packages;
 * - a slice's package.json depends on no other workspace slice and exports exactly ".";
 * - code outside a slice reaches it only through its package name, never a deep or relative path;
 * - each slice has SPEC.md, src/index.ts(x), and tests/.
 *
 * Exits 1 with every violation listed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const spineDir = path.join(root, 'spine')
const slicesDir = path.join(root, 'slices')
const appDirs = [path.join(root, 'src')]

const SCOPE = '@deepseek-chat/'
const SPINE_PKG = `${SCOPE}spine`
const SLICE_PKG_PREFIX = `${SCOPE}slice-`
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
    if (spec.startsWith(SLICE_PKG_PREFIX)) {
      fail('DAG', `spine file ${rel(file)} imports slice "${spec}"`)
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

// 2. Slices: anatomy, manifest, and imports.
for (const [name, dir] of sliceDirs) {
  const expectedPkg = `${SLICE_PKG_PREFIX}${name}`
  const pkgPath = path.join(dir, 'package.json')
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
  if (!fs.existsSync(pkgPath)) {
    fail('ANATOMY', `slice "${name}" is missing package.json`)
  } else {
    const pkg = readJson(pkgPath)
    if (pkg.name !== expectedPkg) {
      fail('ANATOMY', `slice "${name}" package name is "${pkg.name}", expected "${expectedPkg}"`)
    }
    const exportKeys =
      pkg.exports && typeof pkg.exports === 'object' ? Object.keys(pkg.exports) : []
    if (exportKeys.length !== 1 || exportKeys[0] !== '.') {
      fail(
        'ANATOMY',
        `slice "${name}" must export exactly "." (found ${JSON.stringify(exportKeys)})`
      )
    }
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    })
    for (const dep of deps) {
      if (dep.startsWith(SCOPE) && dep !== SPINE_PKG) {
        fail('DAG', `slice "${name}" depends on workspace package "${dep}"`)
      }
    }
  }

  for (const file of listSourceFiles(dir)) {
    for (const spec of extractImports(file)) {
      const target = sliceOfPackage(spec)
      if (target) {
        fail('DAG', `slice "${name}" file ${rel(file)} imports slice "${spec}"`)
      } else if (
        spec.startsWith(SCOPE) &&
        spec !== SPINE_PKG &&
        !spec.startsWith(`${SPINE_PKG}/`)
      ) {
        fail('DAG', `slice "${name}" file ${rel(file)} imports workspace package "${spec}"`)
      }
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec)
        if (!isInside(dir, resolved)) {
          fail('DAG', `slice "${name}" file ${rel(file)} crosses its boundary via "${spec}"`)
        }
      }
    }
  }
}

// 3. App tier and everything else: slices only through their single public export.
for (const appDir of appDirs) {
  for (const file of listSourceFiles(appDir)) {
    for (const spec of extractImports(file)) {
      const target = sliceOfPackage(spec)
      if (target?.deep) {
        fail('DAG', `${rel(file)} deep-imports slice internals "${spec}"`)
      }
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec)
        const slice = sliceOfFile(resolved)
        if (slice) {
          fail('DAG', `${rel(file)} reaches into slice "${slice}" by path "${spec}"`)
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
  `SSA boundary check passed: spine, ${sliceNames.length} slice(s)${
    sliceNames.length > 0 ? ` (${sliceNames.join(', ')})` : ''
  }, app tier. No lateral imports.\n`
)
