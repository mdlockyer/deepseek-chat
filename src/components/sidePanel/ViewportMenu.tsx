import clsx from 'clsx'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { acquireBrowserOverlayLock } from '../../services/browser/state.js'
import { useSidePanelStore } from '../../services/sidePanel/state.js'
import {
  BROWSER_VIEWPORT_PRESETS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  MIN_VIEWPORT_HEIGHT,
  MIN_VIEWPORT_WIDTH,
  getDefaultCustomViewportSize,
  parseCustomViewportInput,
  type BrowserViewportPreset,
  type BrowserViewportSpec,
} from '../../services/sidePanel/viewport.js'
import { usePresence } from '../../utils/usePresence.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckedOutline14,
  IconSwapOutline14,
  IconToastError16,
  IconViewportOutline14,
} from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './SidePanel.module.css'

const PRESET_ORDER: Exclude<BrowserViewportPreset, 'auto'>[] = [
  'desktop',
  'widescreen',
  'tablet',
  'mobile',
]

const PRESET_LABEL_KEYS: Record<
  Exclude<BrowserViewportPreset, 'auto'>,
  | 'browserViewportDesktop'
  | 'browserViewportWidescreen'
  | 'browserViewportTablet'
  | 'browserViewportMobile'
> = {
  desktop: 'browserViewportDesktop',
  widescreen: 'browserViewportWidescreen',
  tablet: 'browserViewportTablet',
  mobile: 'browserViewportMobile',
}

const matchesPreset = (
  viewport: BrowserViewportSpec | null,
  preset: Exclude<BrowserViewportPreset, 'auto'>
) => {
  if (!viewport) {
    return false
  }
  if (viewport.preset !== undefined) {
    return viewport.preset === preset
  }
  const dims = BROWSER_VIEWPORT_PRESETS[preset]
  return viewport.width === dims.width && viewport.height === dims.height
}

