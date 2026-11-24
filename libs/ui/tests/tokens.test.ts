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

const resolveVar = (
  name: string,
  themeVars: Map<string, string>,
  baseVars: Map<string, string>,
  depth = 0
): string => {
  assert.ok(depth < 8, `Circular CSS variable reference at ${name}`)
  const raw = themeVars.get(name) ?? baseVars.get(name)
  assert.ok(raw !== undefined, `Undefined CSS variable ${name}`)
  const ref = /^var\((--[\w-]+)\)$/.exec(raw)
  return ref ? resolveVar(ref[1], themeVars, baseVars, depth + 1) : raw
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
  throw new Error(`Expected opaque hex/rgb color for WCAG check, got "${color}"`)
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

  it('defines every dark-theme override against an existing light-theme semantic token', () => {
    for (const key of darkVars.keys()) {
      assert.ok(key.startsWith('--ui-'), `Dark theme must not redefine private token ${key}`)
      assert.ok(lightVars.has(key), `Dark theme token ${key} has no light-theme counterpart`)
    }
  })

  it('satisfies WCAG 2.2 AA contrast (>= 4.5:1 text, >= 3:1 UI/focus) in both light and dark themes', () => {
    const textPairs: ReadonlyArray<[string, string]> = [
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

    const uiPairs: ReadonlyArray<[string, string]> = [
      ['--ui-focus-ring', '--ui-surface-canvas'],
      ['--ui-focus-ring', '--ui-surface-popover'],
      ['--ui-border-focus-neutral', '--ui-surface-input'],
      ['--ui-handle-fill', '--ui-surface-code'],
    ]

    for (const [themeName, themeMap] of [
      ['light', lightVars],
      ['dark', darkVars],
    ] as const) {
      for (const [fgVar, bgVar] of textPairs) {
        const fg = resolveVar(fgVar, themeMap, lightVars)
        const bg = resolveVar(bgVar, themeMap, lightVars)
        const ratio = contrastRatio(fg, bg)
        assert.ok(
          ratio >= 4.5,
          `[${themeName}] text contrast ${fgVar} (${fg}) on ${bgVar} (${bg}) = ${ratio.toFixed(2)}:1 (< 4.5:1)`
        )
      }
      for (const [fgVar, bgVar] of uiPairs) {
        const fg = resolveVar(fgVar, themeMap, lightVars)
        const bg = resolveVar(bgVar, themeMap, lightVars)
        const ratio = contrastRatio(fg, bg)
        assert.ok(
          ratio >= 3.0,
          `[${themeName}] UI contrast ${fgVar} (${fg}) on ${bgVar} (${bg}) = ${ratio.toFixed(2)}:1 (< 3.0:1)`
        )
      }
    }
  })
})
