/**
 * JavaScript driver snippets evaluated inside the browser child webview.
 * Every snippet is synchronous, self-contained, and returns JSON.stringify({ ok, ... })
 * so WKWebView (macOS), WebView2 (Windows), and WebKitGTK (Linux) handle results uniformly.
 */

const SHARED_HELPERS = `
const __DS_KEY = Symbol.for('__ds_browser_driver__');
const __dsStore = window[__DS_KEY] || (window[__DS_KEY] = { refs: new Map(), seq: 0 });

const __isVisible = (el) => {
  if (!el || !(el instanceof Element)) return false;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0.5 && rect.height > 0.5;
};

const __inViewport = (rect) => {
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
};

const __deepElementFromPoint = (x, y) => {
  let root = document;
  let el = root.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
};

const __resolveTarget = (ref, x, y) => {
  if (typeof ref === 'string' && ref.trim()) {
    const key = ref.trim().replace(/^@/, '');
    const weak = __dsStore.refs.get(key);
    const el = weak ? weak.deref() : null;
    if (!el || !el.isConnected) {
      throw new Error('Element ref ' + key + ' is stale or no longer in the document. Call browser_observe to refresh refs.');
    }
    return el;
  }
  if (typeof x === 'number' && typeof y === 'number') {
    const el = __deepElementFromPoint(x, y);
    if (!el) {
      throw new Error('No element found at coordinates (' + x + ', ' + y + ').');
    }
    return el;
  }
  throw new Error('Either ref or (x, y) coordinates must be provided.');
};

const __flashHighlight = (el) => {
  try {
    const rect = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.setAttribute('data-ds-overlay', '1');
    box.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483646',
      'left:' + Math.max(0, rect.left - 2) + 'px',
      'top:' + Math.max(0, rect.top - 2) + 'px',
      'width:' + Math.max(8, rect.width + 4) + 'px',
      'height:' + Math.max(8, rect.height + 4) + 'px',
      'border:2px solid #3964fe',
      'background:rgba(57,100,254,0.12)',
      'border-radius:6px',
      'box-sizing:border-box',
      'transition:opacity 240ms ease',
    ].join(';');
    (document.documentElement || document.body).appendChild(box);
    setTimeout(() => { box.style.opacity = '0'; }, 220);
    setTimeout(() => { box.remove(); }, 500);
  } catch {}
};

const __querySelectorDeep = (selector) => {
  const stack = [document];
  while (stack.length) {
    const root = stack.pop();
    try {
      const found = root.querySelector(selector);
      if (found) return found;
    } catch {
      return null;
    }
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) stack.push(all[i].shadowRoot);
    }
  }
  return null;
};
`

export type SnapshotOptions = {
  includeText?: boolean
  selector?: string
  maxElements?: number
  maxTextChars?: number
}

