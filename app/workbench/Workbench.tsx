import {
  Badge,
  Banner,
  Button,
  Chip,
  Dialog,
  EmptyState,
  FileGlyph,
  HoverCard,
  HoverGlide,
  IconBrowseOutline16,
  IconCheckOutline16,
  IconCodeOutline14,
  IconCopyOutline16,
  IconDarkOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconGlobeLanguageOutline16,
  IconLightOutline16,
  IconPanelLeftOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
  IconTrashOutline16,
  IconButton,
  LinkButton,
  Menu,
  PanelHeader,
  PasswordField,
  Popover,
  RadioCardGroup,
  PanelTitleMenu,
  SegmentedControl,
  Select,
  SettingGroup,
  SettingInlineConfirm,
  SettingRow,
  Spinner,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
  ToastViewport,
  Tooltip,
  UiProvider,
  createNoticeBus,
  createOverlayCoordinator,
  hoverGlideItem,
  type FileGlyphKind,
} from '@deepseek-chat/lib-ui'
import { applyDocumentTheme, type ThemeMode } from '@deepseek-chat/spine/design'
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SsaDemo } from './SsaDemo.js'
import styles from './Workbench.module.css'

type WorkbenchTab = 'ssa' | 'kit'
type BrandPreset = 'default' | 'emerald' | 'terracotta'

/** Presets override only the accent slots; surfaces and text stay neutral under every preset. */
const OVERRIDE_KEYS = [
  '--ui-accent-solid',
  '--ui-accent-solid-hover',
  '--ui-accent-subtle',
  '--ui-accent-subtle-hover',
  '--ui-accent-text',
  '--ui-accent-border',
  '--ui-focus-ring',
] as const

const BRAND_OVERRIDES: Record<
  Exclude<BrandPreset, 'default'>,
  Record<ThemeMode, Record<(typeof OVERRIDE_KEYS)[number], string>>
> = {
  /** The emerald accent the blue replaced, kept for side-by-side comparison. */
  emerald: {
    light: {
      '--ui-accent-solid': 'oklch(0.5 0.108 163)',
      '--ui-accent-solid-hover': 'oklch(0.44 0.095 163)',
      '--ui-accent-subtle': 'oklch(0.975 0.025 163)',
      '--ui-accent-subtle-hover': 'oklch(0.95 0.045 163)',
      '--ui-accent-text': 'oklch(0.5 0.108 163)',
      '--ui-accent-border': 'oklch(0.6 0.129 163)',
      '--ui-focus-ring': 'oklch(0.5 0.108 163)',
    },
    dark: {
      '--ui-accent-solid': 'oklch(0.5 0.108 163)',
      '--ui-accent-solid-hover': 'oklch(0.44 0.095 163)',
      '--ui-accent-subtle': 'oklch(0.25 0.045 163)',
      '--ui-accent-subtle-hover': 'oklch(0.3 0.06 163)',
      '--ui-accent-text': 'oklch(0.78 0.13 163)',
      '--ui-accent-border': 'oklch(0.6 0.129 163)',
      '--ui-focus-ring': 'oklch(0.78 0.13 163)',
    },
  },
  terracotta: {
    light: {
      '--ui-accent-solid': '#b45309',
      '--ui-accent-solid-hover': '#92400e',
      '--ui-accent-subtle': '#fff7ed',
      '--ui-accent-subtle-hover': '#ffedd5',
      '--ui-accent-text': '#9a3412',
      '--ui-accent-border': '#c2410c',
      '--ui-focus-ring': '#b45309',
    },
    dark: {
      '--ui-accent-solid': '#b45309',
      '--ui-accent-solid-hover': '#92400e',
      '--ui-accent-subtle': '#311f14',
      '--ui-accent-subtle-hover': '#42291b',
      '--ui-accent-text': '#fdba74',
      '--ui-accent-border': '#f97316',
      '--ui-focus-ring': '#fb923c',
    },
  },
}

