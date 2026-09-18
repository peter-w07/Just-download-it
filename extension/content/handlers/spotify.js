/*
 * Just download it: Spotify handler.
 *
 * Spotify's audio is DRM-protected, so nothing is taken from the player. The
 * service worker's Spotify resolver (background/resolvers/spotify.js) reads
 * Spotify's public embed data and offers the full song from YouTube Music
 * (MP3/M4A), the cover art and the 30-second preview. This file only works
 * out which Spotify link the user means:
 *  - Right-click: the link, track row or card under the cursor, otherwise the
 *    page itself when it is a track, album, playlist or artist (or an embed).
 *  - Toolbar popup: pageSnapshot() names the page's own link.
 *  - Buttons: a "Download" pill next to the big play button on those pages,
 *    and an icon in the now-playing bar for the song that's playing.
 *
 * Checked against open.spotify.com in September 2026 (data-testid
 * "action-bar-row", "play-button", "tracklist-row", "now-playing-widget").
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  // /track/<id>, /intl-de/album/<id>, /embed/playlist/<id>, /user/<name>/playlist/<id>
  const ENTITY_PATH = /^\/(?:intl-[a-z]{2}(?:-[a-z0-9]{2,4})?\/)?(?:embed\/)?(?:user\/[^/]+\/)?(track|album|playlist|artist)\/([A-Za-z0-9]{22})(?:\/|$)/i;
  const HIGHLIGHT = /^spotify:track:([A-Za-z0-9]{22})$/;
  const ROW_SELECTOR = '[data-testid="tracklist-row"], [role="row"]';
  const CARD_SELECTOR = '[data-encore-id="card"], [data-testid$="-card"]';

  function isSpotify(loc) {
    return loc.hostname === 'open.spotify.com';
  }

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------

  /**
   * { type, id } for a Spotify URL or path, or null. Links that highlight a
   * track inside an album (the now-playing title) count as that track.
   */
  function entityFromHref(href) {
    let u;
    try {
      u = new URL(String(href || ''), 'https://open.spotify.com/');
    } catch {
      return null;
    }
    if (u.hostname !== 'open.spotify.com') return null;
    const highlight = HIGHLIGHT.exec(u.searchParams.get('highlight') || '');
    if (highlight) return { type: 'track', id: highlight[1] };
    const m = ENTITY_PATH.exec(u.pathname);
    return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
  }

  function linkFor(entity) {
    return `https://open.spotify.com/${entity.type}/${entity.id}`;
  }

  /** The Spotify entity an element stands for: its link, its track row or its card. */
  function entityAt(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || typeof el.closest !== 'function') return null;
    const link = el.closest('a[href]');
    const linked = link && entityFromHref(link.getAttribute('href'));
    if (linked) return linked;
    const row = el.closest(ROW_SELECTOR);
    if (row) {
      for (const a of row.querySelectorAll('a[href*="/track/"], a[href*="highlight="]')) {
        const found = entityFromHref(a.getAttribute('href'));
        if (found && found.type === 'track') return found;
      }
    }
    const card = el.closest(CARD_SELECTOR);
    if (card) {
      for (const a of card.querySelectorAll('a[href]')) {
        const found = entityFromHref(a.getAttribute('href'));
        if (found) return found;
      }
    }
    return null;
  }

  /** The page's own entity (address bar), ignoring highlights. */
  function pageEntity() {
    const m = ENTITY_PATH.exec(window.location.pathname);
    return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
  }

  // ---------------------------------------------------------------------------
  // Handler
  // ---------------------------------------------------------------------------

  function snapshot({ stack, target } = {}) {
    for (const node of (stack && stack.length ? stack : [target]).filter(Boolean).slice(0, 15)) {
      const found = entityAt(node);
      if (found) return { url: linkFor(found) };
    }
    const page = pageEntity();
    return page ? { url: linkFor(page) } : null;
  }

  function pageSnapshot() {
    const page = pageEntity();
    return page ? { url: linkFor(page) } : null;
  }

  /** Same song? Case, accents, punctuation and "(feat. …)" don't matter. */
  function sameTitle(a, b) {
    const clean = (t) =>
      String(t || '')
        .normalize('NFKD')
        .replace(/[([](?:feat|ft|with)\.?\s[^)\]]*[)\]]/gi, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
    return !!clean(a) && clean(a) === clean(b);
  }

  /**
   * The song in the now-playing bar: its album (or other context) is resolved,
   * and just that song is kept. Spotify links the playing title to its album,
   * without saying which track it is.
   */
  async function resolveNowPlaying(snap) {
    const resolution = await JDI.core.resolveLink(snap.url);
    if (!resolution || !Array.isArray(resolution.items)) return resolution;
    const index = resolution.items.findIndex((item) => {
      const v = (item.variants || []).find((x) => x.job && x.job.tags && x.job.tags.title);
      const title = v ? v.job.tags.title : String(item.label || '').replace(/^\d+\.\s*/, '').split(' · ')[0];
      return sameTitle(title, snap.title);
    });
    if (index < 0) return { ...resolution, notice: resolution.notice || `Couldn’t find “${snap.title}” on its album, so the whole album is shown.` };
    return { ...resolution, title: snap.title, focus: 0, notice: undefined, collection: undefined, items: [resolution.items[index]] };
  }

  async function resolve(ctx) {
    let snap = ctx.snapshot || snapshot(ctx);
    if (snap && snap.nowPlaying && snap.title) return resolveNowPlaying(snap);
    if (!snap && ctx.info && ctx.info.linkUrl) {
      const linked = entityFromHref(ctx.info.linkUrl);
      if (linked) snap = { url: linkFor(linked) };
    }
    if (!snap || !snap.url) return null;
    return JDI.core.resolveLink(snap.url);
  }

  util.registerHandler({ id: 'spotify', name: 'Spotify', priority: 100, matches: isSpotify, snapshot, resolve, pageSnapshot });

  // ---------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------

  /** The direct child of `parent` that contains `node`. */
  function childOf(parent, node) {
    let el = node;
    while (el && el.parentElement !== parent) el = el.parentElement;
    return el || null;
  }

  /**
   * The song in the now-playing bar (logged in), as a snapshot, or null.
   * The title usually links to the song's album with no track id
   * (data-testid "context-item-link"), so the title travels along and the
   * song is picked out of the album when resolving.
   */
  function nowPlaying(widget) {
    for (const a of widget.querySelectorAll('a[href]')) {
      const found = entityFromHref(a.getAttribute('href'));
      if (found && found.type === 'track') return { url: linkFor(found) };
    }
    const titleLink = widget.querySelector('[data-testid="context-item-link"]') || widget.querySelector('a[href*="/album/"]');
    const context = titleLink && entityFromHref(titleLink.getAttribute('href'));
    const title = titleLink ? (titleLink.textContent || '').trim() : '';
    if (!context || !title || (context.type !== 'album' && context.type !== 'playlist')) return null;
    return { url: linkFor(context), nowPlaying: true, title };
  }

  if (JDI.buttons && isSpotify(window.location)) {
    JDI.buttons.register((api) => {
      let pill = null;
      let barButton = null;

      const placePill = () => {
        const page = pageEntity();
        const rows = page ? document.querySelectorAll('[data-testid="action-bar-row"]') : [];
        const row = Array.from(rows).find((r) => r.closest('main')) || rows[0] || null;
        if (!row) {
          if (pill && pill.isConnected) pill.remove();
          return;
        }
        if (!pill) {
          pill = api.create({
            look: 'spotify-pill',
            label: 'Download',
            title: 'Download as MP3, or save the cover art',
            onClick: (hostEl) => {
              const current = pageEntity();
              if (current) JDI.core.openPicker({ handlerId: 'spotify', snapshot: { url: linkFor(current) }, anchor: hostEl });
            },
          });
        }
        const play = row.querySelector('[data-testid="play-button"]');
        const after = play ? childOf(row, play) : null;
        const reference = after ? after.nextSibling : row.firstChild;
        if (pill.parentElement !== row || (reference !== pill && pill.nextSibling !== reference)) {
          row.insertBefore(pill, reference);
          // Spotify spaces the action bar with a right margin on each child.
          const gap = after ? getComputedStyle(after).marginRight : '';
          pill.style.margin = `0 ${gap && gap !== '0px' ? gap : '24px'} 0 0`;
        }
      };

      // Bottom left, next to the playing song's "Add to Liked Songs" (+) button.
      const placeBarButton = () => {
        const widget = document.querySelector('[data-testid="now-playing-widget"]');
        const song = widget ? nowPlaying(widget) : null;
        if (!song) {
          if (barButton && barButton.isConnected) barButton.remove();
          return;
        }
        if (!barButton) {
          barButton = api.create({
            look: 'spotify-icon',
            label: 'Download',
            title: 'Download this song',
            onClick: (hostEl) => {
              const w = document.querySelector('[data-testid="now-playing-widget"]');
              const current = w ? nowPlaying(w) : null;
              if (current) JDI.core.openPicker({ handlerId: 'spotify', snapshot: current, anchor: hostEl });
            },
          });
        }
        const add = widget.querySelector('button[aria-label*="Liked Songs"], button[aria-label*="playlist" i], [data-testid="add-button"]');
        const box = add && add.parentElement && widget.contains(add.parentElement) && add.parentElement !== widget ? add.parentElement : widget;
        if (barButton.parentElement !== box) box.appendChild(barButton);
      };

      api.onChange(() => {
        placePill();
        placeBarButton();
      });
    });
  }

  JDI.spotify = { entityFromHref, entityAt, snapshot, pageSnapshot };
})();