export const buildSnapshotScript = (options: SnapshotOptions = {}): string => {
  const args = JSON.stringify({
    includeText: options.includeText ?? true,
    selector: options.selector ?? null,
    maxElements: options.maxElements ?? 140,
    maxTextChars: options.maxTextChars ?? 12_000,
  })
  return `
try {
  ${SHARED_HELPERS}
  const opts = ${args};
  __dsStore.refs = new Map();
  __dsStore.seq = 0;

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
    'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'slider', 'spinbutton'
  ]);

  const isInteractive = (el) => {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
    if (el.getAttribute('data-ds-overlay') === '1') return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'summary') {
      return !(el instanceof HTMLInputElement && el.type === 'hidden');
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable) return true;
    const tabIdx = el.getAttribute('tabindex');
    if (tabIdx !== null && tabIdx !== '-1') return true;
    if (typeof el.onclick === 'function') return true;
    return false;
  };

  const getLabel = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent?.trim() || '').filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.labels && el.labels.length > 0) {
        const labelTxt = Array.from(el.labels).map((l) => l.textContent?.trim() || '').filter(Boolean).join(' ');
        if (labelTxt) return labelTxt;
      }
      if ('placeholder' in el && el.placeholder) return el.placeholder.trim();
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.slice(0, 90);
  };

  const rootNode = opts.selector ? (__querySelectorDeep(opts.selector) || document.body) : document.body;
  const rawElements = [];
  const walk = (node) => {
    if (!node) return;
    if (node instanceof Element) {
      if (node.getAttribute('data-ds-overlay') === '1') return;
      if (isInteractive(node) && __isVisible(node)) {
        const rect = node.getBoundingClientRect();
        rawElements.push({ el: node, rect, inView: __inViewport(rect) });
      }
      if (node.shadowRoot) {
        for (const child of node.shadowRoot.children) walk(child);
      }
    }
    for (const child of node.children || []) walk(child);
  };
  if (rootNode) walk(rootNode);

  // Prioritize visible in-viewport elements first, then offscreen elements
  rawElements.sort((a, b) => Number(b.inView) - Number(a.inView));
  const picked = rawElements.slice(0, opts.maxElements);

  const elements = picked.map(({ el, rect, inView }) => {
    const ref = 'e' + (++__dsStore.seq);
    __dsStore.refs.set(ref, new WeakRef(el));
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || (
      tag === 'a' ? 'link'
      : tag === 'button' ? 'button'
      : tag === 'textarea' ? 'textarea'
      : tag === 'select' ? 'select'
      : tag === 'input' ? ('input:' + (el.type || 'text'))
      : el.isContentEditable ? 'textbox'
      : tag
    )).toLowerCase();
    const entry = {
      ref,
      role,
      label: getLabel(el),
      inView,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password') {
        entry.value = el.value ? '[REDACTED]' : '';
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        entry.checked = el.checked;
      } else if (el.value) {
        entry.value = el.value.slice(0, 120);
      }
      if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value) entry.value = el.value.slice(0, 120);
      if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLSelectElement) {
      entry.value = el.value;
      entry.options = Array.from(el.options).slice(0, 20).map((o) => ({
        value: o.value,
        text: (o.text || '').trim().slice(0, 60),
        selected: o.selected,
      }));
      if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLAnchorElement && el.href) {
      entry.href = el.getAttribute('href')?.slice(0, 140) || '';
    } else if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
      entry.disabled = true;
    }
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true' || expanded === 'false') entry.expanded = expanded === 'true';
    const checked = el.getAttribute('aria-checked');
    if (checked === 'true' || checked === 'false') entry.checked = checked === 'true';
    return entry;
  });

  let pageText = '';
  if (opts.includeText && rootNode) {
    const rawText = (rootNode.innerText || rootNode.textContent || '')
      .replace(/\\r\\n/g, '\\n')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
    pageText = rawText.length > opts.maxTextChars
      ? rawText.slice(0, opts.maxTextChars) + '\\n[Text truncated]'
      : rawText;
  }

  const active = document.activeElement;
  const focused = active && active !== document.body
    ? { tag: active.tagName.toLowerCase(), label: getLabel(active) }
    : null;

  return JSON.stringify({
    ok: true,
    url: location.href,
    title: document.title || '',
    readyState: document.readyState,
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      width: Math.round(document.documentElement.scrollWidth),
      height: Math.round(document.documentElement.scrollHeight),
      viewportWidth: Math.round(window.innerWidth),
      viewportHeight: Math.round(window.innerHeight),
    },
    focused,
    totalInteractiveCount: rawElements.length,
    elements,
    pageText,
  });
} catch (err) {
  return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`
}

export const buildShowSomBadgesScript = (zoom = 1): string => {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const inv = Math.min(4, Math.max(1, 1 / safeZoom))
  const fontSize = Math.round(10 * inv)
  const lineHeight = Math.round(12 * inv)
  const padY = Math.max(1, Math.round(1 * inv))
  const padX = Math.max(4, Math.round(4 * inv))
  const border = Math.max(1, Math.round(inv))
  const radius = Math.max(4, Math.round(4 * inv))
  const edgeW = Math.round(36 * inv)
  const edgeH = Math.round(18 * inv)
  return `
try {
  ${SHARED_HELPERS}
  document.querySelectorAll('[data-ds-som="1"]').forEach((n) => n.remove());
  const container = document.createElement('div');
  container.setAttribute('data-ds-overlay', '1');
  container.setAttribute('data-ds-som', '1');
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  for (const [ref, weak] of __dsStore.refs.entries()) {
    const el = weak.deref();
    if (!el || !el.isConnected || !__isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (!__inViewport(rect)) continue;
    const tag = document.createElement('span');
    tag.textContent = ref;
    tag.style.cssText = [
      'position:fixed',
      'left:' + Math.max(2, Math.min(window.innerWidth - ${edgeW}, rect.left)) + 'px',
      'top:' + Math.max(2, Math.min(window.innerHeight - ${edgeH}, rect.top)) + 'px',
      'padding:${padY}px ${padX}px',
      'border-radius:${radius}px',
      'background:#1b1b1c',
      'color:#ffffff',
      'border:${border}px solid #5686fe',
      'font:600 ${fontSize}px/${lineHeight}px ui-monospace,SFMono-Regular,Menlo,monospace',
      'box-shadow:0 1px 3px rgba(0,0,0,0.4)',
    ].join(';');
    container.appendChild(tag);
  }
  (document.documentElement || document.body).appendChild(container);
  return JSON.stringify({ ok: true });
} catch (err) {
  return JSON.stringify({ ok: false, error: String(err) });
}
`
}