/** 共享工具栏视口尺寸/比例选择器：用于内置浏览器和 HTML 文件预览 */
export const ViewportMenu = ({
  viewport,
  zoom,
  disabled = false,
  onSelect,
}: {
  viewport: BrowserViewportSpec | null
  zoom: number
  disabled?: boolean
  onSelect: (next: BrowserViewportSpec | null) => void
}) => {
  const t = useTranslate()
  const stageSize = useSidePanelStore((state) => state.stageSize)
  const [open, setOpen] = useState(false)
  const { mounted, exiting } = usePresence(open, 140)

  const [widthDraft, setWidthDraft] = useState('')
  const [heightDraft, setHeightDraft] = useState('')
  const [widthError, setWidthError] = useState(false)
  const [heightError, setHeightError] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const widthInputRef = useRef<HTMLInputElement>(null)
  const heightInputRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(false)
  const widthId = useId()
  const heightId = useId()
  const errorId = useId()

  const measureKey = `${viewport ? `${viewport.width}x${viewport.height}` : 'auto'}:${errorMsg ? 'err' : 'ok'}`
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(mounted, { side: 'bottom', align: 'end', offset: 6, measureKey })

  const close = useCallback(
    (restoreFocus = false) => {
      setOpen(false)
      if (restoreFocus) {
        requestAnimationFrame(() => anchorRef.current?.focus({ preventScroll: true }))
      }
    },
    [anchorRef]
  )

  useDismiss(open, [anchorRef, floatingRef], () => close(false))
  useEffect(() => (mounted ? acquireBrowserOverlayLock() : undefined), [mounted])

  const seedCustomDraft = useCallback(() => {
    const defaults = getDefaultCustomViewportSize(viewport, stageSize)
    setWidthDraft(String(defaults.width))
    setHeightDraft(String(defaults.height))
    setWidthError(false)
    setHeightError(false)
    setErrorMsg(null)
  }, [viewport, stageSize])

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current
    wasOpenRef.current = open
    if (!justOpened) {
      return
    }
    seedCustomDraft()
    floatingRef.current?.focus({ preventScroll: true })
  }, [open, seedCustomDraft, floatingRef])

  const pct = Math.round(zoom * 100)
  const sizeSummary = viewport
    ? `${viewport.width}×${viewport.height}${pct < 100 ? ` · ${pct}%` : ''}`
    : t('browserViewportAuto')
  const tooltipText = t('browserViewportTooltip', { size: sizeSummary })

  const submitCustom = (restoreFocus: boolean) => {
    const parsed = parseCustomViewportInput(widthDraft, heightDraft)
    if (!parsed.ok) {
      setWidthError(parsed.widthInvalid)
      setHeightError(parsed.heightInvalid)
      if (parsed.widthInvalid && parsed.heightInvalid) {
        setErrorMsg(
          t('browserViewportInvalidBoth', {
            minW: MIN_VIEWPORT_WIDTH,
            maxW: MAX_VIEWPORT_WIDTH,
            minH: MIN_VIEWPORT_HEIGHT,
            maxH: MAX_VIEWPORT_HEIGHT,
          })
        )
      } else if (parsed.widthInvalid) {
        setErrorMsg(
          t('browserViewportInvalidWidth', {
            min: MIN_VIEWPORT_WIDTH,
            max: MAX_VIEWPORT_WIDTH,
          })
        )
      } else {
        setErrorMsg(
          t('browserViewportInvalidHeight', {
            min: MIN_VIEWPORT_HEIGHT,
            max: MAX_VIEWPORT_HEIGHT,
          })
        )
      }
      requestAnimationFrame(() => {
        const target = parsed.widthInvalid ? widthInputRef.current : heightInputRef.current
        target?.focus({ preventScroll: true })
        target?.select()
      })
      return
    }
    close(restoreFocus)
    onSelect(parsed.spec)
  }

  const handleSwap = () => {
    setWidthDraft(heightDraft)
    setHeightDraft(widthDraft)
    setWidthError(false)
    setHeightError(false)
    setErrorMsg(null)
  }

  const focusOption = (direction: 1 | -1 | 'first' | 'last') => {
    const container = floatingRef.current
    if (!container) {
      return
    }
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[data-viewport-option]:not(:disabled)')
    )
    if (items.length === 0) {
      return
    }
    if (direction === 'first') {
      items[0]?.focus({ preventScroll: true })
      return
    }
    if (direction === 'last') {
      items.at(-1)?.focus({ preventScroll: true })
      return
    }
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex =
      activeIndex === -1
        ? direction === 1
          ? 0
          : items.length - 1
        : (activeIndex + direction + items.length) % items.length
    items[nextIndex]?.focus({ preventScroll: true })
  }

  return (
    <>
      <Tooltip content={tooltipText} disabled={open}>
        <button
          ref={anchorRef}
          type="button"
          className={clsx(
            viewport ? styles.viewportChip : styles.viewportIconBtn,
            open && styles.viewportTriggerOpen
          )}
          aria-label={tooltipText}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
              event.preventDefault()
              event.stopPropagation()
              close(true)
              return
            }
            if (event.key === 'ArrowDown' && !open) {
              event.preventDefault()
              setOpen(true)
              requestAnimationFrame(() => focusOption('first'))
            }
          }}
        >
          <span className={styles.viewportChipIcon}>
            <IconViewportOutline14 />
          </span>
          {viewport ? (
            <>
              <span className={styles.viewportChipText}>
                {viewport.width}×{viewport.height}
              </span>
              {pct < 100 ? <span className={styles.viewportChipScale}>{pct}%</span> : null}
            </>
          ) : null}
        </button>
      </Tooltip>
      {mounted
        ? createPortal(
            <div
              ref={floatingRef}
              tabIndex={-1}
              role="dialog"
              aria-label={tooltipText}
              className={clsx(styles.viewportMenu, exiting && styles.viewportMenuExiting)}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  close(true)
                  return
                }
                if (event.target instanceof HTMLInputElement) {
                  return
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  focusOption(1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  focusOption(-1)
                } else if (event.key === 'Home') {
                  event.preventDefault()
                  focusOption('first')
                } else if (event.key === 'End') {
                  event.preventDefault()
                  focusOption('last')
                }
              }}
            >
              <div role="radiogroup" aria-label={tooltipText}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={viewport === null}
                  data-viewport-option=""
                  className={clsx(
                    styles.viewportOption,
                    viewport === null && styles.viewportOptionSelected
                  )}
                  onClick={() => {
                    close(false)
                    onSelect(null)
                  }}
                >
                  <span className={styles.viewportOptionCheck} aria-hidden>
                    {viewport === null ? <IconCheckedOutline14 /> : null}
                  </span>
                  <span className={styles.viewportOptionLabel}>{t('browserViewportAuto')}</span>
                  <span className={styles.viewportOptionMeta}>{t('browserViewportAutoShort')}</span>
                </button>
                <div className={styles.viewportDivider} role="separator" />
                {PRESET_ORDER.map((preset) => {
                  const dims = BROWSER_VIEWPORT_PRESETS[preset]
                  const selected = matchesPreset(viewport, preset)
                  return (
                    <button
                      key={preset}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-viewport-option=""
                      className={clsx(
                        styles.viewportOption,
                        selected && styles.viewportOptionSelected
                      )}
                      onClick={() => {
                        close(false)
                        onSelect({
                          width: dims.width,
                          height: dims.height,
                          preset,
                          aspectRatio: null,
                        })
                      }}
                    >
                      <span className={styles.viewportOptionCheck} aria-hidden>
                        {selected ? <IconCheckedOutline14 /> : null}
                      </span>
                      <span className={styles.viewportOptionLabel}>
                        {t(PRESET_LABEL_KEYS[preset])}
                      </span>
                      <span className={styles.viewportOptionMeta}>
                        {dims.width}×{dims.height}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className={styles.viewportDivider} role="separator" />
              <form
                className={styles.viewportCustomForm}
                noValidate
                onSubmit={(event) => {
                  event.preventDefault()
                  submitCustom(false)
                }}
              >
                <div className={styles.viewportCustomFields}>
                  <div className={styles.viewportField}>
                    <label className={styles.viewportFieldLabel} htmlFor={widthId}>
                      {t('browserViewportWidth')}
                    </label>
                    <div
                      className={clsx(
                        styles.viewportInputBox,
                        widthError && styles.viewportInputBoxError
                      )}
                    >
                      <input
                        ref={widthInputRef}
                        id={widthId}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        className={styles.viewportInput}
                        value={widthDraft}
                        aria-invalid={widthError || undefined}
                        aria-describedby={errorMsg ? errorId : undefined}
                        onChange={(event) => {
                          setWidthDraft(event.target.value)
                          if (widthError || errorMsg) {
                            setWidthError(false)
                            setErrorMsg(null)
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            submitCustom(true)
                          }
                        }}
                      />
                      <span className={styles.viewportInputUnit} aria-hidden>
                        px
                      </span>
                    </div>
                  </div>
                  <Tooltip content={t('browserViewportSwap')} disabled={!open}>
                    <button
                      type="button"
                      className={styles.viewportSwapBtn}
                      aria-label={t('browserViewportSwap')}
                      onClick={handleSwap}
                    >
                      <IconSwapOutline14 />
                    </button>
                  </Tooltip>
                  <div className={styles.viewportField}>
                    <label className={styles.viewportFieldLabel} htmlFor={heightId}>
                      {t('browserViewportHeight')}
                    </label>
                    <div
                      className={clsx(
                        styles.viewportInputBox,
                        heightError && styles.viewportInputBoxError
                      )}
                    >
                      <input
                        ref={heightInputRef}
                        id={heightId}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        className={styles.viewportInput}
                        value={heightDraft}
                        aria-invalid={heightError || undefined}
                        aria-describedby={errorMsg ? errorId : undefined}
                        onChange={(event) => {
                          setHeightDraft(event.target.value)
                          if (heightError || errorMsg) {
                            setHeightError(false)
                            setErrorMsg(null)
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            submitCustom(true)
                          }
                        }}
                      />
                      <span className={styles.viewportInputUnit} aria-hidden>
                        px
                      </span>
                    </div>
                  </div>
                </div>
                {errorMsg ? (
                  <div id={errorId} className={styles.viewportCustomError} role="alert">
                    <IconToastError16 />
                    <span>{errorMsg}</span>
                  </div>
                ) : (
                  <div className={styles.viewportCustomHint}>{t('browserViewportCustomHint')}</div>
                )}
                <button type="submit" className={styles.viewportApplyBtn}>
                  {t('browserViewportApply')}
                </button>
              </form>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
