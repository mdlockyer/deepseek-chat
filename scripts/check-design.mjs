#!/usr/bin/env node
/**
 * Sealed Slice Architecture (SSA) design-system mechanical gate.
 *
 * Enforces D1-D7 across spine/design, libs/*, slices/*, and app/:
 * - D1: Zero raw color literals (#hex, rgb/rgba, hsl/hsla, oklch/oklab) outside tokens.css and
 *       syntax-highlighting theme (libs/markdown/src/highlight.css).
 * - D2: Zero private primitive (--_p-*) or legacy (--dsw-*, --ds-*) token references outside
 *       tokens.css.
 * - D3: Single-source dark mode — zero [data-theme], data-ds-dark-theme, body.dark/light, or
 *       prefers-color-scheme selectors outside tokens.css and app/theme.ts.
 * - D4: Every var(--ui-*) token reference is defined in spine/design/tokens.css.
 * - D5: Zero raw numeric z-index >= 10 in CSS (use var(--ui-z-*)).
 * - D6: Domain-blindness guard in spine/design and libs/ui/src.
 * - D7: Automated WCAG 2.2 AA contrast verification on spine/design/tokens.css (light & dark).
 *
 * Exits 1 with every violation listed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tokensPath = path.join(root, 'spine/design/tokens.css')
const highlightPath = path.join(root, 'libs/markdown/src/highlight.css')
const appThemePath = path.join(root, 'app/theme.ts')
const tokensTestPath = path.join(root, 'libs/ui/tests/tokens.test.ts')

const errors = []
const fail = (rule, message) => errors.push(`[${rule}] ${message}`)
const rel = (file) => path.relative(root, file)

const listFiles = (dir, extRe) => {
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
      out.push(...listFiles(full, extRe))
    } else if (extRe.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

const stripCssComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
const lineNumberAt = (text, index) => text.slice(0, index).split('\n').length

const tokensCss = fs.readFileSync(tokensPath, 'utf8')

const extractBlockVars = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm').exec(css)
  if (!match) {
    fail('D7', `Missing CSS block for selector "${selector}" in spine/design/tokens.css`)
    return new Map()
  }
  const vars = new Map()
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '')
  for (const decl of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(decl[1], decl[2].trim())
  }
  return vars
}

const lightVars = extractBlockVars(tokensCss, ':root')
const darkVars = extractBlockVars(tokensCss, ":root[data-theme='dark']")
const definedUiTokens = new Set([...lightVars.keys()].filter((name) => name.startsWith('--ui-')))

// D7: Automated WCAG 2.2 AA contrast & token symmetry verification on tokens.css
const resolveVar = (name, themeVars, baseVars, depth = 0) => {
  if (depth >= 8) {
    fail('D7', `Circular CSS variable reference at ${name}`)
    return null
  }
  const raw = themeVars.get(name) ?? baseVars.get(name)
  if (raw === undefined) {
    fail('D7', `Undefined CSS variable ${name}`)
    return null
  }
  const ref = /^var\((--[\w-]+)\)$/.exec(raw)
  return ref ? resolveVar(ref[1], themeVars, baseVars, depth + 1) : raw
}

const parseRgb = (color) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(color)
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }
  return null
}

const luminance = ([r, g, b]) => {
  const linear = (channel) => {
    const s = channel / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

const contrastRatio = (fgRgb, bgRgb) => {
  const l1 = luminance(fgRgb)
  const l2 = luminance(bgRgb)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

for (const key of darkVars.keys()) {
  if (!key.startsWith('--ui-')) {
    fail('D7', `Dark theme must not redefine private primitive ${key}`)
  } else if (!lightVars.has(key)) {
    fail('D7', `Dark theme token ${key} has no light-theme counterpart`)
  }
}

const TEXT_CONTRAST_PAIRS = [
  ['--ui-text-primary', '--ui-surface-canvas'],
  ['--ui-text-primary', '--ui-surface-elevated'],
  ['--ui-text-primary', '--ui-surface-popover'],
  ['--ui-text-primary', '--ui-surface-rail'],
  ['--ui-text-secondary', '--ui-surface-canvas'],
  ['--ui-text-secondary', '--ui-surface-popover'],
  ['--ui-text-muted', '--ui-surface-canvas'],
  ['--ui-text-muted', '--ui-surface-rail'],
  ['--ui-text-placeholder', '--ui-surface-input'],
  ['--ui-text-accent', '--ui-surface-canvas'],
  ['--ui-text-accent', '--ui-accent-soft'],
  ['--ui-text-danger', '--ui-surface-canvas'],
  ['--ui-text-danger', '--ui-surface-elevated'],
  ['--ui-text-on-accent', '--ui-accent-fill'],
  ['--ui-text-on-accent', '--ui-accent-hover'],
  ['--ui-text-on-danger', '--ui-danger-fill'],
  ['--ui-text-on-danger', '--ui-danger-hover'],
  ['--ui-success-on-soft', '--ui-success-soft'],
  ['--ui-warning-on-soft', '--ui-warning-soft'],
  ['--ui-text-on-toast', '--ui-surface-toast'],
  ['--ui-text-on-toast-link', '--ui-surface-toast'],
  ['--ui-text-on-accent', '--ui-surface-tooltip'],
]

const UI_CONTRAST_PAIRS = [
  ['--ui-focus-ring', '--ui-surface-canvas'],
  ['--ui-focus-ring', '--ui-surface-popover'],
  ['--ui-border-focus-neutral', '--ui-surface-input'],
  ['--ui-handle-fill', '--ui-surface-code'],
]

for (const [themeName, themeMap] of [
  ['light', lightVars],
  ['dark', darkVars],
]) {
  for (const [fgVar, bgVar] of TEXT_CONTRAST_PAIRS) {
    const fg = resolveVar(fgVar, themeMap, lightVars)
    const bg = resolveVar(bgVar, themeMap, lightVars)
    if (!fg || !bg) {
      continue
    }
    const fgRgb = parseRgb(fg)
    const bgRgb = parseRgb(bg)
    if (!fgRgb || !bgRgb) {
      fail('D7', `[${themeName}] non-opaque color in pair ${fgVar} (${fg}) / ${bgVar} (${bg})`)
      continue
    }
    const ratio = contrastRatio(fgRgb, bgRgb)
    if (ratio < 4.5) {
      fail(
        'D7',
        `[${themeName}] text contrast ${fgVar} (${fg}) on ${bgVar} (${bg}) = ${ratio.toFixed(2)}:1 (< 4.5:1)`
      )
    }
  }
  for (const [fgVar, bgVar] of UI_CONTRAST_PAIRS) {
    const fg = resolveVar(fgVar, themeMap, lightVars)
    const bg = resolveVar(bgVar, themeMap, lightVars)
    if (!fg || !bg) {
      continue
    }
    const fgRgb = parseRgb(fg)
    const bgRgb = parseRgb(bg)
    if (!fgRgb || !bgRgb) {
      fail('D7', `[${themeName}] non-opaque color in pair ${fgVar} (${fg}) / ${bgVar} (${bg})`)
      continue
    }
    const ratio = contrastRatio(fgRgb, bgRgb)
    if (ratio < 3.0) {
      fail(
        'D7',
        `[${themeName}] UI contrast ${fgVar} (${fg}) on ${bgVar} (${bg}) = ${ratio.toFixed(2)}:1 (< 3.0:1)`
      )
    }
  }
}

// Gather CSS and TS/TSX files across consumer tiers
const consumerRoots = ['app', 'slices', 'libs'].map((dir) => path.join(root, dir))
const cssFiles = consumerRoots.flatMap((dir) => listFiles(dir, /\.css$/))
const codeFiles = consumerRoots.flatMap((dir) => listFiles(dir, /\.[cm]?[jt]sx?$/))

const RAW_COLOR_RE =
  /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgba?|hsla?|oklch|oklab)\s*\(/g
const FORBIDDEN_TOKEN_RE = /var\(\s*(--(?:_p|dsw|ds)-[\w-]+)/g
const DARK_MODE_LEAK_RE =
  /\[data-theme\b|data-ds-dark-theme|\bbody\.(?:dark|light)\b|prefers-color-scheme/g
const UI_VAR_REF_RE = /var\(\s*(--ui-[a-z0-9-]+)/g
const Z_INDEX_NUM_RE = /\bz-index\s*:\s*(\d+)\b/g

for (const file of cssFiles) {
  const raw = fs.readFileSync(file, 'utf8')
  const stripped = stripCssComments(raw)

  // D1: Zero raw color literals (exempt highlight.css syntax palette)
  if (file !== highlightPath) {
    for (const match of stripped.matchAll(RAW_COLOR_RE)) {
      fail(
        'D1',
        `${rel(file)}:${lineNumberAt(stripped, match.index)} raw color literal "${match[0]}"`
      )
    }
  }

  // D2: Zero private primitive or legacy tokens
  for (const match of stripped.matchAll(FORBIDDEN_TOKEN_RE)) {
    fail(
      'D2',
      `${rel(file)}:${lineNumberAt(stripped, match.index)} forbidden token reference "${match[1]}"`
    )
  }

  // D3: Single-source dark mode
  for (const match of stripped.matchAll(DARK_MODE_LEAK_RE)) {
    fail(
      'D3',
      `${rel(file)}:${lineNumberAt(stripped, match.index)} dark-mode selector leak "${match[0]}"`
    )
  }

  // D4: Every var(--ui-*) reference exists in tokens.css
  for (const match of stripped.matchAll(UI_VAR_REF_RE)) {
    if (!definedUiTokens.has(match[1])) {
      fail(
        'D4',
        `${rel(file)}:${lineNumberAt(stripped, match.index)} undefined token "${match[1]}"`
      )
    }
  }

  // D5: Zero raw numeric z-index >= 10
  for (const match of stripped.matchAll(Z_INDEX_NUM_RE)) {
    if (Number(match[1]) >= 10) {
      fail(
        'D5',
        `${rel(file)}:${lineNumberAt(stripped, match.index)} raw z-index ${match[1]} (use var(--ui-z-*))`
      )
    }
  }
}

const LIB_UI_SRC_DIR = path.join(root, 'libs/ui/src')
const SPINE_DESIGN_DIR = path.join(root, 'spine/design')

for (const file of codeFiles) {
  if (file === tokensTestPath) {
    continue
  }
  const text = fs.readFileSync(file, 'utf8')

  // D1 (TSX inline colors in libs/ui/src)
  if (file.startsWith(LIB_UI_SRC_DIR + path.sep) && file.endsWith('.tsx')) {
    const withoutSvg = text.replace(/<path\b[^>]*>/g, '')
    for (const match of withoutSvg.matchAll(RAW_COLOR_RE)) {
      fail(
        'D1',
        `${rel(file)}:${lineNumberAt(withoutSvg, match.index)} raw color literal "${match[0]}" in libs/ui component`
      )
    }
  }

  // D2: Zero private/legacy CSS custom properties in TS/TSX
  for (const match of text.matchAll(FORBIDDEN_TOKEN_RE)) {
    fail(
      'D2',
      `${rel(file)}:${lineNumberAt(text, match.index)} forbidden token reference "${match[1]}"`
    )
  }

  // D3: Single-source dark mode in TS/TSX (app/theme.ts owns OS prefers-color-scheme listener)
  if (file !== appThemePath) {
    for (const match of text.matchAll(DARK_MODE_LEAK_RE)) {
      fail('D3', `${rel(file)}:${lineNumberAt(text, match.index)} dark-mode leak "${match[0]}"`)
    }
  }

  // D4: Every var(--ui-*) reference in TS/TSX exists in tokens.css
  for (const match of text.matchAll(UI_VAR_REF_RE)) {
    if (!definedUiTokens.has(match[1])) {
      fail('D4', `${rel(file)}:${lineNumberAt(text, match.index)} undefined token "${match[1]}"`)
    }
  }
}

// D6: Domain-blindness guard in spine/design and libs/ui/src
const DOMAIN_TERM_RE =
  /\b(?:deepseek|firecrawl|pyodide|session|subagent|citation|conversation|BrowserViewport)\b|['"](?:sk-|fc-)/gi
const domainBlindFiles = [
  ...listFiles(SPINE_DESIGN_DIR, /\.(?:[cm]?[jt]sx?|css)$/),
  ...listFiles(LIB_UI_SRC_DIR, /\.(?:[cm]?[jt]sx?|css)$/),
]

for (const file of domainBlindFiles) {
  const raw = fs.readFileSync(file, 'utf8')
  // Ignore workspace scope strings like "@deepseek-chat/spine/..."
  const scrubbed = raw.replace(/@deepseek-chat\//g, '@workspace-pkg/')
  for (const match of scrubbed.matchAll(DOMAIN_TERM_RE)) {
    fail(
      'D6',
      `${rel(file)}:${lineNumberAt(scrubbed, match.index)} domain term "${match[0]}" in domain-blind design layer`
    )
  }
}

if (errors.length > 0) {
  process.stderr.write(
    `SSA design check FAILED (${errors.length} violation(s)):\n${errors
      .map((error) => `  - ${error}`)
      .join('\n')}\n`
  )
  process.exit(1)
}

process.stdout.write(
  `SSA design check passed: ${definedUiTokens.size} semantic tokens, ${TEXT_CONTRAST_PAIRS.length + UI_CONTRAST_PAIRS.length} WCAG 2.2 AA pairs (light & dark), ${cssFiles.length} stylesheets verified.\n`
)
