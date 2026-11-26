import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const tokensCss = fs.readFileSync(path.join(root, 'spine/design/tokens.css'), 'utf8')

/** Extracts `--name: value;` declarations inside a CSS block selector. */
const extractBlockVars = (css: string, selector: string): Map<string, string> => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm').exec(css)
  assert.ok(match, `Expected CSS block for selector "${selector}"`)
  const vars = new Map<string, string>()
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '')
  for (const decl of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(decl[1], decl[2].trim())
  }
  return vars
}

type ThemeName = 'light' | 'dark'

/** Splits `a, b` at the top-level comma, ignoring commas nested inside parentheses. */
const splitTopLevelComma = (text: string): [string, string] => {
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') {
      depth += 1
    } else if (text[i] === ')') {
      depth -= 1
    } else if (text[i] === ',' && depth === 0) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()]
    }
  }
  throw new Error(`Expected two comma-separated values in "${text}"`)
}

/** Resolves a token for one theme, following var() references and light-dark() branches. */
const resolveVar = (
  name: string,
  themeVars: Map<string, string>,
  baseVars: Map<string, string>,
  theme: ThemeName,
  depth = 0
): string => {
  assert.ok(depth < 8, `Circular CSS variable reference at ${name}`)
  const raw = themeVars.get(name) ?? baseVars.get(name)
  assert.ok(raw !== undefined, `Undefined CSS variable ${name}`)
  return resolveValue(raw, themeVars, baseVars, theme, depth)
}

const resolveValue = (
  raw: string,
  themeVars: Map<string, string>,
  baseVars: Map<string, string>,
  theme: ThemeName,
  depth: number
): string => {
  const lightDark = /^light-dark\(([\s\S]*)\)$/.exec(raw)
  if (lightDark) {
    const [light, dark] = splitTopLevelComma(lightDark[1])
    return resolveValue(theme === 'dark' ? dark : light, themeVars, baseVars, theme, depth + 1)
  }
  const ref = /^var\((--[\w-]+)\)$/.exec(raw)
  return ref ? resolveVar(ref[1], themeVars, baseVars, theme, depth + 1) : raw
}

