/**
 * JavaScript driver snippets evaluated inside the browser child webview.
 * Every snippet is synchronous, self-contained, and returns JSON.stringify({ ok, ... })
 * so WKWebView (macOS), WebView2 (Windows), and WebKitGTK (Linux) handle results uniformly.
 */

const CATCH_DRIVER_ERROR = `
  return JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    ...(err && typeof err === 'object' && err.__staleRef ? { staleRef: err.__staleRef } : {}),
  });
`

const SHARED_HELPERS = `
const __DS_KEY = Symbol.for('__ds_browser_driver__');
const __dsStore = window[__DS_KEY] || (window[__DS_KEY] = { refs: new Map(), elToRef: new WeakMap(), meta: new Map(), seq: 0 });
if (!__dsStore.elToRef) __dsStore.elToRef = new WeakMap();
if (!__dsStore.meta) __dsStore.meta = new Map();

const __ownerWin = (node) => (node && node.ownerDocument && node.ownerDocument.defaultView) || window;
const __tag = (el) => (el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '');

const __isElement = (node) => {
  if (!node || typeof node !== 'object') return false;
  if (node instanceof Element) return true;
  const W = __ownerWin(node);
  if (W && W.Element && node instanceof W.Element) return true;
  return node.nodeType === 1;
};

const __isHtmlOrSvg = (el) => {
  if (!el || typeof el !== 'object') return false;
  if (el instanceof HTMLElement || el instanceof SVGElement) return true;
  const W = __ownerWin(el);
  if (W && ((W.HTMLElement && el instanceof W.HTMLElement) || (W.SVGElement && el instanceof W.SVGElement))) {
    return true;
  }
  return false;
};

const __computedStyle = (el) => {
  const W = __ownerWin(el);
  return typeof W.getComputedStyle === 'function' ? W.getComputedStyle(el) : getComputedStyle(el);
};

const __getFrameDocument = (iframeEl) => {
  try {
    const doc = iframeEl.contentDocument || (iframeEl.contentWindow && iframeEl.contentWindow.document) || null;
    if (!doc) return { doc: null, crossOrigin: false };
    void doc.body;
    return { doc, crossOrigin: false };
  } catch {
    return { doc: null, crossOrigin: true };
  }
};

const __isVisible = (el) => {
  if (!__isElement(el)) return false;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
  const style = __computedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0.5 && rect.height > 0.5;
};

const __inViewport = (rect) => {
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
};

const __clearOverlays = (rootDoc, depth = 0) => {
  if (!rootDoc || depth > 4) return;
  try {
    if (typeof rootDoc.querySelectorAll === 'function') {
      const boxes = rootDoc.querySelectorAll('[data-ds-overlay="1"]');
      for (let i = 0; i < boxes.length; i++) {
        if (typeof boxes[i].remove === 'function') boxes[i].remove();
      }
      const frames = rootDoc.querySelectorAll('iframe');
      for (let i = 0; i < frames.length; i++) {
        const info = __getFrameDocument(frames[i]);
        if (info.doc) __clearOverlays(info.doc, depth + 1);
      }
    }
  } catch {}
};

const __getActiveElement = () => {
  let doc = document;
  let active = doc.activeElement;
  for (let d = 0; d < 6 && active; d++) {
    if (active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
      continue;
    }
    if (__tag(active) === 'iframe') {
      const info = __getFrameDocument(active);
      if (info.doc && info.doc.activeElement && info.doc.activeElement !== info.doc.body) {
        doc = info.doc;
        active = doc.activeElement;
        continue;
      }
    }
    break;
  }
  return active;
};

const __deepElementFromPoint = (x, y) => {
  let doc = document;
  let lx = x;
  let ly = y;
  let el = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(lx, ly) : null;
  for (let d = 0; d < 6 && el; d++) {
    if (el.shadowRoot && typeof el.shadowRoot.elementFromPoint === 'function') {
      const inner = el.shadowRoot.elementFromPoint(lx, ly);
      if (inner && inner !== el) {
        el = inner;
        continue;
      }
    }
    if (__tag(el) === 'iframe') {
      const info = __getFrameDocument(el);
      if (info.doc && typeof info.doc.elementFromPoint === 'function') {
        const r = el.getBoundingClientRect();
        lx = lx - r.left - (el.clientLeft || 0);
        ly = ly - r.top - (el.clientTop || 0);
        const inner = info.doc.elementFromPoint(lx, ly);
        if (inner) {
          doc = info.doc;
          el = inner;
          continue;
        }
      }
    }
    break;
  }
  return el;
};

const __resolveTarget = (ref, x, y) => {
  if (typeof ref === 'string' && ref.trim()) {
    const key = ref.trim().replace(/^@/, '');
    const weak = __dsStore.refs.get(key);
    const el = weak ? weak.deref() : null;
    if (!el || !el.isConnected) {
      const prev = __dsStore.meta.get(key) || null;
      const desc = prev ? ' (' + prev.role + (prev.label ? ' ' + JSON.stringify(prev.label) : '') + ')' : '';
      const err = new Error('Element ref ' + key + desc + ' is stale or no longer in the document.');
      err.__staleRef = { ref: key, role: prev ? prev.role : null, label: prev ? prev.label : null };
      throw err;
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
    const doc = (el && el.ownerDocument) || document;
    const rect = el.getBoundingClientRect();
    const box = doc.createElement('div');
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
    (doc.documentElement || doc.body).appendChild(box);
    setTimeout(() => { box.style.opacity = '0'; }, 220);
    setTimeout(() => { box.remove(); }, 500);
  } catch {}
};

const __querySelectorDeep = (selector) => {
  const stack = [{ root: document, depth: 0 }];
  while (stack.length) {
    const { root, depth } = stack.pop();
    try {
      const found = typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
      if (found) return found;
    } catch {
      return null;
    }
    const all = typeof root.querySelectorAll === 'function' ? root.querySelectorAll('*') : [];
    for (let i = 0; i < all.length; i++) {
      const node = all[i];
      if (node.shadowRoot) stack.push({ root: node.shadowRoot, depth });
      if (__tag(node) === 'iframe' && depth < 4) {
        const info = __getFrameDocument(node);
        if (info.doc) stack.push({ root: info.doc, depth: depth + 1 });
      }
    }
  }
  return null;
};

const __collectSameOriginFrameBodies = (rootNode, depth = 0, out = []) => {
  if (!rootNode || depth > 4) return out;
  const children = rootNode.children || [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (__tag(child) === 'iframe') {
      const info = __getFrameDocument(child);
      if (info.doc && info.doc.body) {
        out.push(info.doc.body);
        __collectSameOriginFrameBodies(info.doc.body, depth + 1, out);
      }
    } else {
      if (child.shadowRoot) __collectSameOriginFrameBodies(child.shadowRoot, depth, out);
      __collectSameOriginFrameBodies(child, depth, out);
    }
  }
  return out;
};
`

