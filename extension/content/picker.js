/*
 * Just download it: the in-page quality picker and toasts.
 *
 * Everything lives in one closed shadow root so the page's CSS can't restyle
 * it and page scripts can't easily read it. The panel and toasts sit in the
 * browser's top layer (popover), above the site's own z-indexes. When the page
 * has a fullscreen element or a modal <dialog> open, the rest of the page is
 * inert, so the panel becomes a modal <dialog> itself to stay clickable.
 * All page-derived text goes through textContent; nothing uses innerHTML.
 *
 * The stylesheet below is written entirely against --jdi-* custom properties.
 * Its own values are the neutral theme (what the picker has always looked
 * like); content/themes.js paints the site's own menu language over them on
 * the .layer element, so the panel reads as a YouTube sheet on YouTube and a
 * Spotify card on Spotify without a single layout or behaviour change.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  if (JDI.picker && JDI.picker.destroy) {
    try {
      JDI.picker.destroy();
    } catch {
      /* a previous copy from before an extension update */
    }
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    /*
     * The neutral theme, and the safety net: every rule below reads these, so
     * the picker is fully painted even before content/themes.js writes a
     * site's tokens over them on .layer.
     */
    .layer {
      --jdi-font: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --jdi-font-size: 13px; --jdi-font-size-sm: 12px; --jdi-font-size-xs: 11px; --jdi-title-size: 13px;
      --jdi-surface: #ffffff; --jdi-surface-solid: #ffffff; --jdi-text: #16181d; --jdi-muted: #646b78;
      --jdi-hover: #f2f4f7; --jdi-pressed: rgba(15, 20, 30, .1);
      --jdi-divider: #e6e8ec; --jdi-panel-border: 1px solid #e6e8ec;
      --jdi-row-line: 0; --jdi-menu-ring: transparent;
      --jdi-accent: #2f6bff; --jdi-accent-text: #ffffff; --jdi-accent-hover: #2a5fe6;
      --jdi-badge-bg: #e8efff; --jdi-badge-text: #2f6bff;
      --jdi-ok: #12805c; --jdi-err: #c4323a; --jdi-focus: #2f6bff;
      --jdi-shadow: 0 12px 32px rgba(15, 20, 30, .18), 0 2px 6px rgba(15, 20, 30, .08);
      --jdi-toast-bg: #ffffff; --jdi-toast-text: #16181d;
      --jdi-radius: 12px; --jdi-soft-radius: 8px; --jdi-item-radius: 8px;
      --jdi-item-h: 36px; --jdi-item-px: 8px; --jdi-pad-y: 6px; --jdi-pad-x: 6px;
      --jdi-weight: 550; --jdi-title-weight: 600; --jdi-icon: 16px; --jdi-width: 320px;
      --jdi-badge-radius: 999px; --jdi-btn-radius: 8px; --jdi-btn-h: 36px;
      --jdi-btn-weight: 600; --jdi-btn-size: 13px; --jdi-toast-radius: 10px;
      --jdi-blur: none; --jdi-corner-shape: round; --jdi-radius-sq: 12px; --jdi-item-radius-sq: 8px;

      font-family: var(--jdi-font); font-size: var(--jdi-font-size); line-height: 1.4;
      font-weight: 400; font-style: normal; letter-spacing: normal;
      color: var(--jdi-text);
      -webkit-font-smoothing: antialiased;
    }
    .layer[data-theme="dark"] {
      --jdi-surface: #1c1f26; --jdi-surface-solid: #1c1f26; --jdi-text: #eef0f4; --jdi-muted: #9aa2b1;
      --jdi-hover: #262a33; --jdi-pressed: rgba(255, 255, 255, .14);
      --jdi-divider: #2e333d; --jdi-panel-border: 1px solid #2e333d;
      --jdi-accent: #5b8cff; --jdi-accent-text: #0b0d12; --jdi-accent-hover: #7aa1ff;
      --jdi-badge-bg: #232c44; --jdi-badge-text: #5b8cff;
      --jdi-ok: #3ccf91; --jdi-err: #ff6b73; --jdi-focus: #5b8cff;
      --jdi-shadow: 0 12px 32px rgba(0, 0, 0, .5), 0 2px 6px rgba(0, 0, 0, .3);
      --jdi-toast-bg: #1c1f26; --jdi-toast-text: #eef0f4;
    }
    button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; text-align: left; }
    button:focus-visible { outline: 2px solid var(--jdi-focus); outline-offset: -2px; }

    /* [popover] and <dialog> bring UA styles (inset, margin, border, padding); reset them. */
    .panel {
      position: fixed; inset: auto; margin: 0; padding: 0;
      width: var(--jdi-width); max-width: calc(100vw - 16px);
      max-height: min(560px, calc(100vh - 16px));
      display: flex; flex-direction: column;
      color: var(--jdi-text); background: var(--jdi-surface);
      border: var(--jdi-panel-border); border-radius: var(--jdi-radius);
      box-shadow: var(--jdi-shadow); backdrop-filter: var(--jdi-blur);
      overflow: hidden;
      font: inherit; outline: none;
      animation: pop .12s ease-out;
    }
    .panel::backdrop { background: transparent; }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
    @media (prefers-reduced-motion: reduce) { .panel, .toast { animation: none; } .spinner { animation-duration: 2s; } }

    /*
     * Apple Music's menus are translucent glass over a backdrop blur. Where
     * there is no blur to be had, or the reader asked for more contrast, the
     * site itself goes solid, so we do too.
     */
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      .panel, .menu { background: var(--jdi-surface-solid); }
    }
    @media (prefers-contrast: more) {
      .panel, .menu { background: var(--jdi-surface-solid); backdrop-filter: none; }
    }

    .head {
      display: flex; align-items: center; gap: 10px; flex: none;
      padding: 10px calc(var(--jdi-pad-x) + 4px) 10px calc(var(--jdi-pad-x) + var(--jdi-item-px));
      border-bottom: 1px solid var(--jdi-divider);
    }
    .thumb { width: 36px; height: 36px; border-radius: var(--jdi-soft-radius); flex: none; object-fit: cover; background: var(--jdi-hover); }
    .thumb.icon { display: grid; place-items: center; color: var(--jdi-accent); }
    .titles { min-width: 0; flex: 1; }
    .app { font-size: var(--jdi-font-size-xs); color: var(--jdi-muted); letter-spacing: .02em; }
    .title { font-size: var(--jdi-title-size); font-weight: var(--jdi-title-weight); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tools { display: flex; gap: 2px; flex: none; }
    .close, .icon-btn { width: 30px; height: 30px; border-radius: var(--jdi-soft-radius); display: grid; place-items: center; color: var(--jdi-muted); flex: none; }
    .close:hover, .icon-btn:hover { background: var(--jdi-hover); color: var(--jdi-text); }
    .close:active, .icon-btn:active { background: var(--jdi-pressed); }

    .body { overflow-y: auto; overscroll-behavior: contain; padding: var(--jdi-pad-y) var(--jdi-pad-x); }
    .state { display: flex; gap: 10px; align-items: center; padding: 14px var(--jdi-item-px); color: var(--jdi-muted); }
    .state.error { color: var(--jdi-err); align-items: flex-start; }
    .spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--jdi-divider); border-top-color: var(--jdi-accent); animation: spin .8s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .notice { margin: 2px var(--jdi-item-px) 6px; padding: 8px 10px; border-radius: var(--jdi-soft-radius); background: var(--jdi-hover); font-size: var(--jdi-font-size-sm); }

    .strip { display: flex; gap: 6px; overflow-x: auto; padding: 2px var(--jdi-item-px) 8px; scrollbar-width: thin; }
    .chip { position: relative; width: 44px; height: 44px; flex: none; border-radius: var(--jdi-soft-radius); overflow: hidden; background: var(--jdi-hover); border: 2px solid transparent; display: grid; place-items: center; color: var(--jdi-muted); font-size: var(--jdi-font-size-sm); }
    .chip img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .chip[aria-pressed="true"] { border-color: var(--jdi-accent); }
    .chip .kind { position: absolute; right: 2px; bottom: 2px; background: rgba(0,0,0,.6); color: #fff; border-radius: 3px; font-size: 9px; padding: 0 3px; line-height: 13px; }

    .section { font-size: var(--jdi-font-size-xs); color: var(--jdi-muted); padding: 8px var(--jdi-item-px) 2px; text-transform: uppercase; letter-spacing: .05em; }
    .row {
      width: 100%; display: flex; align-items: center; gap: 10px;
      min-height: var(--jdi-item-h); padding: 6px var(--jdi-item-px);
      border-radius: var(--jdi-item-radius);
    }
    .row:hover { background: var(--jdi-hover); }
    .row:active { background: var(--jdi-pressed); }
    /* Apple Music rules a hairline between its menu rows; --jdi-row-line is 0 everywhere else. */
    .row + .row, .menu-item + .menu-item { border-top: var(--jdi-row-line); }
    .row .text { flex: 1; min-width: 0; }
    .row .label { font-weight: var(--jdi-weight); }
    .row .detail { color: var(--jdi-muted); font-size: var(--jdi-font-size-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badge { font-size: var(--jdi-font-size-xs); font-weight: 600; color: var(--jdi-badge-text); background: var(--jdi-badge-bg); border-radius: var(--jdi-badge-radius); padding: 2px 8px; flex: none; }
    .row .go { color: var(--jdi-muted); flex: none; display: grid; place-items: center; width: min(var(--jdi-icon), 18px); }
    .row .go svg { width: min(var(--jdi-icon), 18px); height: min(var(--jdi-icon), 18px); }
    .row.busy .go { color: var(--jdi-accent); }
    .row.done .go { color: var(--jdi-ok); }
    .row.failed .detail { color: var(--jdi-err); white-space: normal; }

    .foot { flex: none; border-top: 1px solid var(--jdi-divider); padding: 8px calc(var(--jdi-pad-x) + var(--jdi-item-px)); }
    .foot .error { color: var(--jdi-err); font-size: var(--jdi-font-size-sm); padding: 0 2px 8px; }
    .all {
      width: 100%; min-height: var(--jdi-btn-h); padding: 0 14px;
      display: flex; align-items: center; justify-content: center;
      border-radius: var(--jdi-btn-radius); background: var(--jdi-accent); color: var(--jdi-accent-text);
      font-size: var(--jdi-btn-size); font-weight: var(--jdi-btn-weight);
    }
    .all:hover, .more:hover { background: var(--jdi-accent-hover); }
    .all[disabled], .more[disabled] { opacity: .6; cursor: default; background: var(--jdi-accent); }

    /* Split button: "Download all N" + a right arrow that opens the menu. */
    .split { display: flex; }
    .split .all { flex: 1; min-width: 0; width: auto; border-radius: var(--jdi-btn-radius) 0 0 var(--jdi-btn-radius); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .more {
      flex: none; width: 42px; display: grid; place-items: center;
      border-radius: 0 var(--jdi-btn-radius) var(--jdi-btn-radius) 0;
      background: var(--jdi-accent); color: var(--jdi-accent-text);
      box-shadow: inset 1px 0 0 color-mix(in srgb, var(--jdi-accent-text) 30%, transparent);
    }
    .more svg { transition: transform .12s ease-out; }
    .more[aria-expanded="true"] svg { transform: rotate(-90deg); }
    .split button:focus-visible { outline: 2px solid var(--jdi-accent-text); outline-offset: -4px; }

    /* The menu is a popover of its own, so the panel's rounded corners don't clip it. */
    .menu {
      position: fixed; inset: auto; margin: 0; padding: var(--jdi-pad-y) var(--jdi-pad-x);
      width: max-content; min-width: 250px; max-width: min(340px, calc(100vw - 16px));
      color: var(--jdi-text); background: var(--jdi-surface);
      border: var(--jdi-panel-border); border-radius: var(--jdi-radius);
      /* The menu opens over the panel, which on most sites is the same surface.
         Where the site's own menus have no border, --jdi-menu-ring draws the
         hairline that keeps the two cards apart; elsewhere it is transparent. */
      box-shadow: var(--jdi-shadow), 0 0 0 1px var(--jdi-menu-ring);
      backdrop-filter: var(--jdi-blur);
      font: inherit; outline: none;
      /* Themes whose rows run edge to edge (YouTube, Instagram, Apple Music)
         rely on the card clipping them at its corners, the way the sites do. */
      overflow: hidden;
      animation: pop .1s ease-out;
    }
    .menu-item {
      width: 100%; display: flex; align-items: center; gap: 12px;
      min-height: var(--jdi-item-h); padding: 6px var(--jdi-item-px);
      border-radius: var(--jdi-item-radius);
    }
    .menu-item:hover, .menu-item:focus { background: var(--jdi-hover); outline: none; }
    .menu-item:active { background: var(--jdi-pressed); }
    .menu-item:focus-visible { box-shadow: inset 0 0 0 2px var(--jdi-focus); }
    .menu-item .icon { color: var(--jdi-muted); flex: none; display: grid; place-items: center; width: var(--jdi-icon); }
    .menu-item .icon svg { width: var(--jdi-icon); height: var(--jdi-icon); }
    .menu-item:hover .icon, .menu-item:focus .icon { color: var(--jdi-text); }
    .menu-item .text { flex: 1; min-width: 0; }
    .menu-item .label { font-weight: var(--jdi-weight); }
    .menu-item .detail { color: var(--jdi-muted); font-size: var(--jdi-font-size-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .menu-sep { height: 1px; background: var(--jdi-divider); margin: 4px 6px; }
    @media (prefers-reduced-motion: reduce) { .menu { animation: none; } .more svg { transition: none; } }

    .toasts {
      position: fixed; inset: auto 16px 16px auto; margin: 0; padding: 0; border: 0; background: transparent;
      overflow: visible; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none;
      color: var(--jdi-toast-text); font: inherit;
    }
    .toast {
      pointer-events: auto; max-width: min(360px, calc(100vw - 32px));
      display: flex; gap: 10px; align-items: center; padding: 10px 16px;
      border-radius: var(--jdi-toast-radius); background: var(--jdi-toast-bg); color: var(--jdi-toast-text);
      border: var(--jdi-panel-border); box-shadow: var(--jdi-shadow); backdrop-filter: var(--jdi-blur);
      animation: pop .12s ease-out;
    }
    .toast .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .55; flex: none; }
    .toast.success .dot { background: var(--jdi-ok); opacity: 1; }
    .toast.error .dot { background: var(--jdi-err); opacity: 1; }
    .toast .msg { min-width: 0; overflow-wrap: anywhere; }

    /*
     * X rounds every surface with a squircle; nobody else does, and older
     * Chrome has none. Last in the sheet, so it wins over the plain radii the
     * rules above set on the same elements.
     */
    @supports (corner-shape: squircle) {
      .panel, .menu { corner-shape: var(--jdi-corner-shape); border-radius: var(--jdi-radius-sq); }
      .toast { corner-shape: var(--jdi-corner-shape); }
      .row, .menu-item { corner-shape: var(--jdi-corner-shape); border-radius: var(--jdi-item-radius-sq); }
    }
  `;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ICONS = {
    download: ['M12 3v11m0 0 4.5-4.5M12 14 7.5 9.5M5 20h14'],
    close: ['M6 6l12 12M18 6 6 18'],
    check: ['M5 12.5 10 17.5 19 7'],
    chevron: ['m9 6 6 6-6 6'],
    zip: ['M4 8 6 4.5h12L20 8', 'M4 8h16v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z', 'M10 12h4'],
    mix: ['M4 11v2', 'M8 8v8', 'M12 5v14', 'M16 8v8', 'M20 11v2'],
    gear: [
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
    ],
  };

  function icon(name, size = 16, strokeWidth = 2) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', String(strokeWidth));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
    }
    return svg;
  }

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

  function showPopover(node) {
    try {
      if (!node.matches(':popover-open')) node.showPopover();
    } catch {
      /* not connected yet, or popovers unsupported: position:fixed still works */
    }
  }

  function hidePopover(node) {
    try {
      if (node.matches(':popover-open')) node.hidePopover();
    } catch {
      /* ignore */
    }
  }

  // Keydowns a control inside the picker already dealt with, so the panel-wide
  // key handling (rows, chips, Escape) leaves them alone.
  const handledKeys = new WeakSet();
  function claimKey(e) {
    e.preventDefault();
    handledKeys.add(e);
  }

  /** Content scripts can't open the options page themselves; the service worker does it. */
  function openSettings() {
    try {
      chrome.runtime.sendMessage({ type: 'jdi:open-settings' }).catch(() => {});
      return true;
    } catch {
      // chrome.runtime is gone: the extension was updated since this page loaded.
      toast('Just download it was updated. Reload this page to open its settings.', { kind: 'error' });
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // "Download all" texts (pure)
  // ---------------------------------------------------------------------------

  function isSong(variant) {
    return !!(variant && variant.job && (variant.job.type === 'song' || (variant.job.tags && variant.job.tags.title)));
  }

  /** The one file type every variant shares ('MP3'), or ''. */
  function sharedFormat(variants) {
    const formats = new Set(variants.map((v) => (JDI.util.normalizeExt(v.ext) || JDI.util.extFromUrl(v.url) || '?').toUpperCase()));
    return formats.size === 1 && !formats.has('?') ? Array.from(formats)[0] : '';
  }

  /** "Download all 12 as MP3" for songs, "Download all 4 · best quality" for everything else. */
  function allLabel(firsts) {
    if (firsts.length && firsts.every(isSong)) {
      const format = sharedFormat(firsts);
      return `Download all ${firsts.length}${format ? ` as ${format}` : ''}`;
    }
    return `Download all ${firsts.length} · best quality`;
  }

  function zipSummary(firsts) {
    if (firsts.every(isSong)) {
      const format = sharedFormat(firsts);
      return `${firsts.length} songs${format ? ` as ${format}` : ''} in one file`;
    }
    return `All ${firsts.length} in one file`;
  }

  /** "MP3 · 6 s crossfade · even volume", from the mix settings. */
  function mixSummary(settings) {
    const s = settings || {};
    const fade = Math.round(Number(s.mixCrossfade) || 0);
    return [
      s.mixFormat === 'm4a' ? 'M4A' : 'MP3',
      fade > 0 ? `${fade} s crossfade` : 'no crossfade',
      s.mixNormalize === false ? 'original volume' : 'even volume',
    ].join(' · ');
  }

  /** A ZIP is made by the extension, so it can't include files only the page itself may fetch. */
  function canZip(firsts) {
    return firsts.length > 1 && !firsts.some((v) => v.via === 'page' && !v.job);
  }

  // ---------------------------------------------------------------------------
  // Theme
  //
  // content/themes.js holds what each site's own menus were measured at. All
  // this file does is ask it for the current site and mode and write the
  // result onto .layer. If that file is ever missing (an extension update that
  // left an old manifest behind), the stylesheet's own neutral values stand in.
  // ---------------------------------------------------------------------------

  const registry = () => globalThis.JDI.themes || null;

  // The page button (or floating button) an open picker hangs off. A few
  // sites theme a region differently from the page around it -- Twitch's
  // player menus stay dark on a light page -- so the registry gets to see
  // where the picker is before it picks a mode.
  let themeAnchor = null;

  /*
   * Sites keep the control that opened a menu looking pressed for as long as
   * the menu is up -- Twitch's gear keeps its fill, Medal's buttons turn
   * green. Our button is a closed shadow root, so mark the host and let the
   * look's own `:host([data-open])` rule paint that state.
   */
  function markAnchorOpen(element, open) {
    if (!element || typeof element.setAttribute !== 'function') return;
    const tag = element.tagName;
    if (tag !== 'JDI-BUTTON' && tag !== 'JDI-FLOAT') return;
    try {
      if (open) element.setAttribute('data-open', '');
      else element.removeAttribute('data-open');
    } catch {
      /* the site tore the button out from under us */
    }
  }

  /** 'light' or 'dark' for this page, the way the site itself decides it. */
  function pageTheme() {
    const themes = registry();
    if (themes) return themes.mode();
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function paintTheme() {
    if (!layer) return;
    const themes = registry();
    if (themes) themes.applyTo(layer, themes.current(undefined, { anchor: themeAnchor }));
    else layer.setAttribute('data-theme', pageTheme());
  }

  // ---------------------------------------------------------------------------
  // Shared shadow host
  // ---------------------------------------------------------------------------

  let host = null;
  let layer = null;
  let toastBox = null;
  let current = null;
  let stopWatchingTheme = null;
  let lastOutsideClose = { node: null, time: 0 };

  function ensureHost() {
    if (host && host.isConnected) {
      paintTheme();
      return;
    }
    host = document.createElement('jdi-root');
    // Inline !important styles on the host beat any page rule that targets it.
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
      /* fall back to a <style> element below */
    }
    if (!styled) root.appendChild(el('style', { text: CSS }));

    layer = el('div', { class: 'layer' });
    toastBox = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite', popover: 'manual' });
    layer.appendChild(toastBox);
    root.appendChild(layer);
    (document.documentElement || document.body).appendChild(host);
    paintTheme();

    // Sites switch theme under an open picker (YouTube's appearance menu,
    // Twitch's toggle); repaint instead of sitting there in the old colours.
    const themes = registry();
    if (themes && !stopWatchingTheme) stopWatchingTheme = themes.observe(paintTheme);

    // Keep keystrokes typed in the picker away from the site (Instagram uses
    // arrow keys for carousels, YouTube uses almost every key). Stopped at the
    // host, after our own handlers ran.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      host.addEventListener(type, (e) => {
        if (type === 'keydown' && current) current._onKey(e);
        e.stopPropagation();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Picker
  // ---------------------------------------------------------------------------

  /**
   * Open the picker in a loading state.
   * @param anchor { x, y } (a right-click position) or { element } (a page button)
   * Returns a handle: { showLoading, showError, showResolution, close, closed }.
   */
  function open(anchor = {}) {
    if (current) current.close();
    themeAnchor = anchor.element || null;
    markAnchorOpen(themeAnchor, true);
    ensureHost();

    const previousFocus = anchor.element || document.activeElement;
    const blocking = document.fullscreenElement || document.querySelector('dialog:modal');

    const thumbSlot = el('div', { class: 'thumb icon' }, icon('download', 20));
    const titleEl = el('div', { class: 'title', text: 'Looking for downloads…' });
    const closeBtn = el('button', { class: 'close', type: 'button', 'aria-label': 'Close' }, icon('close', 16));
    const settingsBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Settings', title: 'Settings' }, icon('gear', 16, 1.8));
    const body = el('div', { class: 'body' });
    const foot = el('div', { class: 'foot', hidden: true });
    const children = [
      el(
        'div',
        { class: 'head' },
        thumbSlot,
        el('div', { class: 'titles' }, el('div', { class: 'app', text: 'Just download it' }), titleEl),
        el('div', { class: 'tools' }, settingsBtn, closeBtn),
      ),
      body,
      foot,
    ];
    // tabindex=-1 keeps focus inside the panel when a non-focusable part is clicked.
    const panel = blocking
      ? el('dialog', { class: 'panel', 'aria-label': 'Just download it', tabindex: '-1' }, ...children)
      : el('div', { class: 'panel', role: 'dialog', 'aria-label': 'Just download it', tabindex: '-1', popover: 'manual' }, ...children);
    layer.appendChild(panel);
    if (blocking) {
      try {
        panel.showModal();
      } catch {
        panel.setAttribute('open', '');
      }
    } else {
      showPopover(panel);
    }

    const handle = { closed: false, _thumb: thumbSlot, _focusedRow: null, _chips: null, _index: 0, _select: null, _finished: false, _menu: null };

    function viewport() {
      const vv = window.visualViewport;
      return vv
        ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
        : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }

    function place() {
      placePanel();
      if (handle._menu && handle._menu.isOpen()) handle._menu.place();
    }

    function placePanel() {
      const margin = 8;
      const gap = 8;
      const vp = viewport();
      panel.style.maxHeight = '';
      // Layout sizes, not getBoundingClientRect: the opening animation scales
      // the panel, which would make it measure smaller than it ends up.
      const measure = () => ({ width: panel.offsetWidth, height: panel.offsetHeight });
      let rect = measure();
      let left;
      let top;
      if (anchor.element && anchor.element.isConnected) {
        // Next to the button, never on top of it: below if it fits, else above,
        // else on the roomier side with the list scrolling.
        const a = anchor.element.getBoundingClientRect();
        const below = vp.top + vp.height - margin - (a.bottom + gap);
        const above = a.top - gap - (vp.top + margin);
        left = a.left;
        if (rect.height <= below) {
          top = a.bottom + gap;
        } else if (rect.height <= above) {
          top = a.top - gap - rect.height;
        } else {
          const room = Math.max(below, above, 160);
          panel.style.maxHeight = `${Math.floor(room)}px`;
          rect = measure();
          top = below >= above ? a.bottom + gap : a.top - gap - rect.height;
        }
        left = Math.min(Math.max(left, vp.left + margin), vp.left + vp.width - rect.width - margin);
        panel.style.left = `${Math.round(Math.max(left, vp.left))}px`;
        panel.style.top = `${Math.round(top)}px`;
        return;
      } else {
        const ax = Number.isFinite(anchor.x) ? anchor.x : vp.left + vp.width / 2 - rect.width / 2;
        const ay = Number.isFinite(anchor.y) ? anchor.y : vp.top + vp.height / 3;
        left = ax + 4;
        top = ay + 4;
        if (left + rect.width > vp.left + vp.width - margin) left = ax - rect.width - 4;
      }
      left = Math.min(Math.max(left, vp.left + margin), vp.left + vp.width - rect.width - margin);
      top = Math.min(Math.max(top, vp.top + margin), vp.top + vp.height - rect.height - margin);
      panel.style.left = `${Math.round(Math.max(left, vp.left))}px`;
      panel.style.top = `${Math.round(Math.max(top, vp.top))}px`;
    }

    function replaceThumb(url) {
      const fallback = () => el('div', { class: 'thumb icon' }, icon('download', 20));
      const next = url ? el('img', { class: 'thumb', alt: '', src: url }) : fallback();
      if (url) {
        next.addEventListener(
          'error',
          () => {
            const f = fallback();
            next.replaceWith(f);
            if (handle._thumb === next) handle._thumb = f;
          },
          { once: true },
        );
      }
      handle._thumb.replaceWith(next);
      handle._thumb = next;
    }

    function close() {
      if (handle.closed) return;
      handle.closed = true;
      window.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('keydown', onEscapeAnywhere, true);
      window.removeEventListener('resize', place);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', place);
      const hadFocus = document.activeElement === host;
      if (blocking) {
        try {
          panel.close();
        } catch {
          /* ignore */
        }
      } else {
        hidePopover(panel);
      }
      panel.remove();
      if (current === handle) current = null;
      // Toasts outlive the panel, and they belong to the page, not to
      // whatever the picker was anchored to.
      if (themeAnchor) {
        markAnchorOpen(themeAnchor, false);
        themeAnchor = null;
        paintTheme();
      }
      if (hadFocus && previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
        try {
          previousFocus.focus({ preventScroll: true });
        } catch {
          /* element gone */
        }
      }
    }

    function onOutside(e) {
      const path = e.composedPath();
      if (path.includes(panel)) {
        // A modal <dialog>'s backdrop reports the dialog itself as the target.
        if (blocking && path[0] === panel) {
          const r = panel.getBoundingClientRect();
          const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (!inside) close();
        }
        return;
      }
      if (path.includes(host)) return; // toasts
      lastOutsideClose = { node: path[0], time: Date.now(), path };
      close();
    }

    // Escape closes the picker even when focus has wandered back to the page.
    function onEscapeAnywhere(e) {
      if (e.key === 'Escape' && document.activeElement !== host) close();
    }

    function rows() {
      return Array.from(body.querySelectorAll('.row'));
    }

    function focusRow(row) {
      if (!row) return;
      handle._focusedRow = row;
      row.focus({ preventScroll: true });
    }

    // Keys pressed while focus is inside the picker (routed from the host).
    handle._onKey = (e) => {
      if (handledKeys.has(e)) return;
      if (e.key === 'Escape' && handle._menu && handle._menu.isOpen()) {
        // The first Escape only closes the Download all menu.
        e.preventDefault();
        handle._menu.close(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = rows();
        if (!list.length) return;
        e.preventDefault();
        // The shadow root is closed, so track the focused row ourselves.
        let i = list.indexOf(handle._focusedRow);
        i = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        focusRow(list[i]);
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && handle._chips && handle._chips.length > 1) {
        e.preventDefault();
        const n = handle._chips.length;
        handle._select(e.key === 'ArrowRight' ? (handle._index + 1) % n : (handle._index - 1 + n) % n, true);
      }
    };

    closeBtn.addEventListener('click', close);
    settingsBtn.addEventListener('click', () => {
      // The settings open in a new tab; the picker reads them again next time.
      if (openSettings()) close();
    });
    if (blocking) {
      panel.addEventListener('cancel', (e) => {
        e.preventDefault();
        close();
      });
    }
    // Defer so the click that opened the picker doesn't immediately close it.
    setTimeout(() => {
      if (!handle.closed) window.addEventListener('pointerdown', onOutside, true);
    }, 0);
    window.addEventListener('keydown', onEscapeAnywhere, true);
    window.addEventListener('resize', place);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', place);

    function showLoading(text) {
      body.replaceChildren(
        el('div', { class: 'state', role: 'status' }, el('div', { class: 'spinner' }), el('div', { text: text || 'Finding the best quality…' })),
      );
      foot.hidden = true;
      place();
    }

    function showError(message, title) {
      titleEl.textContent = title || 'Nothing to download';
      body.replaceChildren(el('div', { class: 'state error', role: 'alert' }, el('div', { text: message })));
      foot.hidden = true;
      place();
      closeBtn.focus({ preventScroll: true });
    }

    /**
     * @param resolution see the Resolution shape in shared/util.js
     * @param onDownload async ({ files, mode, all }) => { ok, error? }
     *                   mode: 'files' (each file on its own), 'zip' or 'mix' (one file
     *                   made from every item's first variant); all: from "Download all"
     * @param onSizes    optional async (variants) => Map<url, bytes>
     * @param settings   for the mix summary in the Download all menu
     */
    function showResolution(resolution, { onDownload, onSizes, settings } = {}) {
      const items = resolution.items;
      handle._index = Math.min(Math.max(resolution.focus || 0, 0), items.length - 1);

      const notice = resolution.notice ? el('div', { class: 'notice', text: resolution.notice }) : null;
      const list = el('div', { class: 'list' });
      let strip = null;
      handle._chips = null;

      if (items.length > 1) {
        strip = el('div', { class: 'strip', role: 'group', 'aria-label': 'Choose which one' });
        handle._chips = items.map((item, i) => {
          const chip = el('button', {
            class: 'chip',
            type: 'button',
            'aria-pressed': 'false',
            'aria-label': item.label || `Item ${i + 1}`,
            title: item.label || '',
            onclick: () => handle._select(i, false),
          });
          if (item.thumbnail) {
            const img = el('img', { alt: '', src: item.thumbnail, loading: 'lazy' });
            img.addEventListener('error', () => img.replaceWith(document.createTextNode(String(i + 1))), { once: true });
            chip.appendChild(img);
          } else {
            chip.textContent = String(i + 1);
          }
          if (item.variants[0] && item.variants[0].kind === 'video') chip.appendChild(el('span', { class: 'kind', text: 'VID' }));
          strip.appendChild(chip);
          return chip;
        });
      }

      body.replaceChildren(...[notice, strip, list].filter(Boolean));

      handle._menu = null;
      if (items.length > 1) {
        foot.replaceChildren(...downloadAllControls());
        foot.hidden = false;
      } else {
        foot.replaceChildren();
        foot.hidden = true;
      }

      /**
       * The footer's split button: "Download all N" saves each item's best
       * variant as its own file; the right arrow next to it opens a small menu
       * (one ZIP, one mix of the songs, Settings). The menu is keyboard driven
       * like a native one: arrows move, Enter picks, Escape or Left goes back.
       */
      function downloadAllControls() {
        const firsts = items.map((item) => item.variants[0]).filter(Boolean);
        const label = allLabel(firsts);
        const allBtn = el('button', { class: 'all', type: 'button', text: label, title: 'Save each one as its own file' });
        const moreBtn = el(
          'button',
          { class: 'more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More ways to download all', title: 'More ways to download all' },
          icon('chevron', 16),
        );
        const allError = el('div', { class: 'error', role: 'alert', hidden: true });
        const menu = el('div', { class: 'menu', role: 'menu', 'aria-label': 'Download all', popover: 'manual' });

        const choices = [];
        if (canZip(firsts)) choices.push({ mode: 'zip', icon: 'zip', label: 'Download as ZIP', detail: zipSummary(firsts) });
        if (JDI.util.canMix(resolution)) choices.push({ mode: 'mix', icon: 'mix', label: 'Combine into one mix', detail: mixSummary(settings) });

        const menuItems = [];
        const menuItem = (iconName, text, detail, onPick) => {
          const item = el(
            'button',
            { class: 'menu-item', type: 'button', role: 'menuitem', tabindex: '-1', title: detail || null },
            el('span', { class: 'icon' }, icon(iconName, 16, iconName === 'gear' ? 1.8 : 2)),
            el('span', { class: 'text' }, el('div', { class: 'label', text }), detail ? el('div', { class: 'detail', text: detail }) : null),
          );
          const index = menuItems.length;
          item.addEventListener('focus', () => {
            menuIndex = index;
          });
          item.addEventListener('click', onPick);
          menuItems.push(item);
          return item;
        };
        for (const choice of choices) menu.appendChild(menuItem(choice.icon, choice.label, choice.detail, () => start(choice.mode)));
        if (choices.length) menu.appendChild(el('div', { class: 'menu-sep', role: 'separator' }));
        menu.appendChild(
          menuItem('gear', 'Settings…', '', () => {
            closeMenu(false);
            if (openSettings()) close();
          }),
        );

        let menuOpen = false;
        let menuIndex = 0;

        function placeMenu() {
          const margin = 8;
          const vp = viewport();
          const a = moreBtn.getBoundingClientRect();
          const width = menu.offsetWidth;
          const height = menu.offsetHeight;
          // Above the button (it sits at the bottom of the panel), else below.
          let top = a.top - 6 - height;
          if (top < vp.top + margin) top = a.bottom + 6;
          top = Math.min(top, vp.top + vp.height - height - margin);
          const left = Math.min(Math.max(a.right - width, vp.left + margin), vp.left + vp.width - width - margin);
          menu.style.left = `${Math.round(Math.max(left, vp.left))}px`;
          menu.style.top = `${Math.round(Math.max(top, vp.top + margin))}px`;
        }

        function focusMenuItem(i) {
          const n = menuItems.length;
          menuIndex = ((i % n) + n) % n;
          menuItems[menuIndex].focus({ preventScroll: true });
        }

        function openMenu(focusIndex = 0) {
          if (menuOpen || moreBtn.disabled || handle._finished) return;
          menuOpen = true;
          showPopover(menu);
          moreBtn.setAttribute('aria-expanded', 'true');
          placeMenu();
          focusMenuItem(focusIndex);
        }

        function closeMenu(focusMore) {
          if (!menuOpen) return;
          menuOpen = false;
          hidePopover(menu);
          moreBtn.setAttribute('aria-expanded', 'false');
          if (focusMore) moreBtn.focus({ preventScroll: true });
        }

        async function start(mode) {
          if (allBtn.disabled || handle._finished) return;
          closeMenu(false);
          allBtn.disabled = true;
          moreBtn.disabled = true;
          allBtn.textContent = 'Starting…';
          allError.hidden = true;
          panel.focus({ preventScroll: true });
          const res = await onDownload({ files: firsts, mode, all: true });
          if (handle.closed) return;
          if (res && res.ok) {
            handle._finished = true;
            close();
          } else {
            allBtn.disabled = false;
            moreBtn.disabled = false;
            allBtn.textContent = label;
            allError.textContent = (res && res.error) || 'Something went wrong. Try again.';
            allError.hidden = false;
            place();
            (mode === 'files' ? allBtn : moreBtn).focus({ preventScroll: true });
          }
        }

        allBtn.addEventListener('click', () => start('files'));
        allBtn.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight') {
            claimKey(e);
            moreBtn.focus({ preventScroll: true });
          }
        });
        moreBtn.addEventListener('click', () => (menuOpen ? closeMenu(true) : openMenu(0)));
        moreBtn.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            claimKey(e);
            openMenu(e.key === 'ArrowUp' ? -1 : 0);
          } else if (e.key === 'ArrowLeft') {
            claimKey(e);
            closeMenu(false);
            allBtn.focus({ preventScroll: true });
          }
        });
        menu.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') {
            claimKey(e);
            focusMenuItem(menuIndex + 1);
          } else if (e.key === 'ArrowUp') {
            claimKey(e);
            focusMenuItem(menuIndex - 1);
          } else if (e.key === 'Home' || e.key === 'PageUp') {
            claimKey(e);
            focusMenuItem(0);
          } else if (e.key === 'End' || e.key === 'PageDown') {
            claimKey(e);
            focusMenuItem(-1);
          } else if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'Tab') {
            claimKey(e);
            closeMenu(true);
          } else if (e.key === 'ArrowRight') {
            claimKey(e); // don't switch items behind the menu
          }
        });
        // A click anywhere else in the picker closes the menu (outside it, the whole picker closes).
        panel.addEventListener('pointerdown', (e) => {
          if (!menuOpen) return;
          const path = e.composedPath();
          if (!path.includes(menu) && !path.includes(moreBtn)) closeMenu(false);
        });

        handle._menu = { isOpen: () => menuOpen, place: placeMenu, close: closeMenu };
        return [allError, el('div', { class: 'split' }, allBtn, moreBtn), menu];
      }

      handle._select = (index, focusChip) => {
        handle._index = index;
        const item = items[index];
        if (handle._chips) {
          handle._chips.forEach((c, i) => c.setAttribute('aria-pressed', String(i === index)));
          handle._chips[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        replaceThumb(item.thumbnail || '');
        const base = resolution.title || resolution.site || 'Download';
        titleEl.textContent = items.length > 1 && item.label ? `${base} · ${item.label}` : base;
        renderVariants(item);
        if (focusChip && handle._chips) handle._chips[index].focus({ preventScroll: true });
        place();
      };

      function detailText(v) {
        const size = v.size ? JDI.util.formatBytes(v.size) : '';
        return [v.detail || '', size].filter(Boolean).join(' · ');
      }

      function renderVariants(item) {
        const groups = new Map();
        for (const v of item.variants) {
          const g = v.group || '';
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(v);
        }
        const nodes = [];
        const details = new Map();
        let first = true;
        for (const [group, variants] of groups) {
          if (group) nodes.push(el('div', { class: 'section', text: group }));
          for (const v of variants) {
            const detail = el('div', { class: 'detail', text: detailText(v) });
            const go = el('span', { class: 'go' }, icon('download', 16));
            const row = el(
              'button',
              { class: 'row', type: 'button', title: v.hint ? String(v.hint) : null },
              el('div', { class: 'text' }, el('div', { class: 'label', text: v.label }), detail),
              first ? el('span', { class: 'badge', text: 'Best' }) : null,
              go,
            );
            first = false;
            row.addEventListener('focus', () => {
              handle._focusedRow = row;
            });
            row.addEventListener('click', async () => {
              // One download per picker: a double click or a held Enter key
              // must not save the same file twice.
              if (handle._finished || row.classList.contains('busy') || row.classList.contains('done')) return;
              row.classList.remove('failed');
              row.classList.add('busy');
              go.replaceChildren(el('div', { class: 'spinner' }));
              const res = await onDownload({ files: [v] });
              if (handle.closed) return;
              row.classList.remove('busy');
              if (res && res.ok) {
                handle._finished = true;
                row.classList.add('done');
                go.replaceChildren(icon('check', 16));
                setTimeout(close, 450);
              } else {
                row.classList.add('failed');
                go.replaceChildren(icon('download', 16));
                detail.textContent = (res && res.error) || 'Something went wrong. Try again.';
                place();
              }
            });
            details.set(v, detail);
            nodes.push(row);
          }
        }
        list.replaceChildren(...nodes);
        focusRow(list.querySelector('.row'));

        const wanted = onSizes ? item.variants.filter((v) => v.url && !v.size && !v.job && !v._probed).slice(0, 8) : [];
        if (!wanted.length) return;
        wanted.forEach((v) => {
          v._probed = true;
        });
        onSizes(wanted)
          .then((sizes) => {
            if (!sizes) return;
            for (const v of wanted) {
              const size = sizes.get(v.url);
              if (!size) continue;
              // Stored on the variant, so switching items and back keeps it.
              v.size = size;
              const detail = details.get(v);
              if (!handle.closed && detail && detail.isConnected && !detail.closest('.failed')) detail.textContent = detailText(v);
            }
          })
          .catch(() => {});
      }

      handle._select(handle._index, false);
    }

    Object.assign(handle, { showLoading, showError, showResolution, close });
    current = handle;
    showLoading();
    // Take focus right away so Escape and arrow keys don't reach the site while loading.
    panel.focus({ preventScroll: true });
    return handle;
  }

  /** True if a click on `node` just closed the picker (so a toggle button shouldn't reopen it). */
  function closedByClickOn(node, withinMs = 400) {
    return !!node && Date.now() - lastOutsideClose.time < withinMs && (lastOutsideClose.path || []).includes(node);
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------

  const toasts = new Map();
  let toastCounter = 0;

  /** Show or update a toast. kind: 'info' (stays until updated) | 'success' | 'error'. */
  function toast(text, { id, kind = 'info', timeout } = {}) {
    ensureHost();
    const key = id || `toast-${toastCounter++}`;
    let entry = toasts.get(key);
    if (!entry) {
      const msg = el('div', { class: 'msg' });
      const node = el('div', { class: 'toast' }, el('span', { class: 'dot' }), msg);
      toastBox.appendChild(node);
      entry = { node, msg, timer: 0 };
      toasts.set(key, entry);
    }
    showPopover(toastBox);
    entry.node.className = `toast ${kind}`;
    entry.node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    entry.msg.textContent = text;
    clearTimeout(entry.timer);
    // Info toasts are progress messages that get replaced; the long safety
    // timeout keeps one from lingering forever if the final update never comes.
    const ms = timeout != null ? timeout : kind === 'info' ? 30 * 60 * 1000 : kind === 'error' ? 8000 : 4000;
    entry.timer = setTimeout(() => dismiss(key), ms);
    return key;
  }

  function dismiss(key) {
    const entry = toasts.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.node.remove();
    toasts.delete(key);
    if (!toasts.size) hidePopover(toastBox);
  }

  function destroy() {
    if (current) current.close();
    if (host) host.remove();
    if (stopWatchingTheme) stopWatchingTheme();
    stopWatchingTheme = null;
    host = null;
    layer = null;
    toasts.clear();
  }

  JDI.picker = { open, toast, dismiss, destroy, closedByClickOn, pageTheme, openSettings };
})();
