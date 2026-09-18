/*
 * Just download it: Apple Music handler (music.apple.com).
 *
 *  - Apple Music's audio is DRM-protected and never downloaded. The service
 *    worker's apple-music resolver offers each song as MP3/M4A found on
 *    YouTube Music, plus the cover art and Apple's preview clip. This handler
 *    only works out which link the user means and asks the resolver.
 *  - Right-click: a song row (its song link, so just that song), any album,
 *    song, playlist or artist link, or else the page itself.
 *  - Buttons: a Download pill next to the Play/Preview and Shuffle buttons in
 *    album and playlist headers (checked against music.apple.com in September
 *    2026; the class names without Svelte's hash suffix are stable).
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const PATH = /^\/(?:[a-z]{2}\/)?(album|song|playlist|artist)\/(?:[^/]+\/)?([^/?#]+)/i;
  const ROW_SELECTOR = '[data-testid="track-list-item"], .songs-list-row';
  const HEADER_SELECTOR = '[data-testid="container-detail-header"], .container-detail-header';

  function isAppleMusic(loc) {
    return /^music\.apple\.com$/i.test(loc.hostname);
  }

  /**
   * A clean link the resolver understands (album, song, playlist or artist;
   * an album link keeps its ?i= song), or ''.
   */
  function supportedUrl(href) {
    let u;
    try {
      u = new URL(href, window.location.href);
    } catch {
      return '';
    }
    if (!isAppleMusic(u)) return '';
    const m = PATH.exec(u.pathname);
    if (!m) return '';
    const kind = m[1].toLowerCase();
    if (kind === 'playlist' ? !/^pl\.[\w-]+$/i.test(m[2]) : !/^\d{3,20}$/.test(m[2])) return '';
    const i = u.searchParams.get('i') || '';
    return `https://music.apple.com${u.pathname}${kind === 'album' && /^\d{3,20}$/.test(i) ? `?i=${i}` : ''}`;
  }

  function pageUrl() {
    return supportedUrl(window.location.href);
  }

  /** A song row: its own song link, or the page plus the song's title to focus. */
  function rowSnapshot(row) {
    for (const a of row.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/\/song\/|[?&]i=\d/.test(href)) {
        const url = supportedUrl(href);
        if (url) return { url };
      }
    }
    const titleEl = row.querySelector('[data-testid="track-title"]');
    const title = String((titleEl && titleEl.textContent) || row.getAttribute('aria-label') || '').trim();
    const page = pageUrl();
    return page ? { url: page, title } : null;
  }

  function snapshot({ stack, target }) {
    for (const node of (stack && stack.length ? stack : [target]).filter(Boolean).slice(0, 15)) {
      if (node.nodeType !== 1) continue;
      const row = node.closest(ROW_SELECTOR);
      if (row) {
        const snap = rowSnapshot(row);
        if (snap) return snap;
      }
      const link = node.closest('a[href]');
      const url = link ? supportedUrl(link.getAttribute('href')) : '';
      if (url) return { url };
    }
    const page = pageUrl();
    return page ? { url: page } : null;
  }

  /** Index of the item for a song title ("3. Title · Artist"), or -1. */
  function itemIndexForTitle(items, title) {
    const want = String(title || '').trim().toLowerCase();
    if (!want) return -1;
    const bare = (label) => String(label || '').replace(/^[\d-]+\.\s+/, '').toLowerCase();
    const exact = items.findIndex((item) => bare(item.label).split(' · ')[0] === want);
    return exact >= 0 ? exact : items.findIndex((item) => bare(item.label).startsWith(want));
  }

  async function resolve(ctx) {
    const snap = ctx.snapshot || (pageUrl() ? { url: pageUrl() } : null);
    if (!snap || !snap.url) return null;
    const resolution = await JDI.core.resolveLink(snap.url);
    if (!resolution) return null;
    if (snap.title && Array.isArray(resolution.items)) {
      const index = itemIndexForTitle(resolution.items, snap.title);
      if (index >= 0) return { ...resolution, focus: index };
    }
    return resolution;
  }

  util.registerHandler({
    id: 'apple-music',
    name: 'Apple Music',
    priority: 100,
    matches: isAppleMusic,
    snapshot,
    resolve,
    pageSnapshot: () => (pageUrl() ? { url: pageUrl() } : null),
  });

  // ---------------------------------------------------------------------------
  // Download button in album and playlist headers
  // ---------------------------------------------------------------------------

  /**
   * Album and playlist pages are tinted by the cover art, not by the operating
   * system: Apple Music puts the layout it chose on the header and on the app
   * container, and it changes as you move between pages. Light text on the
   * header is the fallback when neither class is there.
   */
  function isDark(element) {
    const header = element.closest('[class*="container-detail-header"]') || element;
    if (header.className && /container-detail-header--dark-layout/.test(header.className)) return true;
    if (header.className && /container-detail-header--light-layout/.test(header.className)) return false;
    const app = element.closest('.app-container') || document.querySelector('.app-container');
    if (app && app.classList.contains('is-dark-theme')) return true;
    if (app && app.classList.contains('is-light-theme')) return false;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(element).color || '');
    if (!m) return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]) > 128;
  }

  if (JDI.buttons && typeof document !== 'undefined' && isAppleMusic(window.location)) {
    JDI.buttons.register((api) => {
      let button = null;
      api.onChange(() => {
        const url = pageUrl();
        const header = url && /\/(album|playlist)\//.test(url) ? document.querySelector(HEADER_SELECTOR) : null;
        const play = header && header.querySelector('.primary-actions__button--play, [data-testid="button-action"]');
        const row = header && (header.querySelector('.primary-actions') || (play && play.parentElement));
        if (!row) {
          if (button && button.isConnected) button.remove();
          return;
        }
        if (!button) {
          button = api.create({
            look: 'apple-music-pill',
            label: 'Download',
            title: 'Download these songs',
            theme: (hostEl) => (isDark(hostEl.parentElement || hostEl) ? 'dark' : 'light'),
            onClick: (hostEl) => JDI.core.openPicker({ handlerId: 'apple-music', snapshot: { url: pageUrl() }, anchor: hostEl }),
          });
        }
        // Right after Play/Preview and Shuffle (Shuffle is an empty slot when
        // signed out). The row is a grid that orders its slots with CSS `order`,
        // so the button takes the order of the last of them and sits after it.
        const slots = Array.from(row.children).filter((c) => c !== button);
        const buttons = slots.filter(
          (c) => c.childElementCount && (c.classList.contains('primary-actions__button--play') || c.classList.contains('primary-actions__button--shuffle') || c.contains(play)),
        );
        const orderOf = (el) => Number(getComputedStyle(el).order) || 0;
        const after = buttons.reduce((last, c) => (!last || orderOf(c) >= orderOf(last) ? c : last), null);
        if (button.parentElement !== row || (after && button.previousElementSibling !== after)) {
          row.insertBefore(button, after ? after.nextSibling : row.firstChild);
        }
        const order = after ? String(orderOf(after)) : '';
        if (button.style.order !== order) button.style.order = order;
        if (button.style.marginRight !== '0px') button.style.marginRight = '0px'; // the row's own 12px gap spaces it
      });
    });
  }

  JDI.appleMusic = { supportedUrl, snapshot, itemIndexForTitle };
})();