export type SnapshotOptions = {
  includeText?: boolean
  selector?: string
  clearOverlays?: boolean
  maxElements?: number
  maxTextChars?: number
}

export const buildSnapshotScript = (options: SnapshotOptions = {}): string => {
  const args = JSON.stringify({
    includeText: options.includeText ?? true,
    selector: options.selector ?? null,
    clearOverlays: options.clearOverlays === true,
    maxElements: options.maxElements ?? 140,
    maxScrollables: 8,
    maxIframes: 12,
    maxSelectOptions: 20,
    maxTextChars: options.maxTextChars ?? 12_000,
  })
  return `
try {
  ${SHARED_HELPERS}
  const opts = ${args};
  if (opts.clearOverlays) {
    __clearOverlays(document);
  }
  for (const [existingRef, weak] of __dsStore.refs.entries()) {
    const existingEl = weak.deref();
    if (!existingEl || !existingEl.isConnected) {
      __dsStore.refs.delete(existingRef);
    }
  }

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
    'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'slider', 'spinbutton'
  ]);

  const isInteractive = (el) => {
    if (!__isHtmlOrSvg(el)) return false;
    if (el.getAttribute('data-ds-overlay') === '1') return false;
    const tag = __tag(el);
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'summary') {
      return !(tag === 'input' && (el.type || '').toLowerCase() === 'hidden');
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable) return true;
    const tabIdx = el.getAttribute('tabindex');
    if (tabIdx !== null && tabIdx !== '-1') return true;
    if (typeof el.onclick === 'function') return true;
    return false;
  };

  const isScrollableContainer = (el) => {
    if (!__isHtmlOrSvg(el)) return false;
    if (el.getAttribute('data-ds-overlay') === '1') return false;
    const tag = __tag(el);
    if (tag === 'html' || tag === 'body' || tag === 'iframe') return false;
    const style = __computedStyle(el);
    const oy = style.overflowY || style.overflow || '';
    const ox = style.overflowX || style.overflow || '';
    const canY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
      (el.scrollHeight || 0) > (el.clientHeight || 0) + 24 &&
      (el.clientHeight || 0) >= 80;
    const canX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') &&
      (el.scrollWidth || 0) > (el.clientWidth || 0) + 24 &&
      (el.clientWidth || 0) >= 80;
    if (!canY && !canX) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 120 && rect.height >= 100;
  };

  const getLabel = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ownerDoc = el.ownerDocument || document;
      const parts = labelledBy.split(/\\s+/).map((id) => ownerDoc.getElementById(id)?.textContent?.trim() || '').filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    const tag = __tag(el);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.labels && el.labels.length > 0) {
        const labelTxt = Array.from(el.labels).map((l) => l.textContent?.trim() || '').filter(Boolean).join(' ');
        if (labelTxt) return labelTxt;
      }
      if ('placeholder' in el && el.placeholder) return String(el.placeholder).trim();
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 90);
    if (typeof el.querySelector === 'function') {
      const img = el.querySelector('img[alt]');
      const imgAlt = img && img.getAttribute('alt');
      if (imgAlt && imgAlt.trim()) return imgAlt.trim().slice(0, 90);
    }
    return '';
  };

  const rootNode = opts.selector ? (__querySelectorDeep(opts.selector) || document.body) : document.body;
  const rawElements = [];
  const scrollableElements = [];
  const crossOriginIframes = [];
  const frameTextBodies = [];

  const toAbsRect = (r, ox, oy) => ({
    left: r.left + ox,
    top: r.top + oy,
    right: r.right + ox,
    bottom: r.bottom + oy,
    width: r.width,
    height: r.height,
  });

  const walk = (node, offsetX, offsetY, depth) => {
    if (!node) return;
    if (__isElement(node)) {
      if (node.getAttribute('data-ds-overlay') === '1') return;
      const tag = __tag(node);
      if (tag === 'iframe') {
        if (__isVisible(node)) {
          const fRect = node.getBoundingClientRect();
          const absRect = toAbsRect(fRect, offsetX, offsetY);
          const info = __getFrameDocument(node);
          if (info.doc && info.doc.body && depth < 4) {
            frameTextBodies.push(info.doc.body);
            const nextX = offsetX + fRect.left + (node.clientLeft || 0);
            const nextY = offsetY + fRect.top + (node.clientTop || 0);
            walk(info.doc.body, nextX, nextY, depth + 1);
          } else {
            const rawSrc = (node.getAttribute('src') || node.src || '').trim();
            if ((info.crossOrigin || /^https?:/i.test(rawSrc)) && crossOriginIframes.length < opts.maxIframes) {
              const title = (node.getAttribute('title') || node.getAttribute('aria-label') || node.getAttribute('name') || '').trim().slice(0, 80);
              crossOriginIframes.push({
                src: rawSrc.slice(0, 200),
                title,
                inView: __inViewport(absRect),
                rect: {
                  x: Math.round(absRect.left),
                  y: Math.round(absRect.top),
                  w: Math.round(absRect.width),
                  h: Math.round(absRect.height),
                },
              });
            }
          }
        }
        return;
      }
      const interactive = isInteractive(node);
      if (interactive && __isVisible(node)) {
        const absRect = toAbsRect(node.getBoundingClientRect(), offsetX, offsetY);
        rawElements.push({ el: node, rect: absRect, inView: __inViewport(absRect), isScrollable: false });
      } else if (!interactive && scrollableElements.length < opts.maxScrollables && __isVisible(node) && isScrollableContainer(node)) {
        const absRect = toAbsRect(node.getBoundingClientRect(), offsetX, offsetY);
        scrollableElements.push({ el: node, rect: absRect, inView: __inViewport(absRect), isScrollable: true });
      }
      if (node.shadowRoot) {
        for (const child of node.shadowRoot.children) walk(child, offsetX, offsetY, depth);
      }
    }
    for (const child of node.children || []) walk(child, offsetX, offsetY, depth);
  };
  if (rootNode) walk(rootNode, 0, 0, 0);

  // Prioritize visible in-viewport elements first, then offscreen elements
  rawElements.sort((a, b) => Number(b.inView) - Number(a.inView));
  scrollableElements.sort((a, b) => Number(b.inView) - Number(a.inView));
  const interactiveBudget = Math.max(0, opts.maxElements - scrollableElements.length);
  const picked = [...rawElements.slice(0, interactiveBudget), ...scrollableElements];

  const elements = picked.map(({ el, rect, inView, isScrollable }) => {
    let ref = __dsStore.elToRef.get(el);
    if (!ref) {
      ref = 'e' + (++__dsStore.seq);
      __dsStore.elToRef.set(el, ref);
    }
    __dsStore.refs.set(ref, new WeakRef(el));
    const tag = __tag(el);
    const role = isScrollable
      ? 'scrollable'
      : (el.getAttribute('role') || (
          tag === 'a' ? 'link'
          : tag === 'button' ? 'button'
          : tag === 'textarea' ? 'textarea'
          : tag === 'select' ? 'select'
          : tag === 'input' ? ('input:' + (el.type || 'text'))
          : el.isContentEditable ? 'textbox'
          : tag
        )).toLowerCase();
    const label = isScrollable
      ? (el.getAttribute('aria-label') || el.getAttribute('title') || tag)
      : getLabel(el);
    const entry = {
      ref,
      role,
      label,
      inView,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
    if (isScrollable) {
      entry.noBadge = true;
      entry.scroll = {
        x: Math.round(el.scrollLeft || 0),
        y: Math.round(el.scrollTop || 0),
        width: Math.round(el.scrollWidth || 0),
        height: Math.round(el.scrollHeight || 0),
        clientWidth: Math.round(el.clientWidth || 0),
        clientHeight: Math.round(el.clientHeight || 0),
      };
    }
    __dsStore.meta.set(ref, { role, label: entry.label });
    if (__dsStore.meta.size > 1000) {
      const oldest = __dsStore.meta.keys().next().value;
      if (oldest !== undefined) __dsStore.meta.delete(oldest);
    }
    if (!isScrollable) {
      if (tag === 'input') {
        if (el.type === 'password') {
          entry.value = el.value ? '[REDACTED]' : '';
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          entry.checked = Boolean(el.checked);
        } else if (el.value) {
          entry.value = String(el.value).slice(0, 120);
        }
        if (el.disabled) entry.disabled = true;
      } else if (tag === 'textarea') {
        if (el.value) entry.value = String(el.value).slice(0, 120);
        if (el.disabled) entry.disabled = true;
      } else if (tag === 'select') {
        entry.value = el.value;
        const allOpts = Array.from(el.options || []);
        const maxOpts = opts.maxSelectOptions;
        let selectedIndices;
        if (allOpts.length <= maxOpts) {
          selectedIndices = allOpts.map((_, i) => i);
        } else {
          const pickedIdx = new Set();
          for (let i = 0; i < Math.min(maxOpts, allOpts.length); i++) pickedIdx.add(i);
          const extraSelected = [];
          for (let i = maxOpts; i < allOpts.length; i++) {
            if (allOpts[i] && allOpts[i].selected) extraSelected.push(i);
          }
          for (const selIdx of extraSelected) {
            if (pickedIdx.size >= maxOpts) {
              for (let j = maxOpts - 1; j >= 0; j--) {
                if (pickedIdx.has(j) && !(allOpts[j] && allOpts[j].selected)) {
                  pickedIdx.delete(j);
                  break;
                }
              }
            }
            pickedIdx.add(selIdx);
          }
          selectedIndices = Array.from(pickedIdx).sort((a, b) => a - b);
          entry.totalOptions = allOpts.length;
        }
        entry.options = selectedIndices.map((idx) => {
          const o = allOpts[idx];
          return {
            value: o.value,
            text: (o.text || '').trim().slice(0, 60),
            selected: Boolean(o.selected),
          };
        });
        if (el.disabled) entry.disabled = true;
      } else if (tag === 'a' && (el.href || el.getAttribute('href'))) {
        entry.href = (el.getAttribute('href') || el.href || '').slice(0, 90);
      } else if (el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
        entry.disabled = true;
      }
      const expanded = el.getAttribute('aria-expanded');
      if (expanded === 'true' || expanded === 'false') entry.expanded = expanded === 'true';
      const checked = el.getAttribute('aria-checked');
      if (checked === 'true' || checked === 'false') entry.checked = checked === 'true';
    }
    return entry;
  });

  let pageText = '';
  let pageTextTotalChars = 0;
  if (opts.includeText && rootNode) {
    const cleanText = (node) =>
      (node.innerText || node.textContent || '')
        .replace(/\\r\\n/g, '\\n')
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
    const parts = [cleanText(rootNode)];
    for (const fb of frameTextBodies) {
      const ft = cleanText(fb);
      if (ft) parts.push(ft);
    }
    const rawText = parts.filter(Boolean).join('\\n\\n');
    pageTextTotalChars = rawText.length;
    pageText = rawText.length > opts.maxTextChars
      ? rawText.slice(0, opts.maxTextChars)
      : rawText;
  }

  const active = __getActiveElement();
  const activeDoc = (active && active.ownerDocument) || document;
  const focused = active && active !== document.body && active !== document.documentElement && active !== activeDoc.body && active !== activeDoc.documentElement
    ? { tag: __tag(active), label: getLabel(active) }
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
    totalInteractiveCount: rawElements.length + scrollableElements.length,
    elements,
    ...(crossOriginIframes.length > 0 ? { iframes: crossOriginIframes } : {}),
    pageText,
    ...(opts.includeText ? { pageTextTotalChars } : {}),
  });
} catch (err) {
  return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`
}

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
  if (p.ref && el.scrollIntoView) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
  const rect = el.getBoundingClientRect();
  const cx = typeof p.x === 'number' && !p.ref ? p.x : Math.round(rect.left + rect.width / 2);
  const cy = typeof p.y === 'number' && !p.ref ? p.y : Math.round(rect.top + rect.height / 2);
  __flashHighlight(el);

  const W = __ownerWin(el);
  const doc = el.ownerDocument || document;
  const PEvent = W.PointerEvent || PointerEvent;
  const MEvent = W.MouseEvent || MouseEvent;
  const btn = p.button === 'right' ? 2 : p.button === 'middle' ? 1 : 0;
  const init = { bubbles: true, cancelable: true, view: W, clientX: cx, clientY: cy, button: btn };
  const anchor = typeof el.closest === 'function'
    ? el.closest('a[href]')
    : (__tag(el) === 'a' ? el : null);
  const anchorHref = anchor ? (anchor.href || anchor.getAttribute('href') || '') : '';
  const anchorTarget = anchor ? (anchor.target || anchor.getAttribute('target') || '').toLowerCase() : '';
  const isSameTabDocLink = (() => {
    if (!anchorHref || anchorTarget === '_blank') return false;
    try {
      const baseHref = (W.location && W.location.href) || location.href;
      const cur = new URL(baseHref);
      const next = new URL(anchorHref, baseHref);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') return false;
      return (cur.origin + cur.pathname + cur.search) !== (next.origin + next.pathname + next.search);
    } catch {
      return false;
    }
  })();
  const submitControl = typeof el.closest === 'function'
    ? el.closest('button, input[type="submit"], input[type="image"]')
    : null;
  const controlType = submitControl ? (submitControl.getAttribute('type') || '').toLowerCase() : '';
  const controlForm = submitControl
    ? ('form' in submitControl && submitControl.form
        ? submitControl.form
        : (typeof submitControl.closest === 'function' ? submitControl.closest('form') : null))
    : null;
  const isFormSubmitControl = Boolean(
    submitControl && controlForm && controlType !== 'button' && controlType !== 'reset'
  );

  el.dispatchEvent(new PEvent('pointerover', init));
  el.dispatchEvent(new MEvent('mouseover', init));
  el.dispatchEvent(new PEvent('pointerdown', init));
  el.dispatchEvent(new MEvent('mousedown', init));
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  el.dispatchEvent(new PEvent('pointerup', init));
  el.dispatchEvent(new MEvent('mouseup', init));

  let clickDefaultPrevented = false;
  let formSubmitTriggered = false;
  const onDocClick = (ev) => { clickDefaultPrevented = Boolean(ev && ev.defaultPrevented); };
  const onDocSubmit = (ev) => { if (ev && !ev.defaultPrevented) formSubmitTriggered = true; };
  const hasDocListen = typeof doc.addEventListener === 'function';
  if (hasDocListen) {
    doc.addEventListener('click', onDocClick, { once: true });
    doc.addEventListener('submit', onDocSubmit, { once: true });
  }
  try {
    if (btn === 2) {
      el.dispatchEvent(new MEvent('contextmenu', init));
    } else if (p.doubleClick) {
      if (typeof el.click === 'function') el.click();
      el.dispatchEvent(new MEvent('dblclick', init));
    } else if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MEvent('click', init));
    }
  } finally {
    if (hasDocListen) {
      doc.removeEventListener('click', onDocClick);
      doc.removeEventListener('submit', onDocSubmit);
    }
  }

  const expectsNavigation = btn === 0 && !p.doubleClick && (
    (isSameTabDocLink && !clickDefaultPrevented) ||
    formSubmitTriggered ||
    (isFormSubmitControl && !clickDefaultPrevented)
  );

  return JSON.stringify({
    ok: true,
    tag: __tag(el),
    text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    href: anchorHref || undefined,
    expectsNavigation,
  });
} catch (err) {
${CATCH_DRIVER_ERROR}
}
`
}

export const buildTypeScript = (params: {
  ref?: string
  x?: number
  y?: number
  text: string
  clear?: boolean
  emitChange?: boolean
}): string => {
  const args = JSON.stringify(params)
  return `
