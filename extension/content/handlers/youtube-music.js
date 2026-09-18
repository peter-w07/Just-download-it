/*
 * Just download it: YouTube Music handler (music.youtube.com).
 *
 * Everything is resolved by the service worker (background/resolvers/
 * youtube-music.js) from a clean music.youtube.com link:
 *  - a right-clicked song row, album/playlist card or link → that song, album or playlist
 *  - the player bar or the player page → the song that is playing
 *  - Download buttons: in the player bar (next to Like/Dislike), in album and
 *    playlist headers (next to Save/Play), and over the song on the player page.
 *
 * Which song is playing: on /watch the address says so. Elsewhere (the player
 * minimized while the queue moves on) the page itself doesn't show the id, so
 * this remembers the "docid" of YouTube Music's own playback-stats pings,
 * skipping ads.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const HOST = 'music.youtube.com';
  const ORIGIN = `https://${HOST}`;
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const LIST_ID = /^[A-Za-z0-9_-]{2,80}$/;

  // ---------------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------------

  /** A clean music.youtube.com link for a song, album, playlist or artist, or ''. */
  function musicLink(href) {
    let u;
    try {
      u = new URL(String(href || ''), ORIGIN);
    } catch {
      return '';
    }
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host !== HOST && host !== 'youtube.com') return '';
    const path = u.pathname.replace(/\/+$/, '');
    if (path === '/watch') {
      const v = u.searchParams.get('v') || '';
      // An album's playlist tells the resolver to prefer the album's audio track over a music video.
      const list = u.searchParams.get('list') || '';
      return VIDEO_ID.test(v) ? `${ORIGIN}/watch?v=${v}${/^OLAK5uy_[A-Za-z0-9_-]+$/.test(list) ? `&list=${list}` : ''}` : '';
    }
    if (path === '/playlist') {
      const list = u.searchParams.get('list') || '';
      return LIST_ID.test(list) ? `${ORIGIN}/playlist?list=${list}` : '';
    }
    if (host !== HOST) return '';
    let m = /^\/browse\/(MPREb_[A-Za-z0-9_-]+|VL[A-Za-z0-9_-]+)$/.exec(path);
    if (m) return `${ORIGIN}/browse/${m[1]}`;
    m = /^\/(?:channel|browse)\/(UC[A-Za-z0-9_-]{22})$/.exec(path);
    if (m) return `${ORIGIN}/channel/${m[1]}`;
    m = /^\/@[^/]{1,100}$/.exec(path);
    if (m) return `${ORIGIN}${path}`;
    return '';
  }

  function songLink(videoId) {
    if (!VIDEO_ID.test(String(videoId || ''))) return '';
    // Still on the watch page of that song: keep its album context.
    return videoId === watchIdFromAddress() ? musicLink(window.location.href) : `${ORIGIN}/watch?v=${videoId}`;
  }

  // ---------------------------------------------------------------------------
  // The song that is playing
  // ---------------------------------------------------------------------------

  let startedId = ''; // from "playback" pings, sent once when a song starts
  let seenId = ''; // from other pings, in case the start was missed
  let lastWatchId = '';

  function onStatsUrl(name) {
    if (typeof name !== 'string' || name.indexOf('/api/stats/') < 0 || name.indexOf('docid=') < 0) return;
    let u;
    try {
      u = new URL(name);
    } catch {
      return;
    }
    if (u.hostname !== HOST && !/(^|\.)youtube\.com$/.test(u.hostname)) return;
    if (u.searchParams.has('adformat') || u.searchParams.get('el') === 'adunit') return; // an ad
    const id = u.searchParams.get('docid') || '';
    if (!VIDEO_ID.test(id)) return;
    if (/\/api\/stats\/playback$/.test(u.pathname)) startedId = id;
    else if (/\/api\/stats\/watchtime$/.test(u.pathname)) seenId = id;
  }

  if (JDI.youtubeMusic && typeof JDI.youtubeMusic.stop === 'function') {
    try {
      JDI.youtubeMusic.stop(); // an older copy of this script (extension reloaded)
    } catch {
      /* ignore */
    }
  }
  let statsObserver = null;
  if (window.location.hostname === HOST && window.top === window && typeof PerformanceObserver === 'function') {
    try {
      statsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) onStatsUrl(entry.name);
      });
      statsObserver.observe({ type: 'resource', buffered: true });
    } catch {
      statsObserver = null;
    }
  }

  function watchIdFromAddress() {
    if (window.location.pathname !== '/watch') return '';
    const v = new URLSearchParams(window.location.search).get('v') || '';
    if (VIDEO_ID.test(v)) lastWatchId = v;
    return VIDEO_ID.test(v) ? v : '';
  }

  /** The video id of the song in the player, or ''. */
  function playingVideoId() {
    const fromAddress = watchIdFromAddress();
    if (fromAddress) return fromAddress;
    if (startedId || seenId) return startedId || seenId;
    // Music videos show their own thumbnail in the player bar.
    const img = document.querySelector('ytmusic-player-bar img.image');
    const m = img && /\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\//.exec(img.getAttribute('src') || '');
    return m ? m[1] : lastWatchId;
  }

  function playerHasSong() {
    const bar = document.querySelector('ytmusic-player-bar');
    const title = bar && bar.querySelector('.content-info-wrapper .title');
    return !!(title && title.textContent.trim());
  }

  // ---------------------------------------------------------------------------
  // Handler
  // ---------------------------------------------------------------------------

  const ROW = 'ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer, ytmusic-player-queue-item, ytmusic-card-shelf-renderer';
  const PLAYER_AREAS = 'ytmusic-player-bar, ytmusic-player, ytmusic-player-page #main-panel';

  /** The best link inside a row or card: its song first, then its album/playlist/artist. */
  function linkInside(container) {
    const links = Array.from(container.querySelectorAll('a[href]')).map((a) => musicLink(a.getAttribute('href')));
    return links.find((l) => l.includes('/watch?')) || links.find((l) => l.includes('/playlist?') || l.includes('/browse/')) || links.find(Boolean) || '';
  }

  /** What a right-click landed on. No network. */
  function snapshot({ stack, target }) {
    const nodes = (stack && stack.length ? stack : [target]).filter((n) => n && n.closest).slice(0, 20);
    for (const node of nodes) {
      const row = node.closest(ROW);
      if (row) {
        // Queue entries don't carry their video id; the playing one is the player's song.
        if (row.tagName.toLowerCase() === 'ytmusic-player-queue-item') {
          const playing = row.hasAttribute('selected') || row.getAttribute('play-button-state') === 'playing' || row.getAttribute('play-button-state') === 'paused';
          return playing ? { url: songLink(playingVideoId()), source: 'player' } : { url: '', source: '' };
        }
        const url = linkInside(row);
        if (url) return { url, source: 'row' };
      }
      const a = node.closest('a[href]');
      const url = a ? musicLink(a.getAttribute('href')) : '';
      if (url) return { url, source: 'link' };
    }
    const top = nodes[0];
    if (top && top.closest(PLAYER_AREAS) && (playerHasSong() || window.location.pathname === '/watch')) {
      const url = songLink(playingVideoId());
      if (url) return { url, source: 'player' };
    }
    return { url: '', source: '' };
  }

  /** "The main thing on this page", for a link opened from the toolbar popup. */
  function pageSnapshot() {
    if (window.location.pathname === '/watch') {
      const url = songLink(watchIdFromAddress());
      return url ? { url, source: 'page' } : null;
    }
    const url = musicLink(window.location.href);
    return url ? { url, source: 'page' } : null;
  }

  async function resolve(ctx) {
    const snap = ctx.snapshot || (ctx.page ? pageSnapshot() : snapshot(ctx)) || {};
    let url = snap.url || '';
    if (!url && ctx.info && ctx.info.linkUrl) url = musicLink(ctx.info.linkUrl);
    if (!url) {
      if (snap.source === 'player-button') {
        throw Object.assign(new Error('no song'), { userMessage: 'Couldn’t tell which song is playing. Open the player (click the song in the bar at the bottom) and try again.' });
      }
      return null; // let the generic handler look (an image, say)
    }
    return JDI.core.resolveLink(url);
  }

  util.registerHandler({
    id: 'youtube-music',
    name: 'YouTube Music',
    priority: 100,
    matches: (loc) => loc.hostname === HOST,
    snapshot,
    pageSnapshot,
    resolve,
  });

  // ---------------------------------------------------------------------------
  // Download buttons
  // ---------------------------------------------------------------------------

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function place(button, parent, before) {
    if (before === button) return; // already right there
    const ref = before && before.parentElement === parent ? before : null;
    if (button.parentElement !== parent || button.nextElementSibling !== ref) parent.insertBefore(button, ref);
  }

  function open(hostEl, snap) {
    JDI.core.openPicker({ handlerId: 'youtube-music', snapshot: snap, anchor: hostEl });
  }

  if (JDI.buttons && window.location.hostname === HOST) {
    JDI.buttons.register((api) => {
      const make = (look, title, onClick) => api.create({ look, label: 'Download', title, onClick });

      // 1. Player bar, after Like/Dislike: a 36px round button like them.
      const barButton = make('ytmusic-icon', 'Download this song', (hostEl) =>
        open(hostEl, { url: songLink(playingVideoId()), source: 'player-button' }),
      );
      // 2. Album and playlist headers, after Play, round like the Save and menu buttons beside it.
      const headerButton = make('ytmusic-header-icon', 'Download all songs', (hostEl) =>
        open(hostEl, { url: musicLink(window.location.href), source: 'button' }),
      );
      // 3. Player page: over the song's art/video, with YouTube Music's own buttons there.
      const pageButton = make('ytmusic-icon', 'Download this song', (hostEl) =>
        open(hostEl, { url: songLink(watchIdFromAddress() || playingVideoId()), source: 'player-button' }),
      );

      api.onChange(() => {
        watchIdFromAddress();

        // YouTube Music builds a second player bar and leaves the old one in the
        // page, empty and zero-sized. Always take the one actually on screen:
        // the stale one would read as "no Like button" and take this button away.
        const controls = Array.from(document.querySelectorAll('ytmusic-player-bar .middle-controls-buttons')).find(visible);
        const like = controls && controls.querySelector(':scope > ytmusic-like-button-renderer');
        // Like and Dislike go away while an ad plays, and so does this button.
        if (controls && (!like || visible(like))) {
          const menu = controls.querySelector(':scope > ytmusic-menu-renderer');
          place(barButton, controls, like ? like.nextElementSibling : menu);
        } else if (barButton.isConnected) barButton.remove();

        const listPage = /^\/(playlist|browse\/(MPREb_|VL))/.test(window.location.pathname) && musicLink(window.location.href);
        const row = listPage
          ? Array.from(document.querySelectorAll('ytmusic-responsive-header-renderer #action-buttons, ytmusic-detail-header-renderer .action-buttons, ytmusic-editable-playlist-detail-header-renderer .action-buttons')).find(visible)
          : null;
        if (row) {
          const menu = row.querySelector(':scope > ytmusic-menu-renderer');
          place(headerButton, row, menu);
          // Play carries a 32px margin on both sides; match it when the button
          // lands right after it, so the row keeps its even rhythm.
          const afterPlay = !!(headerButton.previousElementSibling && headerButton.previousElementSibling.matches('ytmusic-play-button-renderer'));
          if (afterPlay !== headerButton.hasAttribute('data-after-play')) headerButton.toggleAttribute('data-after-play', afterPlay);
        } else if (headerButton.isConnected) headerButton.remove();

        const onWatch = window.location.pathname === '/watch';
        const topRows = onWatch ? Array.from(document.querySelectorAll('ytmusic-player-page ytmusic-player #song-media-window .top-row-buttons')) : [];
        // Same here: a replaced player leaves its old row behind.
        const topRow = topRows.find(visible) || topRows[0] || null;
        if (topRow) place(pageButton, topRow, topRow.firstElementChild);
        else if (pageButton.isConnected) pageButton.remove();
      });
    });
  }

  JDI.youtubeMusic = {
    musicLink,
    snapshot,
    playingVideoId,
    stop() {
      if (statsObserver) statsObserver.disconnect();
    },
  };
})();