export const buildHideSomBadgesScript = (): string => `
try {
  document.querySelectorAll('[data-ds-som="1"]').forEach((n) => n.remove());
  return JSON.stringify({ ok: true });
} catch {
  return JSON.stringify({ ok: true });
}
`

export const buildClickScript = (params: {
  ref?: string
  x?: number
  y?: number
  button?: 'left' | 'right' | 'middle'
  doubleClick?: boolean
}): string => {
  const args = JSON.stringify(params)
  return `
try {
  ${SHARED_HELPERS}
  const p = ${args};
  const el = __resolveTarget(p.ref, p.x, p.y);
  if (el.scrollIntoView) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
  const rect = el.getBoundingClientRect();
  const cx = typeof p.x === 'number' && !p.ref ? p.x : Math.round(rect.left + rect.width / 2);
  const cy = typeof p.y === 'number' && !p.ref ? p.y : Math.round(rect.top + rect.height / 2);
  __flashHighlight(el);

  const btn = p.button === 'right' ? 2 : p.button === 'middle' ? 1 : 0;
  const init = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: btn };
  el.dispatchEvent(new PointerEvent('pointerover', init));
  el.dispatchEvent(new MouseEvent('mouseover', init));
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));

  if (btn === 2) {
    el.dispatchEvent(new MouseEvent('contextmenu', init));
  } else if (p.doubleClick) {
    if (typeof el.click === 'function') el.click();
    el.dispatchEvent(new MouseEvent('dblclick', init));
  } else if (typeof el.click === 'function') {
    el.click();
  } else {
    el.dispatchEvent(new MouseEvent('click', init));
  }

  return JSON.stringify({
    ok: true,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    href: el instanceof HTMLAnchorElement ? el.href : undefined,
  });
} catch (err) {
  return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`
}

export const buildTypeScript = (params: {
  ref?: string
  x?: number
  y?: number
  text: string
  clear?: boolean
  submit?: boolean
}): string => {
  const args = JSON.stringify(params)
  return `
try {
  ${SHARED_HELPERS}
  const p = ${args};
  let el;
  if (p.ref || (typeof p.x === 'number' && typeof p.y === 'number')) {
    el = __resolveTarget(p.ref, p.x, p.y);
  } else if (document.activeElement && document.activeElement !== document.body) {
    el = document.activeElement;
  } else {
    throw new Error('No ref, coordinates, or active focused element to type into.');
  }
  if (el.scrollIntoView) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
  __flashHighlight(el);
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });

  const shouldClear = p.clear !== false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const nextVal = shouldClear ? p.text : (el.value + p.text);
    if (setter) {
      setter.call(el, nextVal);
    } else {
      el.value = nextVal;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: p.text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    if (shouldClear) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    const inserted = document.execCommand && document.execCommand('insertText', false, p.text);
    if (!inserted) {
      el.textContent = shouldClear ? p.text : ((el.textContent || '') + p.text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: p.text }));
    }
  } else {
    throw new Error('Target element <' + el.tagName.toLowerCase() + '> is not editable.');
  }

  if (p.submit) {
    const enterInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const kd = el.dispatchEvent(new KeyboardEvent('keydown', enterInit));
    el.dispatchEvent(new KeyboardEvent('keypress', enterInit));
    el.dispatchEvent(new KeyboardEvent('keyup', enterInit));
    if (kd && el.form) {
      if (typeof el.form.requestSubmit === 'function') {
        el.form.requestSubmit();
      } else {
        el.form.submit();
      }
    }
  }

  return JSON.stringify({
    ok: true,
    tag: el.tagName.toLowerCase(),
    length: p.text.length,
    submitted: Boolean(p.submit),
  });
} catch (err) {
  return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`
}

export const buildPressKeyScript = (params: {
  key: string
  modifiers?: ('meta' | 'ctrl' | 'alt' | 'shift')[]
}): string => {
  const args = JSON.stringify(params)
  return `
try {
  const p = ${args};
  const mods = new Set(p.modifiers || []);
  const target = document.activeElement || document.body || document.documentElement;
  const key = p.key;
  const keyCodeMap = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32, PageDown: 34, PageUp: 33, Home: 36, End: 35 };
  const codeMap = { ' ': 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace' };
  const keyCode = keyCodeMap[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const evInit = {
    key,
    code: codeMap[key] || (key.length === 1 ? 'Key' + key.toUpperCase() : key),
    keyCode,
    which: keyCode,
    metaKey: mods.has('meta'),
    ctrlKey: mods.has('ctrl'),
    altKey: mods.has('alt'),
    shiftKey: mods.has('shift'),
    bubbles: true,
    cancelable: true,
  };
  const notPrevented = target.dispatchEvent(new KeyboardEvent('keydown', evInit));
  target.dispatchEvent(new KeyboardEvent('keypress', evInit));
  target.dispatchEvent(new KeyboardEvent('keyup', evInit));

  if (notPrevented) {
    if (key === 'Enter' && target instanceof HTMLInputElement && target.form) {
      if (typeof target.form.requestSubmit === 'function') target.form.requestSubmit();
    } else if (key === 'PageDown') {
      window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: 'instant' });
    } else if (key === 'PageUp') {
      window.scrollBy({ top: -Math.round(window.innerHeight * 0.85), behavior: 'instant' });
    } else if (key === 'ArrowDown' && (target === document.body || target === document.documentElement)) {
      window.scrollBy({ top: 120, behavior: 'instant' });
    } else if (key === 'ArrowUp' && (target === document.body || target === document.documentElement)) {
      window.scrollBy({ top: -120, behavior: 'instant' });
    } else if (key === ' ' && (target === document.body || target === document.documentElement)) {
      window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'instant' });
    }
  }

  return JSON.stringify({ ok: true, key });
} catch (err) {
  return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`
}