try {
  ${SHARED_HELPERS}
  const p = ${args};
  let el;
  if (p.ref || (typeof p.x === 'number' && typeof p.y === 'number')) {
    el = __resolveTarget(p.ref, p.x, p.y);
  } else {
    const active = __getActiveElement();
    const activeDoc = (active && active.ownerDocument) || document;
    if (active && active !== activeDoc.body && active !== activeDoc.documentElement) {
      el = active;
    } else {
      throw new Error('No ref, coordinates, or active focused element to type into.');
    }
  }
  if (p.ref && el.scrollIntoView) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
  __flashHighlight(el);
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });

  const W = __ownerWin(el);
  const doc = el.ownerDocument || document;
  const IEvent = W.InputEvent || InputEvent;
  const Ev = W.Event || Event;
  const tag = __tag(el);
  const shouldClear = p.clear !== false;
  if (tag === 'input' || tag === 'textarea') {
    const Ctor = tag === 'input' ? (W.HTMLInputElement || HTMLInputElement) : (W.HTMLTextAreaElement || HTMLTextAreaElement);
    const setter = Object.getOwnPropertyDescriptor(Ctor.prototype, 'value')?.set;
    const nextVal = shouldClear ? p.text : ((el.value || '') + p.text);
    if (setter) {
      setter.call(el, nextVal);
    } else {
      el.value = nextVal;
    }
    el.dispatchEvent(new IEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: p.text }));
    if (p.emitChange !== false) {
      el.dispatchEvent(new Ev('change', { bubbles: true }));
    }
  } else if (el.isContentEditable) {
    if (shouldClear) {
      const sel = W.getSelection ? W.getSelection() : window.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    const inserted = doc.execCommand && doc.execCommand('insertText', false, p.text);
    if (!inserted) {
      el.textContent = shouldClear ? p.text : ((el.textContent || '') + p.text);
      el.dispatchEvent(new IEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: p.text }));
    }
  } else {
    throw new Error('Target element <' + tag + '> is not editable.');
  }

  return JSON.stringify({
    ok: true,
    tag,
    length: p.text.length,
  });
} catch (err) {
${CATCH_DRIVER_ERROR}
}
`
}

export const buildPressKeyScript = (params: {
  key: string
  modifiers?: ('meta' | 'ctrl' | 'alt' | 'shift')[]
  fallbackRef?: string
}): string => {
  const args = JSON.stringify(params)
  return `
