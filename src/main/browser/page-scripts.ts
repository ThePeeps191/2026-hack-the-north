import type { BrowserObservation } from '../contracts.ts'
import { asArray, asNumber, asRecord, asString } from './narrow.ts'

/**
 * The page-side half of observation and drawing.
 *
 * These scripts are strings, not functions, on purpose: the main process has no
 * DOM types, and a string is exactly what `page.evaluate` accepts. They run in
 * the remote page and return plain JSON. Nothing here touches Huddle, the local
 * filesystem or any credential — the page only ever sees its own DOM.
 */

export interface ObservedElement {
  ref: string
  role: string
  name: string
  selector: string
}

export interface RawObservation {
  url: string
  title: string
  text: string
  elements: ObservedElement[]
  interactiveCount: number
  elementCount: number
  /** Frames on the page. A cross-origin frame's contents are not readable from here. */
  iframeCount: number
}

const MAX_ELEMENTS = 80
const MAX_NAME_CHARS = 90

/**
 * Interactive elements plus a trimmed text summary of the real page.
 *
 * `ref` is `e1..eN` in DOM order; the matching CSS `selector` is the durable
 * handle and is checked against the live DOM before it is returned (a selector
 * that matches more than one node is extended until it matches exactly one).
 */
export const OBSERVE_SCRIPT = String.raw`
(() => {
  var MAX_ELEMENTS = ${String(MAX_ELEMENTS)};
  var MAX_NAME = ${String(MAX_NAME_CHARS)};
  var INTERACTIVE = 'a[href],button,input,select,textarea,summary,canvas,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="switch"],[role="radio"],[role="menuitem"],[role="option"],[role="textbox"],[contenteditable="true"]';

  var unique = function (candidate) {
    try {
      return document.querySelectorAll(candidate).length === 1;
    } catch (error) {
      return false;
    }
  };

  var selectorFor = function (element) {
    var id = element.getAttribute('id');
    if (id && window.CSS && typeof window.CSS.escape === 'function') {
      var byId = '#' + window.CSS.escape(id);
      if (unique(byId)) return byId;
    }
    var testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id');
    if (testId) {
      var scoped = element.tagName.toLowerCase() + '[data-testid="' + testId + '"]';
      if (unique(scoped)) return scoped;
      var global = '[data-testid="' + testId + '"]';
      if (unique(global)) return global;
    }
    var name = element.getAttribute('name');
    if (name) {
      var byName = element.tagName.toLowerCase() + '[name="' + name + '"]';
      if (unique(byName)) return byName;
    }
    var parts = [];
    var node = element;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 7) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      var sameTag = [];
      for (var index = 0; index < parent.children.length; index += 1) {
        if (parent.children[index].tagName === node.tagName) sameTag.push(parent.children[index]);
      }
      var position = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + position + ')' : tag);
      var candidate = parts.join(' > ');
      if (unique(candidate)) return candidate;
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  };

  var isVisible = function (element) {
    var rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    if (typeof element.checkVisibility === 'function') {
      try {
        return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch (error) {
        return true;
      }
    }
    return true;
  };

  var roleFor = function (element) {
    var explicit = element.getAttribute('role');
    if (explicit) return explicit;
    var tag = element.tagName.toLowerCase();
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'canvas') return 'canvas';
    if (tag === 'input') {
      var type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      return 'textbox';
    }
    return tag;
  };

  var nameFor = function (element) {
    var label = element.getAttribute('aria-label');
    if (label) return label;
    var placeholder = element.getAttribute('placeholder');
    if (placeholder) return placeholder;
    var title = element.getAttribute('title');
    if (title) return title;
    var value = '';
    if (element.tagName === 'INPUT' && typeof element.value === 'string' && element.value.length > 0) {
      value = element.value;
    }
    var text = value.length > 0 ? value : element.innerText || element.textContent || '';
    return text.replace(/\s+/g, ' ').trim();
  };

  var nodes = document.querySelectorAll(INTERACTIVE);
  var elements = [];
  var visibleCount = 0;
  for (var index = 0; index < nodes.length; index += 1) {
    var element = nodes[index];
    if (!isVisible(element)) continue;
    visibleCount += 1;
    if (elements.length >= MAX_ELEMENTS) continue;
    elements.push({
      ref: 'e' + (elements.length + 1),
      role: roleFor(element),
      name: nameFor(element).slice(0, MAX_NAME),
      selector: selectorFor(element)
    });
  }

  var bodyText = document.body ? document.body.innerText || '' : '';
  return {
    url: location.href,
    title: document.title,
    text: bodyText
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    elements: elements,
    interactiveCount: visibleCount,
    elementCount: document.querySelectorAll('*').length,
    iframeCount: document.querySelectorAll('iframe').length
  };
})()
`

