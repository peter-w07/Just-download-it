/*
 * Just download it: "Just download web page".
 *
 * Right-click ▸ Just download web page ▸ As an image (PNG) / As a GIF:
 *  - An element selector. Hovering highlights the element under the cursor,
 *    the mouse wheel or ↑/↓ picks a bigger or smaller part, a click selects
 *    it, Esc cancels. The top bar switches between PNG and GIF and has
 *    "Visible area" and "Whole page" shortcuts.
 *  - PNG: the element as it looks on screen, cut from screenshots of the tab
 *    (tabs.captureVisibleTab in the service worker). Anything taller than
 *    the window is scrolled through and stitched together, with fixed and
 *    sticky bars hidden after the first screenshot so they don't repeat.
 *    Chrome allows two screenshots a second and shows the whole tab; Firefox
 *    has no limit and is asked for exactly the viewport (no scrollbars), and
 *    the service worker's answer says which it was.
 *  - GIF: records a fixed box on screen (the element's place when it was
 *    picked) while the user scrolls or clicks around. The tab is recorded
 *    and encoded by the job runner (offscreen/recorder.js: Chrome streams
 *    the tab, Firefox takes screenshots in a loop); the service worker saves
 *    the file like any other job. The controls are the same either way.
 *
 * Only runs in the top frame. The UI lives in a closed shadow root, and all
 * page-derived text goes through textContent.
 *
 * The bar, the highlight and the recording pill wear the site's own look:
 * content/themes.js hands us the surface, text, hover, accent and menu metrics
 * of whatever site we're on, and they are written as custom properties on the
 * stage. Everything falls back to the neutral light/dark look below, so a
 * missing themes.js (or an unsupported site) still looks like it always did.
 * Whatever the site's colours are, the parts drawn over the page keep a light
 * and a dark hairline so they stay visible on any background.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});

  // An older copy from before an extension update: unhook it.
  if (JDI.capture && typeof JDI.capture.teardown === 'function') {
    try {
      JDI.capture.teardown();
    } catch {
      /* its extension context is gone */
    }
  }

  let isTop = false;
  try {
    isTop = window.top === window;
  } catch {
    isTop = false;
  }
  if (!isTop) {
    JDI.capture = { start() {}, teardown() {} };
    return;
  }

  const HOST_TAG = 'jdi-capture';
  const TOAST_HOST_TAG = 'jdi-root'; // picker.js
  const MAX_GIF_SECONDS = 60;
  // Chrome allows two screenshots per second. The service worker's answer
  // may say otherwise (Firefox has no limit).
  const SHOT_GAP_MS = 560;
  // Chrome's canvas limits are 32767 px per side and 268 million pixels; stay
  // well under the area so encoding the PNG doesn't take forever.
  const MAX_CANVAS_SIDE = 32767;
  const MAX_CANVAS_AREA = 120 * 1000 * 1000;
  const RIGHT_CLICK_MAX_AGE_MS = 60 * 1000;

  // The defaults are the neutral look; applyTheme() writes the site's own
  // values over them as inline custom properties on .stage. A token may itself
  // be a site variable (var(--yt-sys-color-baseline--menu-background, #282828)):
  // custom properties inherit through the shadow boundary, so those resolve.
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .stage {
      --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --fs: 13px; --weight: 550; --title-weight: 600;
      --radius: 12px; --btn-radius: 8px; --item-h: 30px;
      --bg: #ffffff; --fg: #16181d; --muted: #646b78; --line: #e6e8ec;
      --hover: rgba(15, 20, 30, .06); --pressed: rgba(15, 20, 30, .13);
      --accent: #2f6bff; --accent-fg: #ffffff; --focus: #2f6bff;
      --mark: #2f6bff; --mark-fg: #ffffff; --rec: #e5484d;
      --ring: rgba(15, 20, 30, .16);
      --shadow: 0 12px 32px rgba(15, 20, 30, .18), 0 2px 6px rgba(15, 20, 30, .08);
      position: fixed; inset: 0; width: auto; height: auto; max-width: none; max-height: none;
      margin: 0; padding: 0; border: 0; background: transparent; overflow: hidden;
      pointer-events: none; color: var(--fg);
      font-family: var(--font); font-size: var(--fs); font-weight: 400; line-height: 1.35;
      font-style: normal; letter-spacing: normal; text-transform: none;
      -webkit-font-smoothing: antialiased;
    }
    .stage[data-theme="dark"] {
      --bg: #1c1f26; --fg: #eef0f4; --muted: #9aa2b1; --line: #2e333d;
      --hover: rgba(255, 255, 255, .1); --pressed: rgba(255, 255, 255, .19);
      --accent: #5b8cff; --accent-fg: #0b0d12; --focus: #5b8cff;
      --mark: #5b8cff; --mark-fg: #0b0d12; --rec: #ff6b73;
      --ring: rgba(255, 255, 255, .18);
      --shadow: 0 12px 32px rgba(0, 0, 0, .5), 0 2px 6px rgba(0, 0, 0, .3);
    }
    button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
    button[disabled] { opacity: .55; cursor: default; }
    /* Reads a colour token back once it has been substituted (see readColor). */
    .probe { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: hidden; opacity: 0; pointer-events: none; }

    /* Drawn over the page: a light and a dark hairline keep the edges visible
       whatever is underneath. */
    .box {
      position: absolute; left: 0; top: 0; border: 2px solid var(--mark); border-radius: 4px;
      background: color-mix(in srgb, var(--mark) 14%, transparent);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, .75), inset 0 0 0 1px rgba(0, 0, 0, .35);
    }
    .label {
      position: absolute; left: 0; top: 0; max-width: min(460px, calc(100vw - 8px));
      padding: 3px 8px; border-radius: min(8px, var(--radius)); background: var(--mark); color: var(--mark-fg);
      font-size: max(11px, calc(var(--fs) - 1px)); font-weight: var(--title-weight);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .35), 0 0 0 1px rgba(255, 255, 255, .28);
    }
    .label .size { font-weight: 400; opacity: .85; margin-left: 6px; font-variant-numeric: tabular-nums; }

    /* The site's menu surface: its background, radius, shadow and font, plus an
       outer ring so the bar still reads over a page of the same colour. */
    .bar {
      position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
      width: max-content; max-width: calc(100vw - 16px);
      display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px;
      padding: 6px; border-radius: var(--radius); background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); box-shadow: var(--shadow), 0 0 0 1px var(--ring);
      backdrop-filter: blur(16px) saturate(1.4);
      pointer-events: auto; animation: fade .12s ease-out;
    }
    .bar.bottom { top: auto; bottom: 12px; }
    @keyframes fade { from { opacity: 0; } }
    .app { font-weight: var(--title-weight); padding: 0 4px 0 6px; white-space: nowrap; }
    .seg { display: inline-flex; padding: 2px; border-radius: min(calc(var(--btn-radius) + 2px), calc(var(--item-h) / 2)); background: var(--hover); }
    .seg button {
      height: calc(var(--item-h) - 4px); padding: 0 10px; display: inline-flex; align-items: center;
      border-radius: min(var(--btn-radius), calc(var(--item-h) / 2 - 2px));
      color: var(--muted); font-weight: var(--weight); white-space: nowrap;
    }
    .seg button:hover { color: var(--fg); }
    .seg button[aria-pressed="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 3px rgba(0, 0, 0, .22); }
    .hint { color: var(--muted); padding: 0 6px; max-width: 360px; }
    .btn {
      height: var(--item-h); padding: 0 12px; display: inline-flex; align-items: center;
      border-radius: min(var(--btn-radius), calc(var(--item-h) / 2)); font-weight: var(--weight); white-space: nowrap;
    }
    .btn:hover { background: var(--hover); }
    .btn:active { background: var(--pressed); }
    .btn.primary { background: var(--accent); color: var(--accent-fg); }
    .btn.primary:hover { background: var(--accent); filter: brightness(1.08); }
    .btn.primary:active { background: var(--accent); filter: brightness(.94); }
    .sep { width: 1px; align-self: stretch; margin: 4px 2px; background: var(--line); }

    .outline {
      position: absolute; border: 2px solid var(--rec); border-radius: 4px;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, .75), inset 0 0 0 1px rgba(0, 0, 0, .35);
    }
    .pill {
      position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 6px;
      padding: 4px 4px 4px 12px; border-radius: 999px; background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); box-shadow: var(--shadow), 0 0 0 1px var(--ring);
      backdrop-filter: blur(16px) saturate(1.4);
      pointer-events: auto; white-space: nowrap;
    }
    .pill .btn { border-radius: 999px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--rec); flex: none; animation: blink 1.2s ease-in-out infinite; }
    .pill.starting .dot { background: var(--muted); animation: none; }
    .time { min-width: 76px; color: var(--muted); font-variant-numeric: tabular-nums; }
    @keyframes blink { 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) { .bar, .dot { animation: none; } }
  `;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) if (c) node.appendChild(c);
    return node;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function userError(text) {
    return Object.assign(new Error(text), { userMessage: text });
  }

  function errorText(err) {
    if (err && err.userMessage) return err.userMessage;
    const text = String((err && err.message) || err || '');
    if (/context invalidated|receiving end/i.test(text)) return 'Just download it was updated. Reload this page and try again.';
    return `Couldn’t capture the page${text ? `: ${text}` : '.'}`;
  }

  function toast(text, options) {
    if (JDI.picker && typeof JDI.picker.toast === 'function') return JDI.picker.toast(text, options);
    return '';
  }

  function dismissToast(id) {
    if (JDI.picker && typeof JDI.picker.dismiss === 'function') JDI.picker.dismiss(id);
  }

  /** Add a listener and remember how to remove it. */
  function listen(list, target, type, fn, options) {
    target.addEventListener(type, fn, options);
    list.push(() => target.removeEventListener(type, fn, options));
  }

  /** The parent in the composed tree (steps out of shadow roots). */
  function parentOf(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const rootNode = node.getRootNode && node.getRootNode();
    return rootNode && rootNode !== document && rootNode.host ? rootNode.host : null;
  }

  function isInside(node, container) {
    for (let n = node; n; n = parentOf(n)) if (n === container) return true;
    return false;
  }

  function isOurs(node) {
    return !!node && (node.localName === HOST_TAG || node.localName === TOAST_HOST_TAG);
  }

  /** The layout viewport in CSS px, without scrollbars. */
  function viewportBox() {
    const vv = window.visualViewport;
    if (vv && Math.abs(vv.scale - 1) < 0.001 && vv.width > 0 && vv.height > 0) return { width: vv.width, height: vv.height };
    const docEl = document.documentElement;
    if (document.compatMode !== 'BackCompat' && docEl && docEl.clientWidth > 0 && docEl.clientHeight > 0) {
      return { width: docEl.clientWidth, height: docEl.clientHeight };
    }
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function nextFrames(count) {
    return new Promise((resolve) => {
      let left = count;
      let timer = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, 250 * count); // rAF doesn't run in background tabs
      const step = () => {
        left -= 1;
        if (left <= 0) finish();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function pageTheme() {
    try {
      return JDI.picker && typeof JDI.picker.pageTheme === 'function' ? JDI.picker.pageTheme() : 'light';
    } catch {
      return 'light';
    }
  }

  function pageTitle() {
    const title = String(document.title || '').replace(/\s+/g, ' ').trim();
    return (title || window.location.hostname || 'Web page').slice(0, 80);
  }

  /** A short, readable name for an element, for file names. */
  function partName(node) {
    const aria = String(node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (aria && aria.length <= 40) return aria;
    if (node.id && /^[A-Za-z][\w-]{0,39}$/.test(node.id)) return node.id;
    const cls = Array.from(node.classList).find((c) => /^[A-Za-z][\w-]{1,39}$/.test(c) && !/\d{3,}/.test(c));
    return cls || node.localName;
  }

  function fileBase(target) {
    const part = target.kind === 'page' ? 'whole page' : target.kind === 'visible' ? 'visible area' : partName(target.el);
    return `${pageTitle()} (${part})`;
  }

  /** tag#id.class for the selector label. */
  function describe(node) {
    let text = node.localName;
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) text += `#${node.id}`;
    for (const c of Array.from(node.classList).filter((c) => /^[A-Za-z_-][\w-]*$/.test(c)).slice(0, 2)) text += `.${c}`;
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }

  // ---------------------------------------------------------------------------
  // Our UI host, and hiding UI from screenshots
  // ---------------------------------------------------------------------------

  let host = null;
  let stage = null;

  // ---------------------------------------------------------------------------
  // The site's own look
  //
  // JDI.themes (content/themes.js) turns the page we're on into a token set and
  // a few menu metrics. They are written onto .stage as custom properties, so
  // the stylesheet above keeps working when a token is missing, when the site
  // isn't one we theme, or when themes.js isn't loaded at all. While the UI is
  // open we watch <html>/<body> and the OS setting, so a site that switches
  // between its light and dark theme takes us with it.
  // ---------------------------------------------------------------------------

  const THEME_VARS = [
    '--font', '--fs', '--weight', '--title-weight', '--radius', '--btn-radius', '--item-h',
    '--bg', '--fg', '--muted', '--line', '--hover', '--pressed', '--accent', '--accent-fg',
    '--focus', '--rec', '--shadow',
  ];
  const BLANK = /^(none|transparent|inherit|initial|unset|auto|normal)$/i;

  /** The first of `names` the theme actually has a value for. */
  function token(tokens, names) {
    for (const name of names) {
      const value = tokens && typeof tokens[name] === 'string' ? tokens[name].trim() : '';
      if (value && !BLANK.test(value)) return colorOf(value);
    }
    return '';
  }

  /** "1px solid rgba(0, 0, 0, .2)" -> "rgba(0, 0, 0, .2)": some tokens are a whole border. */
  function colorOf(value) {
    const match = /^\d+(?:\.\d+)?px\s+[a-z]+\s+(.+)$/i.exec(value);
    return match ? match[1].trim() : value;
  }

  /** The first pixel length in a measured value ("36px (the ⋮ menu) / 40px" -> 36). */
  function pxOf(value, min, max) {
    const match = /(-?\d+(?:\.\d+)?)\s*px/.exec(String(value == null ? '' : value));
    const n = match ? parseFloat(match[1]) : NaN;
    return Number.isFinite(n) ? `${clamp(n, min, max)}px` : '';
  }

  function weightOf(value) {
    const match = /[1-9]00\b/.exec(String(value == null ? '' : value));
    return match ? match[0] : '';
  }

  function themeApi() {
    const api = JDI.themes;
    return api && typeof api.forLocation === 'function' ? api : null;
  }

  /** The site theme, its light/dark mode, and the custom properties they make. */
  function readTheme() {
    const api = themeApi();
    let site = null;
    let tokens = null;
    let mode = '';
    if (api) {
      try {
        site = api.forLocation(window.location) || null;
      } catch {
        site = null;
      }
      try {
        tokens = typeof api.current === 'function' ? api.current(window.location) : null;
      } catch {
        tokens = null;
      }
    }
    // current() may hand back { mode, tokens } instead of the tokens themselves.
    if (tokens && tokens.tokens && typeof tokens.tokens === 'object') {
      if (tokens.mode === 'dark' || tokens.mode === 'light') mode = tokens.mode;
      tokens = tokens.tokens;
    }
    if (!mode && site && typeof site.detect === 'function') {
      try {
        const detected = site.detect();
        if (detected === 'dark' || detected === 'light') mode = detected;
      } catch {
        /* the site changed under the detector */
      }
    }
    if (!mode && tokens && (tokens.mode === 'dark' || tokens.mode === 'light')) mode = tokens.mode;
    if (!mode) mode = pageTheme();
    if (!tokens && site && site.tokens) tokens = site.tokens[mode] || site.tokens.dark || site.tokens.light || null;

    const menu = (site && site.menu) || {};
    const button = (site && (site.button || site.primaryButton)) || {};
    const vars = {};
    const set = (name, value) => {
      if (value) vars[name] = value;
    };
    const font = site && (site.font || site.fontFamily);
    set('--font', typeof font === 'string' ? font.trim() : '');
    set('--bg', token(tokens, ['surface', 'menuBackground', 'bg', 'background']));
    set('--fg', token(tokens, ['text', 'textPrimary', 'fg']));
    set('--muted', token(tokens, ['textSecondary', 'muted']));
    set('--line', token(tokens, ['divider', 'line', 'border', 'outline']));
    set('--hover', token(tokens, ['hover']));
    set('--pressed', token(tokens, ['pressed', 'active']));
    set('--accent', token(tokens, ['accent']));
    set('--accent-fg', token(tokens, ['accentText', 'accentFg', 'onAccent']));
    set('--focus', token(tokens, ['focusRing', 'focus', 'accent']));
    set('--rec', token(tokens, ['error', 'danger']));
    set('--shadow', token(tokens, ['shadow']));
    // Metrics: a surface radius, a control height and a text size that match
    // the site's menus, kept inside a range the bar and the pill can wear.
    set('--radius', pxOf(menu.radius, 2, 16));
    set('--btn-radius', pxOf(button.radius || menu.itemRadius, 0, 999));
    set('--item-h', pxOf(button.height || menu.itemHeight, 26, 40));
    set('--fs', pxOf(menu.fontSize || button.fontSize, 12, 15));
    set('--weight', weightOf(button.fontWeight || menu.fontWeight));
    set('--title-weight', weightOf(menu.titleFontWeight || button.fontWeight));
    return { mode, vars };
  }

  let probe = null;

  /** A colour token read back after substitution, so site variables resolve too. */
  function readColor(value) {
    if (!stage) return null;
    if (!probe || probe.parentNode !== stage) {
      probe = el('span', { class: 'probe', 'aria-hidden': 'true' });
      stage.appendChild(probe);
    }
    try {
      probe.style.color = '';
      probe.style.color = value;
      if (!probe.style.color) return null;
      const match = /^rgba?\(([^)]+)\)$/i.exec(getComputedStyle(probe).color.trim());
      if (!match) return null;
      const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    } catch {
      return null;
    }
  }

  function luminance(c) {
    const channel = (v) => {
      const x = clamp(v, 0, 255) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }

  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Enough colour of its own to stand out over a page we know nothing about. */
  function colourful(c) {
    return c.a > 0.6 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) >= 34;
  }

  /**
   * The highlight colour and the text on the site's accent. A brand colour that
   * is really black or white (YouTube, Snapchat) would disappear into the page,
   * so the highlight falls back to a colour of our own.
   */
  function tuneTheme(mode) {
    const accent = readColor('var(--accent)');
    const accentText = readColor('var(--accent-fg)');
    if (accent && accentText && contrast(accent, accentText) < 3.2) {
      stage.style.setProperty('--accent-fg', luminance(accent) > 0.42 ? '#0b0d12' : '#ffffff');
    }
    const mark = accent && colourful(accent) ? 'var(--accent)' : mode === 'dark' ? '#5b8cff' : '#2f6bff';
    stage.style.setProperty('--mark', mark);
    const marked = readColor(mark) || accent;
    stage.style.setProperty('--mark-fg', marked && luminance(marked) > 0.42 ? '#0b0d12' : '#ffffff');
    stage.style.setProperty('--ring', mode === 'dark' ? 'rgba(255, 255, 255, .18)' : 'rgba(15, 20, 30, .16)');
  }

  let themeKey = '';

  function applyTheme() {
    if (!stage) return;
    const { mode, vars } = readTheme();
    const key = `${mode}|${THEME_VARS.map((name) => vars[name] || '').join('|')}`;
    if (key === themeKey && stage.getAttribute('data-theme') === mode) return;
    themeKey = key;
    stage.setAttribute('data-theme', mode);
    for (const name of THEME_VARS) {
      if (vars[name]) stage.style.setProperty(name, vars[name]);
      else stage.style.removeProperty(name);
    }
    tuneTheme(mode);
  }

  let unwatchTheme = null;

  /** Follow the site while our UI is open: it may switch theme under us. */
  function watchTheme() {
    if (unwatchTheme) return;
    const off = [];
    let timer = 0;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        applyTheme();
      }, 60);
    };
    const api = themeApi();
    for (const name of ['watch', 'onChange']) {
      const hook = api && api[name];
      if (typeof hook !== 'function') continue;
      try {
        // watch(callback) or watch(location, callback), whichever it takes.
        const stop = hook.length >= 2 ? hook.call(api, window.location, bump) : hook.call(api, bump);
        if (typeof stop === 'function') off.push(stop);
      } catch {
        /* a registry with another shape: the watchers below still see the switch */
      }
      break;
    }
    const observer = new MutationObserver(bump);
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      try {
        observer.observe(node, { attributes: true });
      } catch {
        /* ignore */
      }
    }
    off.push(() => observer.disconnect());
    try {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', bump);
      off.push(() => media.removeEventListener('change', bump));
    } catch {
      /* no matchMedia */
    }
    unwatchTheme = () => {
      unwatchTheme = null;
      clearTimeout(timer);
      for (const stop of off) {
        try {
          stop();
        } catch {
          /* already gone */
        }
      }
    };
  }

  function ensureHost() {
    if (host && host.isConnected) {
      applyTheme();
      return;
    }
    host = document.createElement(HOST_TAG);
    host.style.cssText =
      'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; ' +
      'width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;';
    const root = host.attachShadow({ mode: 'closed' });
    let styled = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      styled = true;
    } catch {
      /* fall back to a <style> element */
    }
    if (!styled) root.appendChild(el('style', { text: CSS }));
    // The page's own top layer (fullscreen, dialogs) would cover a plain fixed
    // element; a popover goes above it.
    stage = el('div', { class: 'stage', 'data-theme': pageTheme(), popover: 'manual' });
    root.appendChild(stage);
    (document.documentElement || document.body).appendChild(host);
    try {
      stage.showPopover();
    } catch {
      /* position: fixed still works */
    }
    themeKey = '';
    applyTheme();
    watchTheme();
    // Keep our clicks and keys away from the page's own listeners.
    for (const type of ['click', 'dblclick', 'auxclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'keydown', 'keyup', 'keypress', 'wheel']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  function removeHost() {
    if (unwatchTheme) unwatchTheme();
    if (!host) return;
    try {
      if (stage.matches(':popover-open')) stage.hidePopover();
    } catch {
      /* ignore */
    }
    host.remove();
    host = null;
    stage = null;
    probe = null;
    themeKey = '';
  }

  const hiddenHosts = new Map(); // host element -> previous inline visibility

  /** Hide our toasts/pickers (and this UI) so they don't end up in a screenshot or recording. */
  function hideOurUi() {
    for (const node of document.querySelectorAll(`${TOAST_HOST_TAG}, ${HOST_TAG}`)) {
      if (hiddenHosts.has(node)) continue;
      hiddenHosts.set(node, { value: node.style.getPropertyValue('visibility'), priority: node.style.getPropertyPriority('visibility') });
      node.style.setProperty('visibility', 'hidden', 'important');
    }
  }

  function showOurUi() {
    for (const [node, prev] of hiddenHosts) {
      if (prev.value) node.style.setProperty('visibility', prev.value, prev.priority);
      else node.style.removeProperty('visibility');
    }
    hiddenHosts.clear();
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  let lastRightClick = null;
  function onContextMenu(event) {
    if (event.isTrusted) lastRightClick = { x: event.clientX, y: event.clientY, time: Date.now() };
  }
  window.addEventListener('contextmenu', onContextMenu, true);

  function onMessage(message, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id || !message) return false;
    if (message.type === 'jdi:capture-start') {
      sendResponse({ ok: true });
      start(message.mode);
      return false;
    }
    if (message.type === 'jdi:download-finished' && recording && message.batch === recording.batch && recording.recId) {
      // The recording ended on its own (e.g. Chrome stopped the tab capture).
      endRecordingUi(recording);
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onMessage);

  let selector = null;
  let busy = false;
  let recording = null;

  function start(mode) {
    const wanted = mode === 'gif' ? 'gif' : 'png';
    if (recording) {
      toast('Already recording. Stop that recording first.', { kind: 'info', timeout: 4000 });
      return;
    }
    if (busy) return;
    if (selector) {
      selector.setMode(wanted);
      return;
    }
    openSelector(wanted);
  }

  // ---------------------------------------------------------------------------
  // Element selector
  // ---------------------------------------------------------------------------

  function openSelector(mode) {
    ensureHost();
    const off = [];
    const s = {
      mode,
      base: null, // element under the pointer
      chain: [], // base, then the ancestors the wheel went up to
      level: 0,
      x: NaN,
      y: NaN,
      overBar: false,
      raf: 0,
      wheelSum: 0,
      wheelAt: 0,
    };
    selector = s;

    const box = el('div', { class: 'box', hidden: true });
    const labelName = el('span', { class: 'name' });
    const labelSize = el('span', { class: 'size' });
    const label = el('div', { class: 'label', hidden: true }, labelName, labelSize);
    const pngButton = el('button', { type: 'button', text: 'Image (PNG)', 'aria-pressed': 'false', onclick: () => s.setMode('png') });
    const gifButton = el('button', { type: 'button', text: 'GIF', 'aria-pressed': 'false', onclick: () => s.setMode('gif') });
    const hint = el('span', { class: 'hint' });
    const visibleButton = el('button', { class: 'btn', type: 'button', text: 'Visible area', onclick: () => choose({ kind: 'visible' }) });
    const pageButton = el('button', { class: 'btn', type: 'button', text: 'Whole page', onclick: () => choose({ kind: 'page' }) });
    const cancelButton = el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => closeSelector() });
    const bar = el(
      'div',
      { class: 'bar', role: 'toolbar', 'aria-label': 'Just download web page' },
      el('span', { class: 'app', text: 'Just download it' }),
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Save as' }, pngButton, gifButton),
      hint,
      visibleButton,
      pageButton,
      el('span', { class: 'sep' }),
      cancelButton,
    );
    stage.replaceChildren(box, label, bar);

    s.setMode = (next) => {
      s.mode = next === 'gif' ? 'gif' : 'png';
      pngButton.setAttribute('aria-pressed', String(s.mode === 'png'));
      gifButton.setAttribute('aria-pressed', String(s.mode === 'gif'));
      hint.textContent =
        s.mode === 'gif'
          ? 'Click the part of the page to record · Scroll or ↑/↓ for a bigger or smaller part'
          : 'Click the part of the page to save · Scroll or ↑/↓ for a bigger or smaller part';
      pageButton.hidden = s.mode === 'gif';
    };
    s.setMode(mode);

    const current = () => (s.chain.length ? s.chain[Math.min(s.level, s.chain.length - 1)] : null);

    function elementAt(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      let stack = [];
      try {
        stack = JDI.dom && typeof JDI.dom.deepElementsFromPoint === 'function' ? JDI.dom.deepElementsFromPoint(x, y) : document.elementsFromPoint(x, y);
      } catch {
        stack = [];
      }
      return stack.find((node) => !isOurs(node)) || null;
    }

    function retarget() {
      const target = elementAt(s.x, s.y);
      if (target === s.base) return;
      s.base = target;
      s.chain = target ? [target] : [];
      s.level = 0;
    }

    function sameBox(a, b) {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return Math.abs(ra.left - rb.left) < 1 && Math.abs(ra.top - rb.top) < 1 && Math.abs(ra.width - rb.width) < 1 && Math.abs(ra.height - rb.height) < 1;
    }

    function up() {
      if (!s.chain.length) return;
      if (s.level + 1 < s.chain.length) {
        s.level++;
      } else {
        const node = s.chain[s.chain.length - 1];
        let parent = parentOf(node);
        // Skip wrappers that are exactly as big as what's selected: each step should visibly change.
        while (parent && parentOf(parent) && sameBox(parent, node)) parent = parentOf(parent);
        if (!parent) return;
        s.chain.push(parent);
        s.level = s.chain.length - 1;
      }
      schedule();
    }

    function down() {
      if (s.level > 0) s.level--;
      schedule();
    }

    function schedule() {
      if (!s.raf) s.raf = requestAnimationFrame(render);
    }

    function render() {
      s.raf = 0;
      if (selector !== s) return;
      const target = s.overBar ? null : current();
      if (!target || !target.isConnected) {
        box.hidden = true;
        label.hidden = true;
      } else {
        const vp = { width: window.innerWidth, height: window.innerHeight };
        const r = target.getBoundingClientRect();
        box.hidden = false;
        box.style.left = `${Math.round(r.left)}px`;
        box.style.top = `${Math.round(r.top)}px`;
        box.style.width = `${Math.max(0, Math.round(r.width))}px`;
        box.style.height = `${Math.max(0, Math.round(r.height))}px`;
        labelName.textContent = describe(target);
        labelSize.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
        label.hidden = false;
        const lw = label.offsetWidth;
        const lh = label.offsetHeight;
        let top = r.top - lh - 4;
        if (top < 4) top = r.top + 4; // no room above: just inside the top edge
        top = clamp(top, 4, vp.height - lh - 4);
        label.style.left = `${Math.round(clamp(r.left, 4, Math.max(4, vp.width - lw - 4)))}px`;
        label.style.top = `${Math.round(top)}px`;
      }
      // Move the bar out of the way when the pointer gets close to it.
      if (!s.overBar && Number.isFinite(s.y)) {
        const b = bar.getBoundingClientRect();
        const atBottom = bar.classList.contains('bottom');
        if (!atBottom && s.y < b.bottom + 24) bar.classList.add('bottom');
        else if (atBottom && s.y > b.top - 24) bar.classList.remove('bottom');
      }
    }

    const fromUs = (e) => !!host && e.composedPath().includes(host);

    function onPointerMove(e) {
      s.x = e.clientX;
      s.y = e.clientY;
      s.overBar = fromUs(e);
      if (!s.overBar) retarget();
      schedule();
    }

    function onPointerLike(e) {
      if (fromUs(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click' && e.button === 0) {
        s.x = e.clientX;
        s.y = e.clientY;
        if (!s.chain.length) retarget();
        const target = current();
        if (target) choose({ kind: 'element', el: target });
      }
    }

    function onWheel(e) {
      if (fromUs(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const now = performance.now();
      if (now - s.wheelAt > 300) s.wheelSum = 0;
      s.wheelAt = now;
      s.wheelSum += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      // One step per mouse-wheel notch; trackpads have to travel a little.
      if (s.wheelSum <= -40) {
        s.wheelSum = 0;
        up();
      } else if (s.wheelSum >= 40) {
        s.wheelSum = 0;
        down();
      }
    }

    function onKeyDown(e) {
      const ours = fromUs(e);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeSelector();
        return;
      }
      if (ours) return;
      if (e.key === 'ArrowUp') up();
      else if (e.key === 'ArrowDown') down();
      else if (e.key === 'Enter') {
        const target = current();
        if (target) choose({ kind: 'element', el: target });
      } else {
        // Keep the site's shortcuts quiet, but let Page Down etc. scroll.
        e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onKeyOther(e) {
      if (!fromUs(e)) e.stopImmediatePropagation();
    }

    function onScroll() {
      if (Number.isFinite(s.x)) retarget();
      schedule();
    }

    listen(off, window, 'pointermove', onPointerMove, { capture: true, passive: true });
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
      listen(off, window, type, onPointerLike, { capture: true });
    }
    listen(off, window, 'wheel', onWheel, { capture: true, passive: false });
    listen(off, window, 'keydown', onKeyDown, { capture: true });
    listen(off, window, 'keyup', onKeyOther, { capture: true });
    listen(off, window, 'keypress', onKeyOther, { capture: true });
    listen(off, window, 'scroll', onScroll, { capture: true, passive: true });
    listen(off, window, 'resize', schedule, { passive: true });

    s.close = () => {
      for (const remove of off) remove();
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
    };

    // Opened from the right-click menu: start where the user right-clicked.
    if (lastRightClick && Date.now() - lastRightClick.time < RIGHT_CLICK_MAX_AGE_MS) {
      s.x = lastRightClick.x;
      s.y = lastRightClick.y;
      retarget();
    }
    schedule();

    function choose(target) {
      if (selector !== s) return;
      const chosenMode = s.mode;
      closeSelector();
      if (chosenMode === 'gif') startRecording(target);
      else capturePng(target);
    }
  }

  function closeSelector() {
    const s = selector;
    if (!s) return;
    selector = null;
    s.close();
    removeHost();
  }

  // ---------------------------------------------------------------------------
  // PNG
  // ---------------------------------------------------------------------------

  async function capturePng(target) {
    if (busy) return;
    busy = true;
    const id = `jdi-capture-${Date.now().toString(36)}`;
    try {
      toast('Capturing…', { id });
      const progress = (fraction) => toast(`Capturing… ${Math.round(clamp(fraction, 0, 1) * 100)}%`, { id });
      let shot;
      if (target.kind === 'visible') shot = await shootVisible();
      else if (target.kind === 'page') shot = await shootPage(progress);
      else shot = await shootElement(target.el, progress);
      toast('Saving…', { id });
      const blob = await shot.canvas.convertToBlob({ type: 'image/png' });
      dismissToast(id);
      if (!JDI.core || typeof JDI.core.saveBlob !== 'function') throw userError('Just download it was updated. Reload this page and try again.');
      const res = await JDI.core.saveBlob(blob, { site: 'Captures', base: fileBase(target), ext: 'png' });
      if (res && res.ok && shot.cut) {
        toast('That was too long for one image, so the bottom part was left out.', { kind: 'info', timeout: 9000 });
      }
    } catch (err) {
      if (!(err && err.userMessage)) console.warn('[Just download it]', err);
      toast(errorText(err), { id, kind: 'error' });
    } finally {
      busy = false;
    }
  }

  let lastShotAt = 0;
  let shotGap = SHOT_GAP_MS;

  /**
   * A screenshot of the tab as it is now, without our own UI in it. Its
   * top-left pixel is the viewport's top-left corner either way: Chrome's
   * covers the whole tab (scrollbars too), Firefox's just the `rect` we ask
   * for, the layout viewport in document px.
   */
  async function takeShot() {
    const wait = lastShotAt + shotGap - Date.now();
    if (wait > 0) await sleep(wait);
    hideOurUi();
    let res;
    let vp;
    try {
      await nextFrames(2);
      lastShotAt = Date.now();
      vp = viewportBox();
      const rect = { x: window.scrollX, y: window.scrollY, width: vp.width, height: vp.height };
      res = await chrome.runtime.sendMessage({ type: 'jdi:capture-visible', rect });
    } finally {
      showOurUi();
    }
    if (!res || !res.ok || typeof res.dataUrl !== 'string') throw userError((res && res.error) || 'Couldn’t take a screenshot of the page.');
    if (Number.isFinite(res.gapMs) && res.gapMs >= 0) shotGap = res.gapMs;
    const comma = res.dataUrl.indexOf(',');
    const binary = atob(res.dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    // Screenshot pixels per CSS px (device pixel ratio × zoom).
    return { bitmap, scale: bitmap.width / Math.max(1, res.cropped ? vp.width : window.innerWidth) };
  }

  async function shootVisible() {
    const vp = viewportBox();
    const { bitmap, scale } = await takeShot();
    const width = Math.max(1, Math.min(bitmap.width, Math.round(vp.width * scale)));
    const height = Math.max(1, Math.min(bitmap.height, Math.round(vp.height * scale)));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height, 0, 0, width, height);
    bitmap.close();
    return { canvas, cut: false };
  }

  /** Page changes made while capturing (scroll positions, hidden bars), undone at the end. */
  function pageChanges() {
    const scrolls = [];
    const styles = [];
    return {
      saveScroll(node) {
        if (scrolls.some((s) => s.node === node)) return;
        if (node === window) scrolls.push({ node, top: window.scrollY, left: window.scrollX });
        else scrolls.push({ node, top: node.scrollTop, left: node.scrollLeft });
      },
      setStyle(node, prop, value) {
        if (styles.some((s) => s.node === node && s.prop === prop)) return;
        styles.push({ node, prop, value: node.style.getPropertyValue(prop), priority: node.style.getPropertyPriority(prop) });
        node.style.setProperty(prop, value, 'important');
      },
      restore() {
        for (const s of styles.reverse()) {
          try {
            if (s.value) s.node.style.setProperty(s.prop, s.value, s.priority);
            else s.node.style.removeProperty(s.prop);
          } catch {
            /* node gone */
          }
        }
        for (const s of scrolls.reverse()) {
          try {
            s.node.scrollTo({ top: s.top, left: s.left, behavior: 'instant' });
          } catch {
            /* node gone */
          }
        }
      },
    };
  }

  function isScrollable(node) {
    if (!(node instanceof Element) || node.scrollHeight <= node.clientHeight + 1) return false;
    const overflow = getComputedStyle(node).overflowY;
    return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  }

  /** The nearest scrolling ancestor that cuts off part of `node` vertically, or null for the window. */
  function findScroller(node) {
    const r = node.getBoundingClientRect();
    const main = document.scrollingElement || document.documentElement;
    for (let n = parentOf(node); n && n !== main && n !== document.documentElement; n = parentOf(n)) {
      if (!isScrollable(n)) continue;
      const nr = n.getBoundingClientRect();
      const top = nr.top + n.clientTop;
      if (r.top < top - 1 || r.bottom > top + n.clientHeight + 1) return n;
    }
    return null;
  }

  /** An element whose scrollbars are drawn over its content instead of beside it. */
  function takesNoRoom(node) {
    const style = getComputedStyle(node);
    const px = (value) => parseFloat(value) || 0;
    const besideX = node.offsetWidth - node.clientWidth - px(style.borderLeftWidth) - px(style.borderRightWidth);
    const besideY = node.offsetHeight - node.clientHeight - px(style.borderTopWidth) - px(style.borderBottomWidth);
    return besideX < 1 && besideY < 1;
  }

  function windowCanScroll() {
    const blocked = (node) => !!node && /^(hidden|clip)$/.test(getComputedStyle(node).overflowY);
    const html = document.documentElement;
    if (blocked(html)) return false;
    // body's overflow applies to the window when <html> leaves it visible.
    return !(document.body && getComputedStyle(html).overflowY === 'visible' && blocked(document.body));
  }

  /** The biggest scrolling element on screen, for app-style pages where the window itself doesn't scroll. */
  function mainScroller() {
    const vp = viewportBox();
    let best = null;
    let bestArea = 0;
    for (const node of document.querySelectorAll('body, body *')) {
      if (node.scrollHeight <= node.clientHeight + 1 || node.clientHeight < 100 || isOurs(node)) continue;
      if (!isScrollable(node)) continue;
      const r = node.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, vp.width) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vp.height) - Math.max(r.top, 0));
      if (area > bestArea) {
        best = node;
        bestArea = area;
      }
    }
    return bestArea >= 0.3 * vp.width * vp.height ? best : null;
  }

  /**
   * Scrolling through the window or an element. Positions are "scroll
   * coordinates": the content's y, where get() is at the top of its box.
   */
  function scrollContext(scroller) {
    if (!scroller) {
      return {
        node: window,
        get: () => window.scrollY,
        set: (y) => window.scrollTo({ top: y, left: window.scrollX, behavior: 'instant' }),
        origin: () => 0, // client y of the top of the scrolling box
        band: () => {
          const vp = viewportBox();
          return { top: 0, bottom: vp.height, left: 0, right: vp.width };
        },
      };
    }
    return {
      node: scroller,
      get: () => scroller.scrollTop,
      set: (y) => scroller.scrollTo({ top: y, left: scroller.scrollLeft, behavior: 'instant' }),
      origin: () => scroller.getBoundingClientRect().top + scroller.clientTop,
      band: () => {
        const vp = viewportBox();
        const r = scroller.getBoundingClientRect();
        const top = r.top + scroller.clientTop;
        const left = r.left + scroller.clientLeft;
        return {
          top: Math.max(top, 0),
          bottom: Math.min(top + scroller.clientHeight, vp.height),
          left: Math.max(left, 0),
          right: Math.min(left + scroller.clientWidth, vp.width),
        };
      },
    };
  }

  function fixedAndSticky() {
    const found = [];
    const visit = (rootNode, depth) => {
      for (const node of rootNode.querySelectorAll('*')) {
        if (isOurs(node)) continue;
        const position = getComputedStyle(node).position;
        if (position === 'fixed' || position === 'sticky') found.push(node);
        if (node.shadowRoot && depth < 4) visit(node.shadowRoot, depth + 1);
      }
    };
    visit(document, 0);
    return found;
  }

  async function shootElement(node, onProgress) {
    if (!node || !node.isConnected) throw userError('That part of the page is gone. Pick it again.');
    const first = node.getBoundingClientRect();
    if (first.width < 1 || first.height < 1) throw userError('That part of the page has no size. Pick another one.');
    const changes = pageChanges();
    changes.saveScroll(window);
    for (let n = parentOf(node); n; n = parentOf(n)) {
      if (n instanceof Element && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) changes.saveScroll(n);
    }
    try {
      const scroller = findScroller(node);
      const vp = viewportBox();
      if (scroller) {
        // The scrolling box itself has to be on screen.
        const sr = scroller.getBoundingClientRect();
        if (sr.top < 0 || sr.bottom > vp.height || sr.right <= 0 || sr.left >= vp.width) {
          scroller.scrollIntoView({ block: sr.height > vp.height ? 'start' : 'nearest', inline: 'nearest', behavior: 'instant' });
        }
      } else if (first.right <= 0 || first.left >= vp.width) {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
      const ctx = scrollContext(scroller);
      const band = ctx.band();
      const r = node.getBoundingClientRect();
      const left = Math.max(r.left, band.left);
      const right = Math.min(r.right, band.right);
      if (right - left < 1 || band.bottom - band.top < 1) throw userError('That part of the page isn’t on screen. Scroll to it and try again.');
      return await stitch({
        ctx,
        top: r.top - ctx.origin() + ctx.get(),
        height: r.height,
        left,
        width: right - left,
        container: node,
        changes,
        onProgress,
      });
    } finally {
      changes.restore();
    }
  }

  async function shootPage(onProgress) {
    const main = document.scrollingElement || document.documentElement;
    const vp = viewportBox();
    const windowScrolls = main.scrollHeight > vp.height + 1 && windowCanScroll();
    const scroller = windowScrolls ? null : mainScroller();
    if (!windowScrolls && !scroller) return shootVisible();
    const changes = pageChanges();
    changes.saveScroll(window);
    if (scroller) changes.saveScroll(scroller);
    try {
      const ctx = scrollContext(scroller);
      const band = ctx.band();
      return await stitch({
        ctx,
        top: 0,
        height: scroller ? scroller.scrollHeight : main.scrollHeight,
        left: band.left,
        width: band.right - band.left,
        container: scroller,
        changes,
        onProgress,
      });
    } finally {
      changes.restore();
    }
  }

  /**
   * Screenshot rows [top, top + height) (scroll coordinates of ctx) and the
   * client x range [left, left + width), scrolling as needed, into one canvas.
   * `container`: the element being captured (null = the whole page). Fixed and
   * sticky elements outside it are hidden once we scroll; the ones inside it
   * after the first screenshot, so they appear once.
   */
  async function stitch({ ctx, top, height, left, width, container, changes, onProgress }) {
    const scrollerNode = ctx.node === window ? document.scrollingElement || document.documentElement : ctx.node;
    // Smooth scrolling and scroll snapping would fight the positions we set.
    for (const n of new Set([scrollerNode, document.documentElement])) {
      if (!n) continue;
      changes.setStyle(n, 'scroll-behavior', 'auto');
      changes.setStyle(n, 'scroll-snap-type', 'none');
    }
    // Overlay scrollbars (Firefox, macOS) take no room, but every scroll we
    // make shows the thumb, and each screenshot would keep it. Hiding them
    // moves nothing. (The window's own is left out of Firefox's screenshots.)
    if (ctx.node !== window && takesNoRoom(scrollerNode)) changes.setStyle(scrollerNode, 'scrollbar-width', 'none');

    let fixed = null;
    const hideFixed = (which) => {
      if (!fixed) fixed = fixedAndSticky();
      for (const n of fixed) {
        if (container && isInside(container, n)) continue; // an ancestor: hiding it would hide the capture
        const inside = !container || isInside(n, container);
        if ((which === 'outside' && inside) || (which === 'inside' && !inside)) continue;
        changes.setStyle(n, 'transition', 'none');
        changes.setStyle(n, 'opacity', '0');
      }
    };

    let canvas = null;
    let g = null;
    let outScale = 1;
    let keep = height; // rows we will capture (less if the image would be too big)
    let covered = 0;
    let cut = false;
    let shots = 0;
    let retries = 0;

    const view = () => {
      const scroll = ctx.get();
      const origin = ctx.origin();
      const band = ctx.band();
      return { scroll, origin, visTop: scroll + band.top - origin, visBottom: scroll + band.bottom - origin };
    };

    while (covered < keep - 0.5) {
      const want = top + covered;
      let v = view();
      const allVisible = want >= v.visTop - 0.5 && top + keep <= v.visBottom + 0.5;
      if (shots > 0 || !allVisible) {
        if (shots === 0 && container) hideFixed('outside');
        ctx.set(v.scroll + (want - v.visTop));
        await nextFrames(1);
        v = view();
      }
      const from = Math.max(want, v.visTop);
      const to = Math.min(top + keep, v.visBottom);
      if (to - from < 0.5) {
        // Can't scroll any further (the page may have changed size).
        if (shots > 0) {
          cut = true;
          keep = covered;
          break;
        }
        throw userError('That part of the page isn’t on screen. Scroll to it and try again.');
      }

      const { bitmap, scale } = await takeShot();
      // The scroll position may have moved while waiting (lazy loading, the user).
      const after = view();
      if ((Math.abs(after.scroll - v.scroll) > 0.5 || Math.abs(after.origin - v.origin) > 0.5) && retries < 4) {
        retries++;
        bitmap.close();
        continue;
      }
      shots++;

      if (!canvas) {
        outScale = Math.min(scale, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / keep, Math.sqrt(MAX_CANVAS_AREA / (width * keep)));
        const floor = Math.min(1, scale);
        if (outScale < floor) {
          // Rather than blurry, keep at least 1 image px per CSS px and leave out the bottom.
          outScale = floor;
          const rows = Math.floor(Math.min(MAX_CANVAS_SIDE / outScale, MAX_CANVAS_AREA / (width * outScale * outScale)));
          if (rows < keep) {
            keep = rows;
            cut = true;
          }
        }
        canvas = new OffscreenCanvas(Math.max(1, Math.round(width * outScale)), Math.max(1, Math.round(keep * outScale)));
        g = canvas.getContext('2d');
        g.imageSmoothingQuality = 'high';
      }

      const clientTop = v.origin + (from - v.scroll);
      const sx = clamp(Math.round(left * scale), 0, bitmap.width - 1);
      const sw = clamp(Math.round(width * scale), 1, bitmap.width - sx);
      const sy = clamp(Math.round(clientTop * scale), 0, bitmap.height - 1);
      const dy0 = Math.round((from - top) * outScale);
      const dy1 = Math.min(canvas.height, Math.round((Math.min(to, top + keep) - top) * outScale));
      const sh = clamp(Math.round(((dy1 - dy0) * scale) / outScale), 1, bitmap.height - sy);
      if (dy1 > dy0) g.drawImage(bitmap, sx, sy, sw, sh, 0, dy0, canvas.width, dy1 - dy0);
      bitmap.close();

      covered = Math.min(keep, to - top);
      if (onProgress) onProgress(covered / keep);
      if (covered < keep - 0.5) hideFixed('all');
    }

    if (!canvas) throw userError('Couldn’t capture that part of the page.');
    const rows = Math.max(1, Math.round(keep * outScale));
    if (rows < canvas.height) {
      const trimmed = new OffscreenCanvas(canvas.width, rows);
      trimmed.getContext('2d').drawImage(canvas, 0, 0);
      canvas = trimmed;
    }
    return { canvas, cut };
  }

  // ---------------------------------------------------------------------------
  // GIF
  // ---------------------------------------------------------------------------

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  async function startRecording(target) {
    if (recording) return;
    const vp = viewportBox();
    const r = target.kind === 'element' && target.el && target.el.isConnected ? target.el.getBoundingClientRect() : { left: 0, top: 0, right: vp.width, bottom: vp.height };
    const region = {
      x: Math.max(0, Math.ceil(r.left)),
      y: Math.max(0, Math.ceil(r.top)),
    };
    region.width = Math.min(Math.floor(vp.width), Math.floor(r.right)) - region.x;
    region.height = Math.min(Math.floor(vp.height), Math.floor(r.bottom)) - region.y;
    if (region.width < 24 || region.height < 24) {
      toast('That part of the page is too small to record, or it’s off screen. Pick a bigger one.', { kind: 'error' });
      return;
    }

    ensureHost();
    const off = [];
    const outline = el('div', { class: 'outline' });
    const time = el('span', { class: 'time', text: 'Starting…' });
    const stopButton = el('button', { class: 'btn primary', type: 'button', text: 'Stop & save', disabled: true });
    const cancelButton = el('button', { class: 'btn', type: 'button', text: 'Cancel' });
    const pill = el('div', { class: 'pill starting', role: 'group', 'aria-label': 'Recording' }, el('span', { class: 'dot' }), time, stopButton, cancelButton);
    stage.replaceChildren(outline, pill);
    placeRecordingUi(region, outline, pill, vp);

    const rec = {
      batch: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      recId: '',
      startedAt: 0,
      stopping: false,
      timer: 0,
      off,
    };
    recording = rec;
    stopButton.addEventListener('click', () => stopRecording(false));
    cancelButton.addEventListener('click', () => stopRecording(true));
    listen(off, window, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stopRecording(!rec.recId);
    }, { capture: true });
    // Leaving the page: keep what was recorded so far.
    listen(off, window, 'pagehide', () => stopRecording(!rec.recId));
    hideOurToasts();

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'jdi:record-start',
        crop: region,
        viewport: { width: vp.width, height: vp.height, pixelRatio: window.devicePixelRatio || 1, windowWidth: window.innerWidth, windowHeight: window.innerHeight },
        batch: rec.batch,
        base: fileBase(target),
      });
    } catch (err) {
      res = { ok: false, error: errorText(err) };
    }
    if (recording !== rec || rec.stopping) {
      // Canceled while it was starting.
      if (res && res.ok && res.recId) chrome.runtime.sendMessage({ type: 'jdi:record-stop', recId: res.recId, cancel: true }).catch(() => {});
      return;
    }
    if (!res || !res.ok || !res.recId) {
      endRecordingUi(rec);
      toast((res && res.error) || 'Couldn’t start recording. Try again.', { kind: 'error', timeout: 10000 });
      return;
    }

    rec.recId = res.recId;
    rec.startedAt = Date.now();
    if (JDI.core && typeof JDI.core.trackJob === 'function') JDI.core.trackJob({ batch: rec.batch, jobId: rec.recId });
    hideOurToasts(); // trackJob may have just created the toast host
    pill.classList.remove('starting');
    stopButton.disabled = false;
    const tick = () => {
      if (recording !== rec) return;
      const elapsed = Date.now() - rec.startedAt;
      time.textContent = `${formatTime(elapsed)} / ${formatTime(MAX_GIF_SECONDS * 1000)}`;
      hideOurToasts();
      if (elapsed >= MAX_GIF_SECONDS * 1000) stopRecording(false);
    };
    tick();
    rec.timer = setInterval(tick, 250);
  }

  /** Toasts would be recorded if they're inside the box: hide them while recording. */
  function hideOurToasts() {
    for (const node of document.querySelectorAll(TOAST_HOST_TAG)) {
      if (hiddenHosts.has(node)) continue;
      hiddenHosts.set(node, { value: node.style.getPropertyValue('visibility'), priority: node.style.getPropertyPriority('visibility') });
      node.style.setProperty('visibility', 'hidden', 'important');
    }
  }

  /**
   * Outline just outside the box (so it isn't recorded) and the control pill
   * next to it. With no room around the box, the box gives up a strip at the
   * bottom for the pill.
   */
  function placeRecordingUi(region, outline, pill, vp) {
    const ring = 4; // outline: 2px border, 2px clear of the box
    const gap = 10;
    const margin = 8;
    const pw = pill.offsetWidth || 260;
    const ph = pill.offsetHeight || 38;
    const centerX = clamp(region.x + region.width / 2 - pw / 2, margin, Math.max(margin, vp.width - pw - margin));
    let px;
    let py;
    if (region.y + region.height + ring + gap + ph <= vp.height - margin) {
      px = centerX;
      py = region.y + region.height + ring + gap;
    } else if (region.y - ring - gap - ph >= margin) {
      px = centerX;
      py = region.y - ring - gap - ph;
    } else if (region.x + region.width + ring + gap + pw <= vp.width - margin) {
      px = region.x + region.width + ring + gap;
      py = clamp(region.y + region.height - ph, margin, vp.height - ph - margin);
    } else if (region.x - ring - gap - pw >= margin) {
      px = region.x - ring - gap - pw;
      py = clamp(region.y + region.height - ph, margin, vp.height - ph - margin);
    } else if (vp.height - margin - ph - gap - ring - region.y >= 120) {
      region.height = Math.min(region.height, Math.floor(vp.height - margin - ph - gap - ring - region.y));
      px = centerX;
      py = region.y + region.height + ring + gap;
    } else {
      // Nowhere else to go: inside the box (it will show in the GIF).
      px = region.x + region.width - pw - margin;
      py = region.y + region.height - ph - margin;
    }
    outline.style.left = `${region.x - ring}px`;
    outline.style.top = `${region.y - ring}px`;
    outline.style.width = `${region.width + ring * 2}px`;
    outline.style.height = `${region.height + ring * 2}px`;
    pill.style.left = `${Math.round(px)}px`;
    pill.style.top = `${Math.round(py)}px`;
  }

  async function stopRecording(cancel) {
    const rec = recording;
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    endRecordingUi(rec);
    if (!rec.recId) return; // still starting: startRecording cancels it
    if (cancel) dismissToast(rec.batch);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'jdi:record-stop', recId: rec.recId, cancel: !!cancel });
    } catch (err) {
      res = { ok: false, error: errorText(err) };
    }
    if (cancel) toast('Recording canceled.', { kind: 'info', timeout: 2500 });
    else if (!res || !res.ok) toast((res && res.error) || 'The recording was lost. Try again.', { id: rec.batch, kind: 'error' });
  }

  function endRecordingUi(rec) {
    if (recording === rec) recording = null;
    clearInterval(rec.timer);
    for (const remove of rec.off) remove();
    rec.off.length = 0;
    removeHost();
    showOurUi();
  }

  // ---------------------------------------------------------------------------

  JDI.capture = {
    start,
    teardown() {
      window.removeEventListener('contextmenu', onContextMenu, true);
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* the old extension context is gone */
      }
      if (selector) closeSelector();
      if (recording) endRecordingUi(recording);
      showOurUi();
      removeHost();
    },
  };
})();
