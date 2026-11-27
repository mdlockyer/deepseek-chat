import type { BrowserBounds } from './host.js'

export const boundsEqual = (a: BrowserBounds | null, b: BrowserBounds | null): boolean =>
  a !== null &&
  b !== null &&
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5

export const isHttpUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Normalizes user omnibox input into a safe URL:
 * - explicit http(s):// -> preserved
 * - localhost / 127.0.0.1 / host:port / domain.tld -> http(s)://
 * - free text query -> Google search
 */
export const normalizeOmniboxInput = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) {
    return 'about:blank'
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }
  if (
    !/\s/.test(trimmed) &&
    (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/.*)?$/i.test(trimmed) ||
      /^[^\s.]+\.[^\s]{2,}(\/.*)?$/i.test(trimmed))
  ) {
    const scheme = /^(localhost|127\.0\.0\.1|\[::1\])/i.test(trimmed) ? 'http' : 'https'
    return `${scheme}://${trimmed}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}
