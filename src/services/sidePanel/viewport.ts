export type BrowserViewportPreset = 'auto' | 'mobile' | 'tablet' | 'desktop' | 'widescreen'

export type BrowserViewportSpec = {
  width: number
  height: number
  preset?: Exclude<BrowserViewportPreset, 'auto'> | null
  aspectRatio?: string | null
}

export type BrowserStageFit = {
  boxWidth: number
  boxHeight: number
  zoom: number
  scale: number
  letterboxed: boolean
  clipped: boolean
}

export const MIN_VIEWPORT_WIDTH = 320
export const MAX_VIEWPORT_WIDTH = 2560
export const MIN_VIEWPORT_HEIGHT = 240
export const MAX_VIEWPORT_HEIGHT = 2560
export const MIN_VIEWPORT_ZOOM = 0.25

export const BROWSER_VIEWPORT_PRESETS: Record<
  Exclude<BrowserViewportPreset, 'auto'>,
  { width: number; height: number }
> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 720 },
  widescreen: { width: 1440, height: 900 },
}

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

export const clampViewportWidth = (value: number) =>
  Math.min(MAX_VIEWPORT_WIDTH, Math.max(MIN_VIEWPORT_WIDTH, Math.round(value)))

export const clampViewportHeight = (value: number) =>
  Math.min(MAX_VIEWPORT_HEIGHT, Math.max(MIN_VIEWPORT_HEIGHT, Math.round(value)))

export const findMatchingViewportPreset = (
  width: number,
  height: number
): Exclude<BrowserViewportPreset, 'auto'> | null => {
  for (const preset of ['mobile', 'tablet', 'desktop', 'widescreen'] as const) {
    const dims = BROWSER_VIEWPORT_PRESETS[preset]
    if (dims.width === width && dims.height === height) {
      return preset
    }
  }
  return null
}

export const isCustomViewport = (viewport: BrowserViewportSpec | null): boolean => {
  if (!viewport) {
    return false
  }
  if (viewport.preset !== undefined) {
    return viewport.preset === null
  }
  return findMatchingViewportPreset(viewport.width, viewport.height) === null
}

export type ViewportDragEdge = 'right' | 'bottom' | 'corner'

export const computeDraggedViewportSize = ({
  startViewport,
  startZoom,
  dx,
  dy,
  edge,
}: {
  startViewport: { width: number; height: number }
  startZoom: number
  dx: number
  dy: number
  edge: ViewportDragEdge
}): { width: number; height: number } => {
  const safeZoom = Math.max(MIN_VIEWPORT_ZOOM, Math.min(1, startZoom || 1))
  const width =
    edge === 'right' || edge === 'corner'
      ? clampViewportWidth(startViewport.width + (2 * dx) / safeZoom)
      : clampViewportWidth(startViewport.width)
  const height =
    edge === 'bottom' || edge === 'corner'
      ? clampViewportHeight(startViewport.height + (2 * dy) / safeZoom)
      : clampViewportHeight(startViewport.height)
  return { width, height }
}

export const getDefaultCustomViewportSize = (
  viewport: BrowserViewportSpec | null,
  stageSize?: { width: number; height: number } | null
): { width: number; height: number } => {
  if (viewport) {
    return {
      width: clampViewportWidth(viewport.width),
      height: clampViewportHeight(viewport.height),
    }
  }
  if (stageSize && stageSize.width > 0 && stageSize.height > 0) {
    return {
      width: clampViewportWidth(stageSize.width),
      height: clampViewportHeight(stageSize.height),
    }
  }
  return { width: 1024, height: 768 }
}

const parseViewportDimension = (raw: string, min: number, max: number): number | null => {
  const normalized = raw.trim().replace(/\s*px$/i, '')
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return null
  }
  const value = Math.round(Number(normalized))
  if (!Number.isFinite(value) || value < min || value > max) {
    return null
  }
  return value
}

export type CustomViewportParseResult =
  | { ok: true; spec: BrowserViewportSpec }
  | { ok: false; widthInvalid: boolean; heightInvalid: boolean }

export const parseCustomViewportInput = (
  rawWidth: string,
  rawHeight: string
): CustomViewportParseResult => {
  const width = parseViewportDimension(rawWidth, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH)
  const height = parseViewportDimension(rawHeight, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT)
  if (width === null || height === null) {
    return {
      ok: false,
      widthInvalid: width === null,
      heightInvalid: height === null,
    }
  }
  return {
    ok: true,
    spec: {
      width,
      height,
      preset: null,
      aspectRatio: null,
    },
  }
}

export const parseAspectRatio = (raw: string): { rw: number; rh: number; label: string } | null => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(raw)
  if (!match) {
    return null
  }
  const rw = Number(match[1])
  const rh = Number(match[2])
  if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) {
    return null
  }
  if (rw / rh > 10 || rh / rw > 10) {
    return null
  }
  return { rw, rh, label: `${match[1]}:${match[2]}` }
}

export const resolveViewportRequest = (
  params: {
    preset?: string
    width?: number
    height?: number
    aspect_ratio?: string
  },
  fallbackSize?: { width: number; height: number } | null
): BrowserViewportSpec | null => {
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
      const dims = BROWSER_VIEWPORT_PRESETS[params.preset]
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

export const fitViewportToStage = (
  viewport: BrowserViewportSpec | null,
  stageWidth: number,
  stageHeight: number
): BrowserStageFit => {
  const availW = Math.max(1, Math.floor(stageWidth))
  const availH = Math.max(1, Math.floor(stageHeight))
  if (!viewport) {
    return {
      boxWidth: availW,
      boxHeight: availH,
      zoom: 1,
      scale: 1,
      letterboxed: false,
      clipped: false,
    }
  }
  const targetW = clampViewportWidth(viewport.width)
  const targetH = clampViewportHeight(viewport.height)
  const widthRatio = availW / targetW
  const heightRatio = availH / targetH
  const idealScale = Math.min(1, widthRatio, heightRatio)
  const clipped = idealScale < MIN_VIEWPORT_ZOOM

  const boxWidth = Math.max(1, Math.min(availW, Math.round(targetW * idealScale)))
  const boxHeight = Math.max(1, Math.min(availH, Math.round(targetH * idealScale)))

  if (clipped) {
    return {
      boxWidth,
      boxHeight,
      zoom: MIN_VIEWPORT_ZOOM,
      scale: idealScale,
      letterboxed: true,
      clipped: true,
    }
  }

  const rawZoom =
    idealScale === 1 ? 1 : widthRatio <= heightRatio ? boxWidth / targetW : boxHeight / targetH
  const zoom = Math.max(MIN_VIEWPORT_ZOOM, Math.min(1, rawZoom))
  return {
    boxWidth,
    boxHeight,
    zoom,
    scale: zoom,
    letterboxed: true,
    clipped: false,
  }
}
