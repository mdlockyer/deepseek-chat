export type SomBadgeElement = {
  readonly ref: string
  readonly inView: boolean
  readonly rect: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
}

export type SomViewportSize = {
  readonly width: number
  readonly height: number
}

export type SomImageSize = {
  readonly width: number
  readonly height: number
}

export type SomBadgeBox = {
  readonly ref: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly elRect: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
}

export type SomBadgeLayout = {
  readonly fontSize: number
  readonly padX: number
  readonly padY: number
  readonly borderRadius: number
  readonly borderWidth: number
  readonly outlineWidth: number
  readonly badges: readonly SomBadgeBox[]
}

const rectsOverlap = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max))

/**
 * Computes pixel-space `[eN]` badge positions on a captured viewport screenshot from CSS rects.
 * Pure and deterministic so Retina scaling, `maxWidth` downsampling, and `pageZoom` all align.
 */
export const computeSomBadgeBoxes = (
  elements: readonly SomBadgeElement[],
  viewport: SomViewportSize,
  imageSize: SomImageSize,
  measureTextWidth?: (label: string, fontSize: number) => number
): SomBadgeLayout => {
  const fontSize = Math.round(clamp(imageSize.width / 80, 11, 16))
  const padX = Math.max(4, Math.round(fontSize * 0.42))
  const padY = Math.max(2, Math.round(fontSize * 0.2))
  const borderRadius = Math.max(4, Math.round(fontSize * 0.34))
  const borderWidth = Math.max(1, Math.round(fontSize / 10))
  const outlineWidth = Math.max(1, Math.round(imageSize.width / 900))
  const empty: SomBadgeLayout = {
    fontSize,
    padX,
    padY,
    borderRadius,
    borderWidth,
    outlineWidth,
    badges: [],
  }
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    return empty
  }

  const scaleX = imageSize.width / viewport.width
  const scaleY = imageSize.height / viewport.height
  const badgeH = Math.ceil(fontSize * 1.25 + padY * 2)
  const margin = 2
  const placed: SomBadgeBox[] = []

  for (const el of elements) {
    if (!el.inView) {
      continue
    }
    const rawX = el.rect.x * scaleX
    const rawY = el.rect.y * scaleY
    const rawW = Math.max(1, el.rect.w * scaleX)
    const rawH = Math.max(1, el.rect.h * scaleY)
    if (
      rawX + rawW <= 0 ||
      rawY + rawH <= 0 ||
      rawX >= imageSize.width ||
      rawY >= imageSize.height
    ) {
      continue
    }

    const textW = measureTextWidth
      ? measureTextWidth(el.ref, fontSize)
      : el.ref.length * fontSize * 0.62
    const badgeW = Math.ceil(textW + padX * 2)
    const maxX = Math.max(margin, imageSize.width - badgeW - margin)
    const maxY = Math.max(margin, imageSize.height - badgeH - margin)

    let x = Math.round(clamp(rawX, margin, maxX))
    let y = Math.round(clamp(rawY, margin, maxY))

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const blocker = placed.find((other) => rectsOverlap({ x, y, w: badgeW, h: badgeH }, other))
      if (!blocker) {
        break
      }
      const shiftedRight = blocker.x + blocker.w + 2
      if (shiftedRight <= maxX) {
        x = Math.round(shiftedRight)
      } else {
        const shiftedDown = blocker.y + blocker.h + 2
        if (shiftedDown <= maxY) {
          y = Math.round(shiftedDown)
        } else {
          break
        }
      }
    }

    const clampedElX = clamp(rawX, 0, imageSize.width)
    const clampedElY = clamp(rawY, 0, imageSize.height)
    const clampedElRight = clamp(rawX + rawW, 0, imageSize.width)
    const clampedElBottom = clamp(rawY + rawH, 0, imageSize.height)

    placed.push({
      ref: el.ref,
      x,
      y,
      w: badgeW,
      h: badgeH,
      elRect: {
        x: Math.round(clampedElX),
        y: Math.round(clampedElY),
        w: Math.max(1, Math.round(clampedElRight - clampedElX)),
        h: Math.max(1, Math.round(clampedElBottom - clampedElY)),
      },
    })
  }

  return {
    fontSize,
    padX,
    padY,
    borderRadius,
    borderWidth,
    outlineWidth,
    badges: placed,
  }
}

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) => {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode screenshot image'))
    img.src = dataUrl
  })

/**
 * Composites crisp Set-of-Mark `[eN]` badges onto a clean screenshot data URL using Canvas 2D.
 * Never mutates the target page DOM and is immune to WebKit paint/compositor snapshot races.
 */
export const composeSomBadgesOnScreenshot = async (
  cleanDataUrl: string,
  elements: readonly SomBadgeElement[],
  viewport: SomViewportSize
): Promise<string> => {
  if (
    !cleanDataUrl ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !elements.some((el) => el.inView) ||
    typeof document === 'undefined' ||
    typeof Image === 'undefined'
  ) {
    return cleanDataUrl
  }
  try {
    const img = await loadImage(cleanDataUrl)
    const width = img.naturalWidth || img.width
    const height = img.naturalHeight || img.height
    if (width <= 0 || height <= 0) {
      return cleanDataUrl
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return cleanDataUrl
    }
    ctx.drawImage(img, 0, 0, width, height)

    const measure = (label: string, fontSize: number) => {
      ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`
      return ctx.measureText(label).width
    }
    const layout = computeSomBadgeBoxes(elements, viewport, { width, height }, measure)
    if (layout.badges.length === 0) {
      return cleanDataUrl
    }

    // Subtle outlines first so badges always paint cleanly above them.
    ctx.save()
    ctx.strokeStyle = 'rgba(86, 134, 254, 0.5)'
    ctx.lineWidth = layout.outlineWidth
    for (const badge of layout.badges) {
      ctx.strokeRect(
        badge.elRect.x + 0.5,
        badge.elRect.y + 0.5,
        Math.max(1, badge.elRect.w - 1),
        Math.max(1, badge.elRect.h - 1)
      )
    }
    ctx.restore()

    // High-contrast `[eN]` pill badges.
    ctx.save()
    ctx.font = `600 ${layout.fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const badge of layout.badges) {
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.42)'
      ctx.shadowBlur = 3
      ctx.shadowOffsetY = 1
      drawRoundedRect(ctx, badge.x, badge.y, badge.w, badge.h, layout.borderRadius)
      ctx.fillStyle = '#1b1b1c'
      ctx.fill()
      ctx.restore()

      drawRoundedRect(ctx, badge.x, badge.y, badge.w, badge.h, layout.borderRadius)
      ctx.strokeStyle = '#5686fe'
      ctx.lineWidth = layout.borderWidth
      ctx.stroke()

      ctx.fillStyle = '#ffffff'
      ctx.fillText(badge.ref, badge.x + badge.w / 2, badge.y + badge.h / 2 + 0.5)
    }
    ctx.restore()

    return canvas.toDataURL('image/jpeg', 0.84)
  } catch {
    return cleanDataUrl
  }
}