/** Real viewport metrics from the page itself, used when Playwright has none. */
export const METRICS_SCRIPT = String.raw`
(() => ({
  width: window.innerWidth,
  height: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio,
  scrollWidth: document.documentElement ? document.documentElement.scrollWidth : 0,
  scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0
}))()
`

export const TUNNEL_BYPASS_HEADER = { 'bypass-tunnel-reminder': 'true' } as const

export interface PageTextSnapshot {
  title: string
  text: string
  markup: string
}

/** Public localtunnel hostnames the remote browser actually has to open. */
export function looksLikeTunnelUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'loca.lt' || host.endsWith('.loca.lt') || host === 'localtunnel.me' || host.endsWith('.localtunnel.me')
  } catch {
    return false
  }
}

/**
 * True when the page is a tunnel's own reminder, not the project's app.
 * Covers both the older "tunnel password" page and the current
 * "Tunnel website ahead!" interstitial.
 */
export function isTunnelReminderPage(snapshot: PageTextSnapshot): boolean {
  const title = snapshot.title.toLowerCase()
  const text = snapshot.text.toLowerCase()
  const markup = snapshot.markup.toLowerCase()
  return (
    title.includes('localtunnel') ||
    title.includes('tunnel website ahead') ||
    text.includes('tunnel password') ||
    text.includes('reminder page') ||
    text.includes('tunnel website ahead') ||
    text.includes('served via a tunnel') ||
    text.includes('served via a localtunnel') ||
    markup.includes('bypass-tunnel-reminder')
  )
}

/** Vite 6+ refuses unknown Host headers with this page instead of the app. */
export function isViteBlockedHostPage(snapshot: PageTextSnapshot): boolean {
  const text = snapshot.text.toLowerCase()
  return text.includes('blocked request') && text.includes('allowedhosts')
}

/** Labels on the interstitial's continue control, not app buttons. */
export function tunnelContinueLabel(label: string): boolean {
  const text = label.trim().toLowerCase()
  return (
    text === 'continue' ||
    text === 'proceed' ||
    text === 'visit site' ||
    text === 'continue to site' ||
    text.includes('click continue')
  )
}

/**
 * True when the page the remote browser landed on is a tunnel's own reminder
 * page rather than the project's app. localtunnel answers a plain browser with a
 * reminder unless the request carries `bypass-tunnel-reminder`, so Huddle checks
 * for the real signature instead of assuming the preview loaded.
 */
export const TUNNEL_REMINDER_SCRIPT = String.raw`
(() => {
  var title = (document.title || '').toLowerCase();
  var text = (document.body ? document.body.innerText || '' : '').toLowerCase();
  var markup = document.documentElement ? document.documentElement.innerHTML.slice(0, 6000).toLowerCase() : '';
  return (
    title.indexOf('localtunnel') >= 0 ||
    title.indexOf('tunnel website ahead') >= 0 ||
    text.indexOf('tunnel password') >= 0 ||
    text.indexOf('reminder page') >= 0 ||
    text.indexOf('tunnel website ahead') >= 0 ||
    text.indexOf('served via a tunnel') >= 0 ||
    text.indexOf('served via a localtunnel') >= 0 ||
    markup.indexOf('bypass-tunnel-reminder') >= 0
  );
})()
`

export const VITE_BLOCKED_HOST_SCRIPT = String.raw`
(() => {
  var text = (document.body ? document.body.innerText || '' : '').toLowerCase();
  return text.indexOf('blocked request') >= 0 && text.indexOf('allowedhosts') >= 0;
})()
`

/**
 * Arms the target element with real event counters and reports whether a
 * pointer at its centre would actually land on it. A canvas under an overlay
 * gets a refusal instead of a silent no-op.
 */
