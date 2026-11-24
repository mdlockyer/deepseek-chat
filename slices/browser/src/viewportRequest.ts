import {
  VIEWPORT_PRESETS,
  clampViewportHeight,
  clampViewportWidth,
  parseAspectRatio,
  type ViewportSpec,
} from '@deepseek-chat/lib-stage'

const ASPECT_RATIO_DEFAULTS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '16:10': { width: 1280, height: 800 },
  '21:9': { width: 1440, height: 617 },
  '4:3': { width: 1024, height: 768 },
  '3:2': { width: 1200, height: 800 },
  '1:1': { width: 800, height: 800 },
  '3:4': { width: 768, height: 1024 },
  '2:3': { width: 600, height: 900 },
  '9:16': { width: 390, height: 693 },
}

/** Resolves `browser_set_viewport` tool parameters into a normalized `ViewportSpec` or `null` (auto). */
export const resolveViewportRequest = (
  params: {
    preset?: string
    width?: number
    height?: number
    aspect_ratio?: string
  },
  fallbackSize?: { width: number; height: number } | null
): ViewportSpec | null => {
  if (params.preset !== undefined) {
    if (params.preset === 'auto') {
      return null
    }
    if (
      params.preset === 'mobile' ||
      params.preset === 'tablet' ||
      params.preset === 'desktop' ||
      params.preset === 'widescreen'
    ) {
      const dims = VIEWPORT_PRESETS[params.preset]
      return {
        width: dims.width,
        height: dims.height,
        preset: params.preset,
        aspectRatio: null,
      }
    }
    throw new Error(
      `Invalid viewport preset "${params.preset}". Expected "auto", "mobile", "tablet", "desktop", or "widescreen".`
    )
  }

  const rawW = params.width
  const rawH = params.height
  if (rawW !== undefined && (!Number.isFinite(rawW) || rawW <= 0)) {
    throw new Error('width must be a positive number.')
  }
  if (rawH !== undefined && (!Number.isFinite(rawH) || rawH <= 0)) {
    throw new Error('height must be a positive number.')
  }

  if (params.aspect_ratio !== undefined) {
    const parsed = parseAspectRatio(params.aspect_ratio)
    if (!parsed) {
      throw new Error(
        `Invalid aspect_ratio "${params.aspect_ratio}". Expected e.g. "16:9", "9:16", "4:3", or "1:1".`
      )
    }
    let width: number
    let height: number
    if (rawW !== undefined) {
      width = clampViewportWidth(rawW)
      height = clampViewportHeight((width * parsed.rh) / parsed.rw)
    } else if (rawH !== undefined) {
      height = clampViewportHeight(rawH)
      width = clampViewportWidth((height * parsed.rw) / parsed.rh)
    } else if (Object.hasOwn(ASPECT_RATIO_DEFAULTS, parsed.label)) {
      const preset = ASPECT_RATIO_DEFAULTS[parsed.label]
      width = preset.width
      height = preset.height
    } else if (parsed.rw >= parsed.rh) {
      width = 1280
      height = clampViewportHeight((1280 * parsed.rh) / parsed.rw)
    } else {
      width = 390
      height = clampViewportHeight((390 * parsed.rh) / parsed.rw)
    }
    return {
      width,
      height,
      preset: null,
      aspectRatio: parsed.label,
    }
  }

  if (rawW !== undefined || rawH !== undefined) {
    return {
      width: clampViewportWidth(rawW ?? fallbackSize?.width ?? 540),
      height: clampViewportHeight(rawH ?? fallbackSize?.height ?? 720),
      preset: null,
      aspectRatio: null,
    }
  }

  throw new Error(
    'Provide preset ("auto" | "mobile" | "tablet" | "desktop" | "widescreen"), width/height, or aspect_ratio.'
  )
}