const INSPECTED_PAIRS: ReadonlyArray<{
  readonly label: string
  readonly fg: string
  readonly bg: string
  readonly minRatio: number
}> = [
  {
    label: 'Primary text on canvas',
    fg: '--ui-text-primary',
    bg: '--ui-surface-canvas',
    minRatio: 4.5,
  },
  {
    label: 'Secondary text on canvas',
    fg: '--ui-text-secondary',
    bg: '--ui-surface-canvas',
    minRatio: 4.5,
  },
  {
    label: 'Muted text on sunken',
    fg: '--ui-text-muted',
    bg: '--ui-surface-sunken',
    minRatio: 4.5,
  },
  {
    label: 'Accent text on canvas',
    fg: '--ui-accent-text',
    bg: '--ui-surface-canvas',
    minRatio: 4.5,
  },
  {
    label: 'Accent text on subtle',
    fg: '--ui-accent-text',
    bg: '--ui-accent-subtle',
    minRatio: 4.5,
  },
  {
    label: 'Label on accent solid',
    fg: '--ui-accent-on-solid',
    bg: '--ui-accent-solid',
    minRatio: 4.5,
  },
  {
    label: 'Danger text on overlay',
    fg: '--ui-danger-text',
    bg: '--ui-surface-overlay',
    minRatio: 4.5,
  },
  {
    label: 'Label on danger solid',
    fg: '--ui-danger-on-solid',
    bg: '--ui-danger-solid',
    minRatio: 4.5,
  },
  {
    label: 'Success text on subtle',
    fg: '--ui-success-text',
    bg: '--ui-success-subtle',
    minRatio: 4.5,
  },
  {
    label: 'Warning text on subtle',
    fg: '--ui-warning-text',
    bg: '--ui-warning-subtle',
    minRatio: 4.5,
  },
  {
    label: 'Text on inverse surface',
    fg: '--ui-text-on-inverse',
    bg: '--ui-surface-inverse',
    minRatio: 4.5,
  },
  {
    label: 'Focus ring on canvas',
    fg: '--ui-focus-ring',
    bg: '--ui-surface-canvas',
    minRatio: 3.0,
  },
]

const parseCssColor = (raw: string): [number, number, number] | null => {
  const trimmed = raw.trim()
  const hex = /^#([0-9a-f]{6})$/i.exec(trimmed)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(trimmed)
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }
  return null
}