export function drawInstrumentScript(selector: string): string {
  return `(() => {
  var selector = ${JSON.stringify(selector)};
  var el = document.querySelector(selector);
  if (!el) return { found: false };
  var rect = el.getBoundingClientRect();
  var listeners = window.__huddleDrawListeners || [];
  for (var index = 0; index < listeners.length; index += 1) {
    document.removeEventListener(listeners[index][0], listeners[index][1], true);
  }
  var counts = { down: 0, move: 0, up: 0, mouseDown: 0, mouseMove: 0, mouseUp: 0, targetTag: '' };
  window.__huddleDrawCounts = counts;
  var inside = function (event) {
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  };
  var note = function (event) {
    if (!inside(event)) return false;
    counts.targetTag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
    return true;
  };
  var add = function (type, counter) {
    var listener = function (event) {
      if (note(event)) counter();
    };
    document.addEventListener(type, listener, true);
    listeners.push([type, listener]);
  };
  add('pointerdown', function () { counts.down += 1; });
  add('pointermove', function () { counts.move += 1; });
  add('pointerup', function () { counts.up += 1; });
  add('mousedown', function () { counts.mouseDown += 1; });
  add('mousemove', function () { counts.mouseMove += 1; });
  add('mouseup', function () { counts.mouseUp += 1; });
  window.__huddleDrawListeners = listeners;
  var top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    topTag: top ? top.tagName.toLowerCase() : '',
    topIsTarget: top === el,
    topContainsTarget: top ? top.contains(el) : false,
    offscreen: rect.width < 1 || rect.height < 1
  };
})()`
}

/** Real event counts that reached the element during the strokes. */
export const DRAW_COUNTERS_SCRIPT = String.raw`
(() => {
  var counts = window.__huddleDrawCounts || null;
  return counts
    ? {
        down: counts.down,
        move: counts.move,
        up: counts.up,
        mouseDown: counts.mouseDown,
        mouseMove: counts.mouseMove,
        mouseUp: counts.mouseUp,
        targetTag: counts.targetTag
      }
    : { down: -1, move: -1, up: -1, mouseDown: -1, mouseMove: -1, mouseUp: -1, targetTag: '' };
})()
`

/**
 * A sampled read of a canvas' own pixels, taken before and after the strokes.
 * If the app paints on a different canvas than the one we stroked, the delta is
 * zero and the caller says so instead of claiming a drawing.
 */
export function canvasStatsScript(selector: string): string {
  return `(() => {
  var selector = ${JSON.stringify(selector)};
  var el = document.querySelector(selector);
  if (!el) return { canvas: false, readable: false, sampled: 0, painted: 0, checksum: 0, note: 'element not found' };
  if (el.tagName.toLowerCase() !== 'canvas') {
    return { canvas: false, readable: false, sampled: 0, painted: 0, checksum: 0, note: 'element is a ' + el.tagName.toLowerCase() };
  }
  var ctx = el.getContext('2d');
  if (!ctx) {
    return { canvas: true, readable: false, sampled: 0, painted: 0, checksum: 0, note: 'no 2d context' };
  }
  try {
    var width = Math.max(1, el.width);
    var height = Math.max(1, el.height);
    var data = ctx.getImageData(0, 0, width, height).data;
    var painted = 0;
    var sampled = 0;
    var checksum = 0;
    for (var index = 3; index < data.length; index += 16) {
      sampled += 1;
      if (data[index] > 8) painted += 1;
      checksum = (checksum + data[index - 3] * 3 + data[index] * 5) % 1000000007;
    }
    return {
      canvas: true,
      readable: true,
      sampled: sampled,
      painted: painted,
      checksum: checksum,
      width: width,
      height: height,
      note: ''
    };
  } catch (error) {
    return {
      canvas: true,
      readable: false,
      sampled: 0,
      painted: 0,
      checksum: 0,
      note: 'pixels could not be read: ' + (error && error.message ? error.message : String(error))
    };
  }
})()`
}

export function readObservation(value: unknown): RawObservation {
  const record = asRecord(value)
  const elements: ObservedElement[] = []
  for (const item of asArray(record?.elements)) {
    const element = asRecord(item)
    if (element === null) continue
    const selector = asString(element.selector)
    if (selector.length === 0) continue
    elements.push({
      ref: asString(element.ref, `e${String(elements.length + 1)}`),
      role: asString(element.role, 'generic'),
      name: asString(element.name),
      selector
    })
  }
  return {
    url: asString(record?.url),
    title: asString(record?.title),
    text: asString(record?.text),
    elements,
    interactiveCount: asNumber(record?.interactiveCount) ?? elements.length,
    elementCount: asNumber(record?.elementCount) ?? 0,
    iframeCount: asNumber(record?.iframeCount) ?? 0
  }
}

export interface DrawProbe {
  found: boolean
  tag: string
  width: number
  height: number
  topTag: string
  topIsTarget: boolean
  topContainsTarget: boolean
  offscreen: boolean
}

export function readDrawProbe(value: unknown): DrawProbe {
  const record = asRecord(value)
  return {
    found: record?.found === true,
    tag: asString(record?.tag),
    width: asNumber(record?.width) ?? 0,
    height: asNumber(record?.height) ?? 0,
    topTag: asString(record?.topTag),
    topIsTarget: record?.topIsTarget === true,
    topContainsTarget: record?.topContainsTarget === true,
    offscreen: record?.offscreen === true
  }
}

