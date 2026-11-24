import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Badge,
  Banner,
  Button,
  Chip,
  Dialog,
  EmptyState,
  FileGlyph,
  IconButton,
  IconSettingsOutline16,
  LinkButton,
  Menu,
  PanelHeader,
  PasswordField,
  RadioCardGroup,
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
  Tooltip,
} from '@deepseek-chat/lib-ui'

describe('lib-ui primitives semantic & accessibility contracts', () => {
  it('renders Button and LinkButton with native semantics and loading state', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(Button, { variant: 'primary', loading: true }, 'Save'),
        createElement(LinkButton, { href: 'https://example.test' }, 'Console')
      )
    )
    assert.match(html, /<button[^>]*type="button"[^>]*aria-busy="true"/)
    assert.match(html, />Save</)
    assert.match(html, /<a[^>]*href="https:\/\/example\.test"/)
  })

  it('renders IconButton with accessible name from tooltip and native button semantics', () => {
    const html = renderToStaticMarkup(
      createElement(IconButton, {
        icon: createElement(IconSettingsOutline16),
        tooltip: 'Open settings',
      })
    )
    assert.match(html, /<button[^>]*type="button"[^>]*aria-label="Open settings"/)
  })

  it('wires TextField and PasswordField labels, hints, and errors programmatically', () => {
    const textHtml = renderToStaticMarkup(
      createElement(TextField, {
        label: 'Width',
        hint: 'Between 320 and 2560 px',
        error: 'Value out of range',
        value: '100',
        onChange: () => undefined,
      })
    )
    const idMatch = /<label[^>]*for="([^"]+)"/.exec(textHtml)
    assert.ok(idMatch, 'TextField must associate <label for> with its input')
    assert.match(textHtml, new RegExp(`<input[^>]*id="${idMatch[1]}"`))
    assert.match(textHtml, /aria-invalid="true"/)
    assert.match(textHtml, /aria-describedby="/)
    assert.match(textHtml, /role="alert"/)
    // Hint appears before input in DOM so browser autofill popovers do not obscure it.
    assert.ok(textHtml.indexOf('Between 320 and 2560 px') < textHtml.indexOf('<input'))

    const pwdHtml = renderToStaticMarkup(
      createElement(PasswordField, {
        label: 'API Key',
        value: 'secret',
        onChange: () => undefined,
        showLabel: 'Show key',
        hideLabel: 'Hide key',
      })
    )
    assert.match(pwdHtml, /type="password"/)
    assert.match(pwdHtml, /aria-label="Show key"/)
    assert.doesNotMatch(pwdHtml, /onpaste/i)
  })

  it('renders Switch, SegmentedControl, RadioCardGroup, and Tabs with exact ARIA roles', () => {
    const switchHtml = renderToStaticMarkup(
      createElement(Switch, { checked: true, onChange: () => undefined, label: 'Search' })
    )
    assert.match(switchHtml, /<button[^>]*role="switch"[^>]*aria-checked="true"/)

    const segHtml = renderToStaticMarkup(
      createElement(SegmentedControl, {
        ariaLabel: 'View mode',
        value: 'preview',
        onChange: () => undefined,
        options: [
          { value: 'preview', label: 'Preview' },
          { value: 'code', label: 'Code' },
        ],
      })
    )
    assert.match(segHtml, /role="group"/)
    assert.match(segHtml, /aria-pressed="true"/)
    assert.match(segHtml, /aria-pressed="false"/)

    const radioHtml = renderToStaticMarkup(
      createElement(RadioCardGroup, {
        ariaLabel: 'Theme',
        value: 'dark',
        onChange: () => undefined,
        options: [
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
      })
    )
    assert.match(radioHtml, /role="radiogroup"/)
    assert.match(radioHtml, /role="radio"[^>]*aria-checked="true"/)

    const tabsHtml = renderToStaticMarkup(
      createElement(
        Tabs,
        { value: 'a', onChange: () => undefined },
        createElement(
          TabList,
          { ariaLabel: 'Sections' },
          createElement(Tab, { value: 'a' }, 'First'),
          createElement(Tab, { value: 'b' }, 'Second')
        ),
        createElement(TabPanel, { value: 'a' }, 'Panel A')
      )
    )
    assert.match(tabsHtml, /role="tablist"/)
    assert.match(tabsHtml, /role="tab"[^>]*aria-selected="true"/)
    assert.match(tabsHtml, /role="tabpanel"/)
  })

  it('renders Dialog as a native <dialog> without redundant role="dialog" or aria-modal', () => {
    const html = renderToStaticMarkup(
      createElement(
        Dialog,
        { open: true, title: 'Confirm delete', onClose: () => undefined, closable: true },
        'Delete all items?'
      )
    )
    assert.match(html, /<dialog\b/)
    assert.match(html, /<h1[^>]*>Confirm delete<\/h1>/)
    assert.match(html, /aria-labelledby="/)
    assert.doesNotMatch(html, /role="dialog"/)
    assert.doesNotMatch(html, /aria-modal=/)
  })

  it('renders Select, Menu, Tooltip, Chip, feedback, layout, and FileGlyph cleanly', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(Select, {
          value: 'en',
          ariaLabel: 'Language',
          options: [{ value: 'en', label: 'English' }],
          onChange: () => undefined,
        }),
        createElement(Menu, {
          options: [{ key: 'del', label: 'Delete', danger: true, onSelect: () => undefined }],
          renderTrigger: ({ triggerProps }) =>
            createElement('button', { ...triggerProps, type: 'button' }, 'More'),
        }),
        createElement(Tooltip, { content: 'Hint' }, createElement('span', null, 'Target')),
        createElement(Chip, { active: true }, 'Activity'),
        createElement(Badge, { tone: 'success' }, 'Verified'),
        createElement(Banner, { tone: 'error' }, 'Something failed'),
        createElement(EmptyState, { title: 'Empty', description: 'Nothing here' }),
        createElement(Spinner, { label: 'Loading' }),
        createElement(
          SettingGroup,
          null,
          createElement(SettingRow, {
            label: 'Locale',
            description: 'Display language',
            action: createElement(SettingInlineConfirm, {
              confirming: false,
              triggerLabel: 'Remove',
              confirmLabel: 'Confirm',
              cancelLabel: 'Cancel',
              onOpen: () => undefined,
              onConfirm: () => undefined,
              onCancel: () => undefined,
            }),
          })
        ),
        createElement(PanelHeader, { title: 'Inspector' }),
        createElement(FileGlyph, { kind: 'pdf' })
      )
    )
    assert.match(html, /aria-haspopup="listbox"/)
    assert.match(html, /aria-haspopup="menu"/)
    assert.match(html, /role="alert"/)
    assert.match(html, /data-tauri-drag-region/)
    assert.match(html, /var\(--ui-glyph-pdf\)/)
  })
})