/** OKLCH to gamma-encoded sRGB (CSS Color 4 matrices), clamped to the sRGB gamut. */
const oklchToRgb = (l: number, c: number, h: number): [number, number, number] => {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const encode = (x: number) => {
    const v = Math.min(1, Math.max(0, x))
    return Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255)
  }
  return [
    encode(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    encode(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    encode(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ]
}

const parseRgb = (color: string): [number, number, number] => {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(color)
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }
  const oklch = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(color)
  if (oklch) {
    const l = Number(oklch[1]) / (oklch[2] === '%' ? 100 : 1)
    return oklchToRgb(l, Number(oklch[3]), Number(oklch[4]))
  }
  throw new Error(
    `Expected an opaque hex, rgb() or oklch() color for the WCAG check, got "${color}"`
  )
}

const luminance = ([r, g, b]: [number, number, number]) => {
  const linear = (channel: number) => {
    const s = channel / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

const contrastRatio = (fg: string, bg: string) => {
  const l1 = luminance(parseRgb(fg))
  const l2 = luminance(parseRgb(bg))
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

describe('spine/design tokens.css contract', () => {
  const lightVars = extractBlockVars(tokensCss, ':root')
  const darkVars = extractBlockVars(tokensCss, ":root[data-theme='dark']")

  it('declares explicit cascade layers upfront', () => {
    assert.match(tokensCss, /^@layer reset, tokens, base, components, slice;/m)
  })

  it('switches color-scheme in the dark block, which light-dark() tokens resolve against', () => {
    assert.match(tokensCss, /:root\[data-theme='dark'\]\s*\{[^}]*color-scheme:\s*dark;/)
    assert.match(tokensCss, /:root\s*\{[^}]*color-scheme:\s*light;/)
  })

  it('defines every dark-theme override against an existing light-theme semantic token', () => {
    for (const key of darkVars.keys()) {
      assert.ok(key.startsWith('--ui-'), `Dark theme must not redefine private token ${key}`)
      assert.ok(lightVars.has(key), `Dark theme token ${key} has no light-theme counterpart`)
    }
  })

  it('satisfies WCAG 2.2 AA contrast (>= 4.5:1 text, >= 3:1 UI/focus) in both light and dark themes', () => {
    const textPairs: ReadonlyArray<[string, string]> = [
      ['--ui-text-primary', '--ui-surface-canvas'],
      ['--ui-text-primary', '--ui-surface-overlay'],
      ['--ui-text-primary', '--ui-surface-sunken'],
      ['--ui-text-primary', '--ui-surface-raised-2'],
      ['--ui-text-secondary', '--ui-surface-canvas'],
      ['--ui-text-secondary', '--ui-surface-overlay'],
      ['--ui-text-secondary', '--ui-surface-sunken'],
      ['--ui-text-secondary', '--ui-surface-raised-1'],
      ['--ui-text-secondary', '--ui-surface-raised-2'],
      ['--ui-text-muted', '--ui-surface-canvas'],
      ['--ui-text-muted', '--ui-surface-sunken'],
      ['--ui-text-muted', '--ui-surface-raised-1'],
      ['--ui-text-muted', '--ui-surface-input'],
      ['--ui-text-muted', '--ui-surface-overlay'],
      ['--ui-accent-text', '--ui-surface-canvas'],
      ['--ui-accent-text', '--ui-surface-sunken'],
      ['--ui-accent-text', '--ui-surface-raised-1'],
      ['--ui-accent-text', '--ui-surface-raised-2'],
      ['--ui-accent-text', '--ui-accent-subtle'],
      ['--ui-accent-text', '--ui-accent-subtle-hover'],
      ['--ui-danger-text', '--ui-surface-canvas'],
      ['--ui-danger-text', '--ui-surface-overlay'],
      ['--ui-danger-text', '--ui-danger-subtle'],
      ['--ui-accent-on-solid', '--ui-accent-solid'],
      ['--ui-accent-on-solid', '--ui-accent-solid-hover'],
      ['--ui-danger-on-solid', '--ui-danger-solid'],
      ['--ui-danger-on-solid', '--ui-danger-solid-hover'],
      ['--ui-success-text', '--ui-success-subtle'],
      ['--ui-warning-text', '--ui-warning-subtle'],
      ['--ui-text-on-inverse', '--ui-surface-inverse'],
      ['--ui-text-on-inverse-link', '--ui-surface-inverse'],
    ]

    const uiPairs: ReadonlyArray<[string, string]> = [
      ['--ui-focus-ring', '--ui-surface-canvas'],
      ['--ui-focus-ring', '--ui-surface-overlay'],
      ['--ui-focus-ring', '--ui-surface-sunken'],
      ['--ui-accent-border', '--ui-surface-canvas'],
      ['--ui-danger-border', '--ui-surface-canvas'],
      ['--ui-handle-fill', '--ui-surface-sunken'],
      ['--ui-surface-switch-off', '--ui-surface-canvas'],
    ]

    for (const [themeName, themeMap] of [
      ['light', lightVars],
      ['dark', darkVars],
    ] as const) {
      for (const [fgVar, bgVar] of textPairs) {
        const fg = resolveVar(fgVar, themeMap, lightVars, themeName)
        const bg = resolveVar(bgVar, themeMap, lightVars, themeName)
        const ratio = contrastRatio(fg, bg)
        assert.ok(
          ratio >= 4.5,
          `[${themeName}] text contrast ${fgVar} (${fg}) on ${bgVar} (${bg}) = ${ratio.toFixed(2)}:1 (< 4.5:1)`
        )
      }
      for (const [fgVar, bgVar] of uiPairs) {
        const fg = resolveVar(fgVar, themeMap, lightVars, themeName)
        const bg = resolveVar(bgVar, themeMap, lightVars, themeName)
        const ratio = contrastRatio(fg, bg)
        assert.ok(
          ratio >= 3.0,
          `[${themeName}] UI contrast ${fgVar} (${fg}) on ${bgVar} (${bg}) = ${ratio.toFixed(2)}:1 (< 3.0:1)`
        )
      }
    }
  })

  it('maintains a perceptible three-tier text hierarchy (primary > secondary > muted) in light and dark themes', () => {
    for (const [themeName, themeMap] of [
      ['light', lightVars],
      ['dark', darkVars],
    ] as const) {
      const primary = resolveVar('--ui-text-primary', themeMap, lightVars, themeName)
      const secondary = resolveVar('--ui-text-secondary', themeMap, lightVars, themeName)
      const muted = resolveVar('--ui-text-muted', themeMap, lightVars, themeName)
      const canvas = resolveVar('--ui-surface-canvas', themeMap, lightVars, themeName)
      const primaryVsCanvas = contrastRatio(primary, canvas)
      const secondaryVsCanvas = contrastRatio(secondary, canvas)
      const mutedVsCanvas = contrastRatio(muted, canvas)
      assert.ok(
        primaryVsCanvas > secondaryVsCanvas && secondaryVsCanvas > mutedVsCanvas,
        `[${themeName}] text tiers must step down monotonically (${primaryVsCanvas.toFixed(2)} > ${secondaryVsCanvas.toFixed(2)} > ${mutedVsCanvas.toFixed(2)})`
      )
      const secondaryVsMuted = contrastRatio(secondary, muted)
      assert.ok(
        secondaryVsMuted >= 1.4,
        `[${themeName}] secondary (${secondary}) vs muted (${muted}) separation = ${secondaryVsMuted.toFixed(2)}:1 (< 1.4:1)`
      )
    }
  })
})