export const buildScrollScript = (params: {
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  ref?: string
  to?: 'top' | 'bottom'
}): string => {
  const args = JSON.stringify(params)
  return `
try {
  ${SHARED_HELPERS}
  const p = ${args};
  const container = p.ref ? __resolveTarget(p.ref) : null;
  const dist = typeof p.amount === 'number' && p.amount > 0 ? p.amount : Math.round(window.innerHeight * 0.75);
  if (container) {
    if (p.to === 'top') container.scrollTop = 0;
    else if (p.to === 'bottom') container.scrollTop = container.scrollHeight;
    else if (p.direction === 'up') container.scrollTop -= dist;
    else if (p.direction === 'left') container.scrollLeft -= dist;
    else if (p.direction === 'right') container.scrollLeft += dist;
    else container.scrollTop += dist;
    return JSON.stringify({
      ok: true,
      scrollX: Math.round(container.scrollLeft),
      scrollY: Math.round(container.scrollTop),
      scrollHeight: Math.round(container.scrollHeight),
    });
  }
  if (p.to === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
  else if (p.to === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  else if (p.direction === 'up') window.scrollBy({ top: -dist, behavior: 'instant' });
  else if (p.direction === 'left') window.scrollBy({ left: -dist, behavior: 'instant' });
  else if (p.direction === 'right') window.scrollBy({ left: dist, behavior: 'instant' });
  else window.scrollBy({ top: dist, behavior: 'instant' });

  return JSON.stringify({
    ok: true,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
  });
} catch (err) {
  return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`
}

export const buildSelectScript = (params: { ref: string; values: string[] }): string => {
  const args = JSON.stringify(params)
  return `
try {
  ${SHARED_HELPERS}
  const p = ${args};
  const el = __resolveTarget(p.ref);
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error('Target element <' + el.tagName.toLowerCase() + '> is not a <select>.');
  }
  __flashHighlight(el);
  const wanted = new Set((p.values || []).map(String));
  let matched = 0;
  for (const opt of el.options) {
    const match = wanted.has(opt.value) || wanted.has((opt.text || '').trim());
    if (el.multiple) {
      opt.selected = match;
      if (match) matched++;
    } else if (match && matched === 0) {
      opt.selected = true;
      matched++;
    }
  }
  if (matched === 0) {
    throw new Error('No matching <option> found for values: ' + JSON.stringify(p.values));
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ ok: true, value: el.value, matched });
} catch (err) {
  return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`
}

export const buildWaitProbeScript = (params: {
  selector?: string
  text?: string
  urlContains?: string
}): string => {
  const args = JSON.stringify(params)
  return `
try {
  ${SHARED_HELPERS}
  const p = ${args};
  let matched = true;
  if (p.urlContains && !location.href.includes(p.urlContains)) matched = false;
  if (matched && p.selector) {
    const el = __querySelectorDeep(p.selector);
    if (!el || !__isVisible(el)) matched = false;
  }
  if (matched && p.text) {
    const bodyText = (document.body?.innerText || document.body?.textContent || '');
    if (!bodyText.includes(p.text)) matched = false;
  }
  return JSON.stringify({ ok: true, matched, url: location.href });
} catch (err) {
  return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`
}

const looksLikeStatementBody = (script: string): boolean =>
  /\b(return|throw|const|let|var|function|class|for|while|do|if|try|switch|debugger)\b|;|\n/.test(
    script
  )

export const buildPageEvalScript = (userScript: string): string => {
  const trimmed = userScript.trim()
  const body = looksLikeStatementBody(trimmed) ? userScript : `return (${trimmed});`
  return `
try {
  const __res = await (async () => {
${body}
  })();
  return JSON.stringify({ ok: true, value: __res === undefined ? null : __res });
} catch (err) {
  return JSON.stringify({
    ok: false,
    error: err instanceof Error ? (err.stack || err.message) : String(err),
  });
}
`
}