export interface DrawCounters {
  down: number
  move: number
  up: number
  mouseDown: number
  mouseMove: number
  mouseUp: number
  targetTag: string
}

export function readDrawCounters(value: unknown): DrawCounters {
  const record = asRecord(value)
  return {
    down: asNumber(record?.down) ?? -1,
    move: asNumber(record?.move) ?? -1,
    up: asNumber(record?.up) ?? -1,
    mouseDown: asNumber(record?.mouseDown) ?? -1,
    mouseMove: asNumber(record?.mouseMove) ?? -1,
    mouseUp: asNumber(record?.mouseUp) ?? -1,
    targetTag: asString(record?.targetTag)
  }
}

export interface CanvasStats {
  canvas: boolean
  readable: boolean
  sampled: number
  painted: number
  /** Sampled pixel checksum, so a white-on-white stroke is still detected. */
  checksum: number
  note: string
}

export function readCanvasStats(value: unknown): CanvasStats {
  const record = asRecord(value)
  return {
    canvas: record?.canvas === true,
    readable: record?.readable === true,
    sampled: asNumber(record?.sampled) ?? 0,
    painted: asNumber(record?.painted) ?? 0,
    checksum: asNumber(record?.checksum) ?? 0,
    note: asString(record?.note)
  }
}

export interface ViewportSize {
  width: number
  height: number
}

export function readViewport(value: unknown): ViewportSize | null {
  const record = asRecord(value)
  const width = asNumber(record?.width)
  const height = asNumber(record?.height)
  if (width === null || height === null || width < 1 || height < 1) return null
  return { width: Math.round(width), height: Math.round(height) }
}

/** Real PNG pixel dimensions straight out of the IHDR chunk. */
export function pngSize(bytes: Buffer): ViewportSize | null {
  if (bytes.byteLength < 24) return null
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1) return null
  return { width, height }
}

export interface StrokePoint {
  x: number
  y: number
}

export interface PlannedStroke {
  start: StrokePoint
  points: StrokePoint[]
}

/**
 * Deterministic stroke plans inside the element's box: a wavy line per stroke,
 * spread down the box. Points are CSS pixels relative to the viewport, which is
 * what Playwright's mouse API takes.
 */
export function planStrokes(
  box: { x: number; y: number; width: number; height: number },
  strokes: number
): PlannedStroke[] {
  const total = Math.max(1, Math.min(12, Math.trunc(strokes)))
  const plans: PlannedStroke[] = []
  const steps = 18
  for (let index = 0; index < total; index += 1) {
    const share = total === 1 ? 0.5 : index / (total - 1)
    const baseY = box.y + box.height * (0.18 + 0.64 * share)
    const startX = box.x + box.width * 0.12
    const endX = box.x + box.width * 0.88
    const points: StrokePoint[] = []
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps
      points.push({
        x: startX + (endX - startX) * progress,
        y: baseY + Math.sin(progress * Math.PI * 2 + index) * box.height * 0.06
      })
    }
    plans.push({ start: { x: startX, y: baseY }, points })
  }
  return plans
}

export function trimText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[trimmed at ${String(max)} of ${String(text.length)} characters]`
}

/** The one `text` field the observation contract has: real text plus real roles. */
export function summarizeObservation(
  observation: RawObservation,
  accessibility: string,
  maxChars: number
): string {
  const parts: string[] = []
  const visible = trimText(observation.text, 2400)
  parts.push(visible.length > 0 ? visible : '(the page rendered no visible text)')
  if (accessibility.trim().length > 0) {
    parts.push(`--- accessibility tree from the remote page ---\n${trimText(accessibility.trim(), 1400)}`)
  }
  parts.push(
    `${observation.elements.length} interactive element(s) listed of ${observation.interactiveCount} visible; ` +
      `${observation.elementCount} element(s) in the document.`
  )
  if (observation.iframeCount > 0) {
    parts.push(
      `${observation.iframeCount} iframe(s) are present. A cross-origin frame's DOM is not readable from here, ` +
        'so anything inside one has to be checked by driving it or by reading the network instead.'
    )
  }
  return trimText(parts.join('\n'), maxChars)
}

/** Strip the observation scripts' extra fields down to the contract shape. */
export function toObservation(
  observation: RawObservation,
  fallbackUrl: string,
  text: string
): BrowserObservation {
  return {
    url: observation.url.length > 0 ? observation.url : fallbackUrl,
    title: observation.title,
    text,
    elements: observation.elements.map((element) => ({
      ref: element.ref,
      role: element.role,
      name: element.name,
      selector: element.selector
    }))
  }
}