try {
  ${SHARED_HELPERS}
  const p = ${args};
  const mods = new Set(p.modifiers || []);
  const active = __getActiveElement();
  const activeDoc = (active && active.ownerDocument) || document;
  let target = (active && active !== activeDoc.body && active !== activeDoc.documentElement) ? active : null;
  if (!target && typeof p.fallbackRef === 'string' && p.fallbackRef.trim()) {
    const weak = __dsStore.refs.get(p.fallbackRef.trim().replace(/^@/, ''));
    const candidate = weak ? weak.deref() : null;
    if (candidate && candidate.isConnected) target = candidate;
  }
  if (!target) {
    target = document.body || document.documentElement;
  }
  const W = __ownerWin(target);
  const doc = target.ownerDocument || document;
  const KEvent = W.KeyboardEvent || KeyboardEvent;
  const key = p.key;
  const keyCodeMap = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    ' ': 32, PageDown: 34, PageUp: 33, Home: 36, End: 35,
  };
  const codeMap = {
    ' ': 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Escape',
    Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    PageDown: 'PageDown', PageUp: 'PageUp', Home: 'Home', End: 'End',
  };
  const keyCode = keyCodeMap[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const keyCodeName = codeMap[key] || (
    /^[0-9]$/.test(key) ? 'Digit' + key
    : /^[a-zA-Z]$/.test(key) ? 'Key' + key.toUpperCase()
    : key
  );
  const evInit = {
    key,
    code: keyCodeName,
    keyCode,
    which: keyCode,
    metaKey: mods.has('meta'),
    ctrlKey: mods.has('ctrl'),
    altKey: mods.has('alt'),
    shiftKey: mods.has('shift'),
    bubbles: true,
    cancelable: true,
  };

  const getTabbables = () => {
    const items = [];
    let order = 0;
    const isDisabled = (el) => Boolean(el.disabled) || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    const isNaturallyTabbable = (el) => {
      const tag = __tag(el);
      if (tag === 'a') return el.hasAttribute('href');
      if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
      if (tag === 'input') return (el.type || '').toLowerCase() !== 'hidden';
      return Boolean(el.isContentEditable);
    };
    const walk = (node, depth) => {
      if (!node) return;
      if (__isElement(node)) {
        if (node.getAttribute('data-ds-overlay') === '1') return;
        if (__tag(node) === 'iframe') {
          if (__isVisible(node) && depth < 4) {
            const info = __getFrameDocument(node);
            if (info.doc && info.doc.body) walk(info.doc.body, depth + 1);
          }
          return;
        }
        if (__isHtmlOrSvg(node) && !isDisabled(node) && __isVisible(node)) {
          const rawTab = node.getAttribute('tabindex');
          const parsedTab = rawTab !== null ? Number.parseInt(rawTab, 10) : NaN;
          if (!Number.isNaN(parsedTab)) {
            if (parsedTab >= 0) items.push({ el: node, tabIndex: parsedTab, order: order++ });
          } else if (isNaturallyTabbable(node)) {
            items.push({ el: node, tabIndex: 0, order: order++ });
          }
        }
        if (node.shadowRoot) {
          for (const child of node.shadowRoot.children) walk(child, depth);
        }
      }
      for (const child of node.children || []) walk(child, depth);
    };
    walk(document.body || document.documentElement, 0);
    items.sort((a, b) => {
      const aPos = a.tabIndex > 0 ? a.tabIndex : Number.MAX_SAFE_INTEGER;
      const bPos = b.tabIndex > 0 ? b.tabIndex : Number.MAX_SAFE_INTEGER;
      if (aPos !== bPos) return aPos - bPos;
      return a.order - b.order;
    });
    return items.map((item) => item.el);
  };

  let formSubmitTriggered = false;
  let directFormSubmit = false;
  let fallbackFormSubmit = false;
  let clickDefaultPrevented = false;
  let activatedNavLink = false;
  let activatedSubmitControl = false;
  const onDocSubmit = (ev) => { if (ev && !ev.defaultPrevented) formSubmitTriggered = true; };
  const onDocClick = (ev) => { clickDefaultPrevented = Boolean(ev && ev.defaultPrevented); };
  const hasDocListen = typeof doc.addEventListener === 'function';
  if (hasDocListen) {
    doc.addEventListener('submit', onDocSubmit, { once: true });
    doc.addEventListener('click', onDocClick, { once: true });
  }
  const triggerControlClick = (el) => {
    const anchor = typeof el.closest === 'function' ? el.closest('a[href]') : (__tag(el) === 'a' ? el : null);
    const anchorHref = anchor ? (anchor.href || anchor.getAttribute('href') || '') : '';
    const anchorTarget = anchor ? (anchor.target || anchor.getAttribute('target') || '').toLowerCase() : '';
    if (anchorHref && anchorTarget !== '_blank') {
      try {
        const baseHref = (W.location && W.location.href) || location.href;
        const cur = new URL(baseHref);
        const next = new URL(anchorHref, baseHref);
        if ((next.protocol === 'http:' || next.protocol === 'https:') &&
            (cur.origin + cur.pathname + cur.search) !== (next.origin + next.pathname + next.search)) {
          activatedNavLink = true;
        }
      } catch {}
    }
    const submitControl = typeof el.closest === 'function'
      ? el.closest('button, input[type="submit"], input[type="image"]')
      : null;
    const controlType = submitControl ? (submitControl.getAttribute('type') || '').toLowerCase() : '';
    const controlForm = submitControl
      ? ('form' in submitControl && submitControl.form
          ? submitControl.form
          : (typeof submitControl.closest === 'function' ? submitControl.closest('form') : null))
      : null;
    if (submitControl && controlForm && controlType !== 'button' && controlType !== 'reset') {
      activatedSubmitControl = true;
    }
    if (typeof el.click === 'function') {
      el.click();
    }
  };
  try {
    const notPrevented = target.dispatchEvent(new KEvent('keydown', evInit));
    target.dispatchEvent(new KEvent('keypress', evInit));
    target.dispatchEvent(new KEvent('keyup', evInit));

    const noCommandMod = !evInit.metaKey && !evInit.ctrlKey && !evInit.altKey;
    const tag = __tag(target);
    const role = (typeof target.getAttribute === 'function' ? (target.getAttribute('role') || '') : '').toLowerCase();
    const isDocTarget = target === doc.body || target === doc.documentElement || target === document.body || target === document.documentElement;

    if (notPrevented && noCommandMod) {
      if (key === 'Tab') {
        const tabbables = getTabbables();
        if (tabbables.length > 0) {
          const idx = tabbables.indexOf(target);
          let nextIdx;
          if (evInit.shiftKey) {
            nextIdx = idx <= 0 ? tabbables.length - 1 : idx - 1;
          } else {
            nextIdx = idx < 0 || idx >= tabbables.length - 1 ? 0 : idx + 1;
          }
          const nextEl = tabbables[nextIdx];
          if (nextEl && typeof nextEl.focus === 'function') {
            nextEl.focus();
          }
        }
      } else if (key === 'Enter') {
        if (tag === 'input' && target.form) {
          fallbackFormSubmit = true;
          if (typeof target.form.requestSubmit === 'function') {
            target.form.requestSubmit();
          } else {
            directFormSubmit = true;
            target.form.submit();
          }
        } else if (
          tag === 'button' ||
          (tag === 'a' && target.hasAttribute('href')) ||
          tag === 'summary' ||
          ['button', 'link', 'menuitem', 'tab', 'option', 'switch', 'checkbox', 'radio'].includes(role)
        ) {
          triggerControlClick(target);
        }
      } else if (key === ' ') {
        if (isDocTarget) {
          const delta = Math.round((W.innerHeight || window.innerHeight) * 0.8);
          W.scrollBy({ top: evInit.shiftKey ? -delta : delta, behavior: 'instant' });
        } else if (
          tag === 'button' ||
          tag === 'summary' ||
          (tag === 'input' && ['checkbox', 'radio', 'button', 'submit', 'reset'].includes((target.type || '').toLowerCase())) ||
          ['button', 'checkbox', 'radio', 'switch', 'tab'].includes(role)
        ) {
          triggerControlClick(target);
        }
      } else if (key === 'Home' && isDocTarget) {
        W.scrollTo({ top: 0, behavior: 'instant' });
      } else if (key === 'End' && isDocTarget) {
        W.scrollTo({ top: doc.documentElement.scrollHeight, behavior: 'instant' });
      } else if (key === 'PageDown') {
        W.scrollBy({ top: Math.round((W.innerHeight || window.innerHeight) * 0.85), behavior: 'instant' });
      } else if (key === 'PageUp') {
        W.scrollBy({ top: -Math.round((W.innerHeight || window.innerHeight) * 0.85), behavior: 'instant' });
      } else if (key === 'ArrowDown' && isDocTarget) {
        W.scrollBy({ top: 120, behavior: 'instant' });
      } else if (key === 'ArrowUp' && isDocTarget) {
        W.scrollBy({ top: -120, behavior: 'instant' });
      }
    }
  } finally {
    if (hasDocListen) {
      doc.removeEventListener('submit', onDocSubmit);
      doc.removeEventListener('click', onDocClick);
    }
  }

  const expectsNavigation =
    formSubmitTriggered ||
    directFormSubmit ||
    (!hasDocListen && fallbackFormSubmit) ||
    (activatedNavLink && !clickDefaultPrevented) ||
    (activatedSubmitControl && !clickDefaultPrevented);
  return JSON.stringify({ ok: true, key, expectsNavigation });
} catch (err) {
${CATCH_DRIVER_ERROR}
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
  const horizontal = p.direction === 'left' || p.direction === 'right';
  if (container) {
    const baseAxis = horizontal
      ? (container.clientWidth || window.innerWidth)
      : (container.clientHeight || window.innerHeight);
    const dist = typeof p.amount === 'number' && p.amount > 0 ? p.amount : Math.round(baseAxis * 0.75);
    if (p.to === 'top') container.scrollTop = 0;
    else if (p.to === 'bottom') container.scrollTop = container.scrollHeight;
    else if (p.direction === 'up') container.scrollTop = Math.max(0, (container.scrollTop || 0) - dist);
    else if (p.direction === 'left') container.scrollLeft = Math.max(0, (container.scrollLeft || 0) - dist);
    else if (p.direction === 'right') container.scrollLeft = (container.scrollLeft || 0) + dist;
    else container.scrollTop = (container.scrollTop || 0) + dist;
    return JSON.stringify({
      ok: true,
      isContainer: true,
      scrollX: Math.round(container.scrollLeft || 0),
      scrollY: Math.round(container.scrollTop || 0),
      scrollWidth: Math.round(container.scrollWidth || 0),
      scrollHeight: Math.round(container.scrollHeight || 0),
      clientWidth: Math.round(container.clientWidth || 0),
      clientHeight: Math.round(container.clientHeight || 0),
    });
  }
  const baseAxis = horizontal ? window.innerWidth : window.innerHeight;
  const dist = typeof p.amount === 'number' && p.amount > 0 ? p.amount : Math.round(baseAxis * 0.75);
  if (p.to === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
  else if (p.to === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  else if (p.direction === 'up') window.scrollBy({ top: -dist, behavior: 'instant' });
  else if (p.direction === 'left') window.scrollBy({ left: -dist, behavior: 'instant' });
  else if (p.direction === 'right') window.scrollBy({ left: dist, behavior: 'instant' });
  else window.scrollBy({ top: dist, behavior: 'instant' });

  return JSON.stringify({
    ok: true,
    isContainer: false,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    scrollWidth: Math.round(document.documentElement.scrollWidth),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
  });
} catch (err) {
${CATCH_DRIVER_ERROR}
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
  if (__tag(el) !== 'select') {
    throw new Error('Target element <' + __tag(el) + '> is not a <select>.');
  }
  __flashHighlight(el);
  const W = __ownerWin(el);
  const Ev = W.Event || Event;
  const wanted = new Set((p.values || []).map(String));
  let matched = 0;
  let firstMatchedOpt = null;
  for (const opt of el.options || []) {
    const match = wanted.has(opt.value) || wanted.has((opt.text || '').trim());
    if (el.multiple) {
      opt.selected = match;
      if (match) matched++;
    } else if (match && matched === 0) {
      firstMatchedOpt = opt;
      matched++;
    }
  }
  if (matched === 0) {
    throw new Error('No matching <option> found for values: ' + JSON.stringify(p.values));
  }
  if (!el.multiple && firstMatchedOpt) {
    const SelectCtor = W.HTMLSelectElement || HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(SelectCtor.prototype, 'value')?.set;
    if (setter) {
      setter.call(el, firstMatchedOpt.value);
      if (!firstMatchedOpt.selected) {
        firstMatchedOpt.selected = true;
      }
    } else {
      firstMatchedOpt.selected = true;
    }
  }
  el.dispatchEvent(new Ev('input', { bubbles: true }));
  el.dispatchEvent(new Ev('change', { bubbles: true }));
  return JSON.stringify({ ok: true, value: el.value, matched });
} catch (err) {
${CATCH_DRIVER_ERROR}
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
    let foundText = (document.body?.innerText || document.body?.textContent || '').includes(p.text);
    if (!foundText && document.body) {
      const frameBodies = __collectSameOriginFrameBodies(document.body);
      for (const fb of frameBodies) {
        if ((fb.innerText || fb.textContent || '').includes(p.text)) {
          foundText = true;
          break;
        }
      }
    }
    if (!foundText) matched = false;
  }
  return JSON.stringify({ ok: true, matched, url: location.href });
} catch (err) {
  return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
`
}

const STATEMENT_KEYWORDS = new Set([
  'return',
  'throw',
  'const',
  'let',
  'var',
  'for',
  'while',
  'do',
  'if',
  'try',
  'switch',
  'debugger',
])

/**
 * Pure, CSP-safe scanner that decides whether a user script is a statement body (e.g. `const x = 1;
 * return x;`) vs. a single expression (e.g. `({\n a: 1\n})`, `(() => { ... })()`, `"if;a".split(";")`).
 */
const looksLikeStatementBody = (script: string): boolean => {
  const trimmed = script.trim()
  if (!trimmed) {
    return true
  }
  // Ignore one optional trailing semicolon so `document.title;` stays an expression.
  const end = trimmed.endsWith(';') ? trimmed.length - 1 : trimmed.length
  let depth = 0
  let i = 0
  let prevNonSpace = ''

  while (i < end) {
    const ch = trimmed[i]
    const next = i + 1 < end ? trimmed[i + 1] : ''

    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }
    // Line comment
    if (ch === '/' && next === '/') {
      i += 2
      while (i < end && trimmed[i] !== '\n') {
        i += 1
      }
      continue
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2
      while (i + 1 < end && !(trimmed[i] === '*' && trimmed[i + 1] === '/')) {
        i += 1
      }
      i += 2
      continue
    }
    // String or template literal
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < end) {
        if (trimmed[i] === '\\') {
          i += 2
          continue
        }
        if (trimmed[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      prevNonSpace = quote
      continue
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      // Bare `{ ... }` at start of script is treated as a statement block unless wrapped in `({...})`.
      if (depth === 0 && ch === '{' && prevNonSpace === '') {
        return true
      }
      depth += 1
      prevNonSpace = ch
      i += 1
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1)
      prevNonSpace = ch
      i += 1
      continue
    }

    if (depth === 0) {
      if (ch === ';') {
        return true
      }
      if (/[A-Za-z_$]/.test(ch)) {
        const start = i
        i += 1
        while (i < end && /[A-Za-z0-9_$]/.test(trimmed[i])) {
          i += 1
        }
        const word = trimmed.slice(start, i)
        if (prevNonSpace !== '.' && STATEMENT_KEYWORDS.has(word)) {
          return true
        }
        if (prevNonSpace === '' && (word === 'function' || word === 'class')) {
          return true
        }
        prevNonSpace = 'id'
        continue
      }
    }

    prevNonSpace = ch
    i += 1
  }

  return false
}

export const buildPageEvalScript = (userScript: string): string => {
  const trimmed = userScript.trim()
  const expr = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed
  const body = looksLikeStatementBody(trimmed) ? userScript : `return (${expr});`
  return `
try {
  const __res = await (async () => {
${body}
  })();
  const __seen = new WeakSet();
  const __safeStringify = (payload) => JSON.stringify(payload, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Set) return Array.from(v);
    if (v instanceof Map) return Array.from(v.entries());
    if (v instanceof Error) return { name: v.name, message: v.message };
    if (typeof Element !== 'undefined' && v instanceof Element) {
      const id = v.id ? '#' + v.id : '';
      return '<' + v.tagName.toLowerCase() + id + '>';
    }
    if (v && typeof v === 'object') {
      if (__seen.has(v)) return '[Circular]';
      __seen.add(v);
    }
    return v;
  });
  return __safeStringify({ ok: true, value: __res === undefined ? null : __res });
} catch (err) {
  return JSON.stringify({
    ok: false,
    error: err instanceof Error ? (err.stack || err.message) : String(err),
  });
}
`
}