const resolveRenderedRgb = (tokenName: string): string => {
  const probe = document.createElement('span')
  probe.style.color = `var(${tokenName})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  // Engines serialise OKLCH tokens as lab()/oklch(); painting one pixel converts any of them to sRGB.
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!context) {
    return resolved
  }
  context.fillStyle = resolved
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}

const luminance = ([r, g, b]: [number, number, number]) => {
  const linear = (channel: number) => {
    const s = channel / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

const computeContrast = (fgCss: string, bgCss: string): number | null => {
  const fg = parseCssColor(fgCss)
  const bg = parseCssColor(bgCss)
  if (!fg || !bg) {
    return null
  }
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

type ContrastRow = {
  readonly label: string
  readonly fg: string
  readonly bg: string
  readonly fgValue: string
  readonly bgValue: string
  readonly ratio: number | null
  readonly minRatio: number
}

const FILE_GLYPHS: ReadonlyArray<{ readonly kind: FileGlyphKind; readonly label: string }> = [
  { kind: 'document', label: 'document' },
  { kind: 'pdf', label: 'pdf' },
  { kind: 'spreadsheet', label: 'spreadsheet' },
  { kind: 'presentation', label: 'presentation' },
  { kind: 'image', label: 'image' },
]

const SPACING_TOKENS = [
  ['--ui-space-1', '4px'],
  ['--ui-space-2', '8px'],
  ['--ui-space-3', '12px'],
  ['--ui-space-4', '16px'],
  ['--ui-space-6', '24px'],
  ['--ui-space-8', '32px'],
] as const

const RADIUS_TOKENS = [
  ['--ui-radius-xs', '4px'],
  ['--ui-radius-sm', '8px'],
  ['--ui-radius-md', '12px'],
  ['--ui-radius-lg', '16px'],
  ['--ui-radius-xl', '24px'],
  ['--ui-radius-pill', 'pill'],
] as const

/**
 * Dev-only interactive Component Workbench & Token Inspector (`/?workbench=1`).
 * Eliminated from production builds via `__DEV__`.
 */
export const Workbench = () => {
  const notices = useMemo(() => createNoticeBus(), [])
  const overlays = useMemo(() => createOverlayCoordinator(), [])
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'ssa' ? 'ssa' : 'kit'
  )
  const [theme, setTheme] = useState<ThemeMode>('light')
  const [brand, setBrand] = useState<BrandPreset>('default')
  const [reflow320, setReflow320] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)

  // Interactive primitive states
  const [textValue, setTextValue] = useState('Sealed Slice Architecture')
  const [secretValue, setSecretValue] = useState('example-token-value-12345')
  const [selectValue, setSelectValue] = useState('en')
  const [switchOne, setSwitchOne] = useState(true)
  const [switchTwo, setSwitchTwo] = useState(false)
  const [segmentValue, setSegmentValue] = useState<'preview' | 'source' | 'diff'>('preview')
  const [radioValue, setRadioValue] = useState<'light' | 'dark' | 'system'>('light')
  const [activeTab, setActiveTab] = useState<'tokens' | 'primitives' | 'contracts'>('tokens')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [dialogSelect, setDialogSelect] = useState('opt-a')
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [menuRadio, setMenuRadio] = useState<'fit' | 'actual'>('fit')
  const [panelView, setPanelView] = useState<'activity' | 'sources'>('activity')
  const [menuChecked, setMenuChecked] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [activeGlide, setActiveGlide] = useState('item-1')
  const [contrastRows, setContrastRows] = useState<ContrastRow[]>([])

  const popoverAnchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => overlays.subscribe(setOverlayOpen), [overlays])

  useEffect(() => {
    document.title = 'SSA Component Workbench'
    applyDocumentTheme(document.documentElement, theme)
    const rootStyle = document.documentElement.style
    if (brand === 'default') {
      for (const key of OVERRIDE_KEYS) {
        rootStyle.removeProperty(key)
      }
    } else {
      const overrides = BRAND_OVERRIDES[brand][theme]
      for (const key of OVERRIDE_KEYS) {
        rootStyle.setProperty(key, overrides[key])
      }
    }
    const nextRows = INSPECTED_PAIRS.map((pair) => {
      const fgValue = resolveRenderedRgb(pair.fg)
      const bgValue = resolveRenderedRgb(pair.bg)
      return {
        ...pair,
        fgValue,
        bgValue,
        ratio: computeContrast(fgValue, bgValue),
      }
    })
    setContrastRows(nextRows)
  }, [theme, brand])

  useEffect(
    () => () => {
      const rootStyle = document.documentElement.style
      for (const key of OVERRIDE_KEYS) {
        rootStyle.removeProperty(key)
      }
    },
    []
  )

  return (
    <UiProvider notices={notices} overlay={overlays}>
      <div className={styles.root}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <IconSettingsOutline16 />
            <h1 className={styles.title}>SSA Component Workbench</h1>
            <Badge tone="accent">@deepseek-chat/lib-ui</Badge>
          </div>
          <div className={styles.controls}>
            <SegmentedControl<WorkbenchTab>
              ariaLabel="Workbench section"
              value={workbenchTab}
              onChange={setWorkbenchTab}
              options={[
                { value: 'ssa', label: 'SSA Live Demo' },
                { value: 'kit', label: 'Component Kit' },
              ]}
            />
            <SegmentedControl<ThemeMode>
              ariaLabel="Theme mode"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light', label: 'Light', icon: <IconLightOutline16 /> },
                { value: 'dark', label: 'Dark', icon: <IconDarkOutline16 /> },
              ]}
            />
            <SegmentedControl<BrandPreset>
              ariaLabel="Brand theme override"
              value={brand}
              onChange={setBrand}
              options={[
                { value: 'default', label: 'Blue' },
                { value: 'emerald', label: 'Emerald' },
                { value: 'terracotta', label: 'Terracotta' },
              ]}
            />
            <Switch label="320px Reflow" checked={reflow320} onChange={setReflow320} />
            <Badge tone={overlayOpen ? 'warning' : 'neutral'}>
              OverlayPort: {overlayOpen ? 'locked' : 'idle'}
            </Badge>
            <LinkButton href="/">Back to App</LinkButton>
          </div>
        </header>

        {workbenchTab === 'ssa' ? (
          <SsaDemo />
        ) : (
          <main className={clsx(styles.body, reflow320 && styles.reflowFrame)}>
            <section className={styles.hero}>
              <h2 className={styles.heroTitle}>Sealed Design System &amp; Token Contract</h2>
              <p className={styles.heroSubtitle}>
                Every primitive below reads semantic <code>--ui-*</code> tokens from{' '}
                <code>spine/design/tokens.css</code>. Toggle Light/Dark or switch Brand Preset above
                to re-theme all 18 primitives at runtime with zero component code changes.
              </p>
              <div className={styles.heroMeta}>
                <Badge tone="success">136 semantic tokens</Badge>
                <Badge tone="success">WCAG 2.2 AA verified</Badge>
                <Badge tone="neutral">Native &lt;dialog&gt; top-layer</Badge>
                <Badge tone="neutral">Tree-shaken from production</Badge>
              </div>
            </section>

            <section className={styles.section} aria-labelledby="wb-actions">
              <div className={styles.sectionHeader}>
                <h2 id="wb-actions" className={styles.sectionTitle}>
                  1. Actions, Chips &amp; Icon Controls
                </h2>
                <p className={styles.sectionNote}>
                  5 variants, 2 sizes, loading &amp; disabled states, 44px coarse pointer targets
                </p>
              </div>
              <div className={styles.grid}>
                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>Button Variants (size=&quot;m&quot;)</h3>
                  <div className={styles.row}>
                    <Button variant="primary">Primary</Button>
                    <Button variant="outlined">Outlined</Button>
                    <Button variant="ghost">Ghost</Button>
                    <Button variant="danger">Danger</Button>
                    <Button variant="dangerOutlined">Danger Outlined</Button>
                  </div>
                  <div className={styles.row}>
                    <Button variant="primary" size="s">
                      Small Primary
                    </Button>
                    <Button variant="outlined" size="s" loading>
                      Saving…
                    </Button>
                    <Button variant="primary" disabled>
                      Disabled
                    </Button>
                    <LinkButton href="#wb-tokens">LinkButton</LinkButton>
                  </div>
                </div>

                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>IconButton, Tooltip &amp; Chip</h3>
                  <div className={styles.row}>
                    <IconButton
                      size="xs"
                      icon={<IconCopyOutline16 />}
                      tooltip="Size xs (28px)"
                      aria-label="Copy xs"
                    />
                    <IconButton
                      size="sm"
                      icon={<IconEditOutline16 />}
                      tooltip="Size sm (32px)"
                      aria-label="Edit sm"
                    />
                    <IconButton
                      size="m"
                      tone="primary"
                      icon={<IconPanelLeftOutline16 />}
                      tooltip="Size m primary (36px)"
                      aria-label="Toggle panel"
                    />
                    <IconButton
                      size="xl"
                      tone="primary"
                      icon={<IconRefreshOutline16 />}
                      tooltip="Size xl (44px)"
                      aria-label="Refresh"
                    />
                  </div>
                  <div className={styles.row}>
                    <Chip icon={<IconSearchOutline16 />}>Back to Activity</Chip>
                    <Chip active icon={<IconBrowseOutline16 />}>
                      Active Filter
                    </Chip>
                    <Chip icon={<IconGlobeLanguageOutline16 />} disabled>
                      Disabled Chip
                    </Chip>
                  </div>
                </div>
              </div>
            </section>

            <section className={styles.section} aria-labelledby="wb-inputs">
              <div className={styles.sectionHeader}>
                <h2 id="wb-inputs" className={styles.sectionTitle}>
                  2. Form Fields &amp; Selection Controls
                </h2>
                <p className={styles.sectionNote}>
                  Wired aria-describedby, aria-invalid, keyboard navigation, and native switch roles
                </p>
              </div>
              <div className={styles.grid}>
                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>TextField &amp; PasswordField</h3>
                  <div className={styles.stack}>
                    <TextField
                      label="Workspace Title"
                      hint="Visible across tabs and previews"
                      value={textValue}
                      onChange={(event) => setTextValue(event.target.value)}
                    />
                    <TextField
                      label="Validation State"
                      value=""
                      placeholder="Required value"
                      error="Enter at least one character to continue."
                      onChange={() => {}}
                    />
                    <PasswordField
                      label="Secret Credential"
                      value={secretValue}
                      onChange={(event) => setSecretValue(event.target.value)}
                    />
                  </div>
                </div>

                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>Select, Switch &amp; SegmentedControl</h3>
                  <div className={styles.stack}>
                    <Select
                      ariaLabel="Language select"
                      value={selectValue}
                      onChange={setSelectValue}
                      options={[
                        { value: 'en', label: 'English (US)' },
                        { value: 'zh', label: '简体中文' },
                        { value: 'ja', label: '日本語' },
                      ]}
                    />
                    <Switch
                      block
                      icon={<IconThinkOutline16 />}
                      label="Deep Reasoning Mode"
                      checked={switchOne}
                      onChange={setSwitchOne}
                    />
                    <Switch
                      block
                      icon={<IconCodeOutline14 />}
                      label="Code Sandbox"
                      checked={switchTwo}
                      onChange={setSwitchTwo}
                    />
                    <SegmentedControl<'preview' | 'source' | 'diff'>
                      ariaLabel="Document view mode"
                      value={segmentValue}
                      onChange={setSegmentValue}
                      options={[
                        { value: 'preview', label: 'Preview' },
                        { value: 'source', label: 'Source' },
                        { value: 'diff', label: 'Diff' },
                      ]}
                    />
                  </div>
                </div>

                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>RadioCardGroup</h3>
                  <RadioCardGroup<'light' | 'dark' | 'system'>
                    ariaLabel="Appearance preference"
                    value={radioValue}
                    onChange={setRadioValue}
                    options={[
                      { value: 'light', label: 'Light', icon: <IconLightOutline16 /> },
                      { value: 'dark', label: 'Dark', icon: <IconDarkOutline16 /> },
                      { value: 'system', label: 'System', icon: <IconSettingsOutline16 /> },
                    ]}
                  />
                </div>
              </div>
            </section>

            <section className={styles.section} aria-labelledby="wb-overlays">
              <div className={styles.sectionHeader}>
                <h2 id="wb-overlays" className={styles.sectionTitle}>
                  3. Overlays, Feedback &amp; Layout Primitives
                </h2>
                <p className={styles.sectionNote}>
                  Top-layer native &lt;dialog&gt;, anchored Popover/Menu/HoverCard, NoticePort
                  toasts
                </p>
              </div>
              <div className={styles.grid}>
                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>Dialog, Popover, Menu &amp; HoverCard</h3>
                  <div className={styles.row}>
                    <Button variant="primary" size="s" onClick={() => setDialogOpen(true)}>
                      Open Confirm Dialog
                    </Button>
                    <Button variant="outlined" size="s" onClick={() => setSheetOpen(true)}>
                      Open Dialog + Nested Select
                    </Button>
                  </div>
                  <div className={styles.row}>
                    <span ref={popoverAnchorRef}>
                      <Button
                        variant="outlined"
                        size="s"
                        onClick={() => setPopoverOpen((value) => !value)}
                      >
                        Toggle Popover
                      </Button>
                    </span>
                    <Popover
                      open={popoverOpen}
                      onOpenChange={setPopoverOpen}
                      anchorRef={popoverAnchorRef}
                      ariaLabel="Sample popover"
                    >
                      <div className={styles.popoverBody}>
                        <span className={styles.cardTitle}>Anchored Popover</span>
                        <span className={styles.cardSubtitle}>
                          Clamps inside viewport, locks OverlayPort, and restores focus on Escape.
                        </span>
                        <Button variant="primary" size="s" onClick={() => setPopoverOpen(false)}>
                          Done
                        </Button>
                      </div>
                    </Popover>

                    <Menu
                      ariaLabel="Sample actions menu"
                      options={[
                        {
                          type: 'command',
                          key: 'rename',
                          label: 'Rename Item',
                          shortcut: '⌘R',
                          icon: <IconEditOutline16 />,
                          onSelect: () => notices.show({ text: () => 'Selected: Rename Item' }),
                        },
                        { type: 'separator', key: 'sep-1' },
                        {
                          type: 'radio',
                          key: 'fit',
                          label: 'Fit to Stage',
                          checked: menuRadio === 'fit',
                          onSelect: () => setMenuRadio('fit'),
                        },
                        {
                          type: 'radio',
                          key: 'actual',
                          label: 'Actual Size (100%)',
                          checked: menuRadio === 'actual',
                          onSelect: () => setMenuRadio('actual'),
                        },
                        {
                          type: 'switch',
                          key: 'grid',
                          label: 'Show Guides',
                          checked: menuChecked,
                          keepOpen: true,
                          onSelect: () => setMenuChecked((value) => !value),
                        },
                        { type: 'separator', key: 'sep-2' },
                        {
                          type: 'command',
                          key: 'delete',
                          label: 'Delete Permanently',
                          danger: true,
                          icon: <IconTrashOutline16 />,
                          onSelect: () =>
                            notices.show({
                              text: () => 'Deleted item (demo notice)',
                              tone: 'error',
                            }),
                        },
                      ]}
                    >
                      {({ triggerProps }) => (
                        <Button variant="outlined" size="s" {...triggerProps}>
                          <IconEllipsisOutline16 />
                          Open Menu
                        </Button>
                      )}
                    </Menu>

                    <PanelTitleMenu
                      label={panelView === 'activity' ? 'Activity' : 'Sources'}
                      ariaLabel="Panel view"
                      options={[
                        {
                          type: 'radio',
                          key: 'activity',
                          label: 'Activity',
                          checked: panelView === 'activity',
                          onSelect: () => setPanelView('activity'),
                        },
                        {
                          type: 'radio',
                          key: 'sources',
                          label: 'Sources',
                          detail: '24',
                          checked: panelView === 'sources',
                          onSelect: () => setPanelView('sources'),
                        },
                      ]}
                    />

                    <HoverCard
                      renderTrigger={({ domRef, domProps }) => (
                        <span ref={domRef} {...domProps} tabIndex={0}>
                          <Badge tone="accent">Hover / Focus Card</Badge>
                        </span>
                      )}
                    >
                      <div className={styles.hoverPreview}>
                        <span className={styles.hoverPreviewTitle}>Portal HoverCard</span>
                        <span>
                          Opens on hover or keyboard focus and stays open while moving into the
                          card.
                        </span>
                      </div>
                    </HoverCard>
                  </div>
                  <div className={styles.row}>
                    <Button
                      variant="ghost"
                      size="s"
                      onClick={() => notices.show({ text: () => 'Settings saved via NoticePort' })}
                    >
                      Trigger Toast
                    </Button>
                    <Button
                      variant="ghost"
                      size="s"
                      onClick={() =>
                        notices.show({
                          text: () => 'Request failed — check your connection.',
                          tone: 'error',
                          link: { text: () => 'Inspect Tokens', href: '#wb-tokens' },
                        })
                      }
                    >
                      Trigger Error Toast
                    </Button>
                  </div>
                </div>

                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>Badges, Banners &amp; Spinners</h3>
                  <div className={styles.row}>
                    <Badge tone="neutral">Neutral</Badge>
                    <Badge tone="accent">Accent</Badge>
                    <Badge tone="success">Verified</Badge>
                    <Badge tone="warning">Pending</Badge>
                    <Badge tone="danger">Error</Badge>
                    <Spinner size="sm" />
                    <Spinner size="md" />
                    <Spinner size="lg" />
                  </div>
                  <div className={styles.stack}>
                    <Banner tone="info">
                      <strong>Info:</strong> Semantic surface &amp; border swap automatically under
                      dark mode.
                    </Banner>
                    <Banner
                      tone="warning"
                      action={
                        <Button variant="outlined" size="s" onClick={() => setBrand('default')}>
                          Reset
                        </Button>
                      }
                    >
                      <strong>Warning:</strong> Brand overrides remain strictly within WCAG 2.2 AA
                      contrast.
                    </Banner>
                    <Banner tone="error">
                      <strong>Error:</strong> Actionable failure state using semantic danger tokens.
                    </Banner>
                  </div>
                </div>

                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>SettingGroup, Tabs &amp; PanelHeader</h3>
                  <div className={styles.panelPreview}>
                    <PanelHeader
                      title="Inspector Panel"
                      subtitle="Standardized header chrome"
                      actions={
                        <Tooltip content="Verified">
                          <IconButton
                            size="xs"
                            icon={<IconCheckOutline16 />}
                            aria-label="Verified action"
                          />
                        </Tooltip>
                      }
                    />
                  </div>
                  <SettingGroup>
                    <SettingRow
                      label="Inline Destructive Confirm"
                      description="Two-step confirmation without leaving the row."
                      action={
                        <SettingInlineConfirm
                          confirming={confirming}
                          triggerLabel="Reset"
                          confirmLabel="Confirm Reset"
                          cancelLabel="Cancel"
                          onOpen={() => setConfirming(true)}
                          onCancel={() => setConfirming(false)}
                          onConfirm={() => {
                            setConfirming(false)
                            notices.show({ text: () => 'Reset confirmed' })
                          }}
                        />
                      }
                    />
                  </SettingGroup>
                  <Tabs value={activeTab} onChange={setActiveTab} className={styles.tabsPreview}>
                    <TabList ariaLabel="Architecture layers">
                      <Tab value="tokens">Tokens</Tab>
                      <Tab value="primitives">Primitives</Tab>
                      <Tab value="contracts">Contracts</Tab>
                    </TabList>
                    <TabPanel value="tokens" className={styles.tabPanelBox}>
                      <code>spine/design/tokens.css</code> defines private primitives and semantic
                      aliases.
                    </TabPanel>
                    <TabPanel value="primitives" className={styles.tabPanelBox}>
                      <code>@deepseek-chat/lib-ui</code> ships 18 accessible primitives with zero UI
                      dependencies.
                    </TabPanel>
                    <TabPanel value="contracts" className={styles.tabPanelBox}>
                      <code>check:dag</code> and <code>check:design</code> verify every boundary in
                      CI.
                    </TabPanel>
                  </Tabs>
                </div>

                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>HoverGlide, FileGlyph &amp; EmptyState</h3>
                  <HoverGlide className={styles.glideList}>
                    {(['item-1', 'item-2', 'item-3'] as const).map((id, index) => (
                      <button
                        key={id}
                        type="button"
                        className={clsx(
                          styles.glideItem,
                          activeGlide === id && styles.glideItemActive
                        )}
                        {...hoverGlideItem(activeGlide === id)}
                        onClick={() => setActiveGlide(id)}
                      >
                        <span>Gliding Navigation Row {index + 1}</span>
                        <Badge tone={activeGlide === id ? 'accent' : 'neutral'}>
                          {activeGlide === id ? 'Active' : 'Idle'}
                        </Badge>
                      </button>
                    ))}
                    <div className={styles.glideActions}>
                      <Button variant="ghost" size="s" {...hoverGlideItem()}>
                        Show more
                      </Button>
                      <Button
                        variant="ghost"
                        size="s"
                        {...hoverGlideItem(activeGlide === 'action-open')}
                        onClick={() =>
                          setActiveGlide((curr) =>
                            curr === 'action-open' ? 'item-1' : 'action-open'
                          )
                        }
                      >
                        Open panel
                      </Button>
                    </div>
                  </HoverGlide>
                  <div className={styles.glyphGrid}>
                    {FILE_GLYPHS.map((item) => (
                      <div key={item.kind} className={styles.glyphItem}>
                        <FileGlyph kind={item.kind} />
                        <span>{item.label}</span>
                      </div>
                    ))}
                  </div>
                  <EmptyState
                    icon={<IconBrowseOutline16 />}
                    title="Empty State Primitive"
                    description="Reusable zero-data layout with consistent typography and spacing."
                  />
                </div>
              </div>
            </section>

            <section id="wb-tokens" className={styles.section} aria-labelledby="wb-tokens-heading">
              <div className={styles.sectionHeader}>
                <h2 id="wb-tokens-heading" className={styles.sectionTitle}>
                  4. Live Computed Token &amp; WCAG 2.2 AA Contrast Inspector
                </h2>
                <p className={styles.sectionNote}>
                  Computed dynamically from active <code>:root</code> styles ({theme} mode, {brand}{' '}
                  preset)
                </p>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Semantic Pair</th>
                      <th>Foreground</th>
                      <th>Background</th>
                      <th>Ratio</th>
                      <th>WCAG 2.2</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contrastRows.map((row) => {
                      const passes = row.ratio !== null && row.ratio >= row.minRatio
                      const aaa = row.ratio !== null && row.ratio >= 7.0
                      return (
                        <tr key={row.label}>
                          <td>{row.label}</td>
                          <td>
                            <span className={styles.swatchCell}>
                              <span
                                className={styles.swatch}
                                style={{ backgroundColor: `var(${row.fg})` }}
                              />
                              <code className={styles.tokenCode}>{row.fg}</code>
                            </span>
                          </td>
                          <td>
                            <span className={styles.swatchCell}>
                              <span
                                className={styles.swatch}
                                style={{ backgroundColor: `var(${row.bg})` }}
                              />
                              <code className={styles.tokenCode}>{row.bg}</code>
                            </span>
                          </td>
                          <td>{row.ratio !== null ? `${row.ratio.toFixed(2)}:1` : '—'}</td>
                          <td>
                            <Badge tone={passes ? 'success' : 'danger'}>
                              {passes ? (aaa ? 'AAA Pass' : 'AA Pass') : 'Fail'}
                            </Badge>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className={styles.grid}>
                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>Spacing &amp; Radius Scales</h3>
                  <div className={styles.specimenRow}>
                    {SPACING_TOKENS.map(([token, px]) => (
                      <div key={token} className={styles.spaceSpecimen}>
                        <div className={styles.spaceBar} style={{ width: `var(${token})` }} />
                        <span>{px}</span>
                      </div>
                    ))}
                  </div>
                  <div className={styles.specimenRow}>
                    {RADIUS_TOKENS.map(([token, label]) => (
                      <div key={token} className={styles.spaceSpecimen}>
                        <div
                          className={styles.radiusSpecimen}
                          style={{ borderRadius: `var(${token})` }}
                        />
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>Typography Scale</h3>
                  <div className={styles.typeRow}>
                    <span className={styles.typeH1}>Heading 1 — 24px / 32px</span>
                    <span className={styles.typeH2}>Heading 2 — 20px / 28px</span>
                    <span className={styles.typeH3}>Heading 3 — 16px / 26px</span>
                    <span className={styles.typeBody}>Body prose — 16px / 26px</span>
                    <span className={styles.typeLabel}>Control label — 14px / 20px</span>
                    <span className={styles.typeCaption}>Caption metadata — 13px / 20px</span>
                    <span>
                      Inline <code className={styles.typeCode}>--ui-type-code-inline</code> specimen
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </main>
        )}

        <Dialog
          open={dialogOpen}
          title="Confirm Action"
          closable
          onClose={() => setDialogOpen(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setDialogOpen(false)
                  notices.show({ text: () => 'Dialog action confirmed' })
                }}
              >
                Confirm
              </Button>
            </>
          }
        >
          Native top-layer <code>&lt;dialog&gt;</code> with backdrop blur, focus trapping, Escape
          dismissal, and automatic OverlayPort coordination.
        </Dialog>

        <Dialog
          open={sheetOpen}
          title="Top-Layer Portal Stacking Test"
          closable
          sheetOnMobile
          size="md"
          onClose={() => setSheetOpen(false)}
          footer={
            <Button variant="primary" onClick={() => setSheetOpen(false)}>
              Close
            </Button>
          }
        >
          <div className={styles.stack}>
            <span>
              Anchored overlays (<code>Select</code>, <code>Menu</code>, <code>Popover</code>)
              portal into their nearest open <code>&lt;dialog&gt;</code> so they render above the
              top-layer backdrop and never falsely dismiss the dialog on click.
            </span>
            <Select
              ariaLabel="Nested top-layer select"
              value={dialogSelect}
              onChange={setDialogSelect}
              options={[
                { value: 'opt-a', label: 'Option Alpha (top-layer safe)' },
                { value: 'opt-b', label: 'Option Beta' },
                { value: 'opt-c', label: 'Option Gamma' },
              ]}
            />
          </div>
        </Dialog>

        <ToastViewport />
      </div>
    </UiProvider>
  )
}
