/*
 * Just download it: Medal (medal.tv) handler.
 *
 *  - Every Medal clip link carries the clip id: /games/{game}/clips/{id}/{slug},
 *    /games/{game}/clip/{id} (the embed player), /clips/{id}, /clip/{id},
 *    /u/{user}/clips/{id}, the same with a language prefix (/de/games/…), and
 *    ?contentId={id} on any page. Share links (?invite=…) are the same paths.
 *  - The clip itself is resolved by the service worker (background/resolvers/
 *    medal.js) from Medal's public clip page, so the page button, the right-click
 *    menu and a pasted link all give the same qualities.
 *  - What was clicked: a clip link or card (Medal's grid cards are
 *    #…clip-card-{id}-{n}), the clip player (video#{id}-player), or the clip page
 *    itself.
 *  - Buttons: a Download button in the clip's action row (like, share, copy,
 *    more) and a hover button on clip videos.
 *
 * Also imported by the service worker for clipIdFromUrl(), so nothing here may
 * touch the page unless JDI.buttons exists.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const ID = '[A-Za-z0-9_-]{5,40}';
  const ID_ONLY = new RegExp(`^${ID}$`);
  // Optional language prefix (/de, /zh-Hans), optional /games/{game} or /u/{user}, then /clip(s)/{id}.
  const CLIP_PATH = new RegExp(`^(?:/[a-z]{2}(?:-[A-Za-z]{2,4})?)?(?:/games/[^/]+|/u/[^/]+)?/clips?/(${ID})(?:/|$)`);
  const PLAYER_ID = new RegExp(`^(${ID}?)(?:-player)+$`);
  const CARD_ID = new RegExp(`clip-card-(${ID})-[0-9]+$`);

  function isMedalHost(hostname) {
    return /^(www\.)?medal\.tv$/i.test(String(hostname || ''));
  }

  function isMedal(loc) {
    return isMedalHost(loc.hostname);
  }

  /** The clip id in any Medal clip link, or ''. */
  function clipIdFromUrl(href) {
    let u;
    try {
      u = new URL(String(href), 'https://medal.tv/');
    } catch {
      return '';
    }
    if (!isMedalHost(u.hostname)) return '';
    const param = u.searchParams.get('contentId') || '';
    if (ID_ONLY.test(param)) return param;
    const m = CLIP_PATH.exec(u.pathname);
    return m ? m[1] : '';
  }

  function clipUrl(id) {
    return `https://medal.tv/clips/${encodeURIComponent(id)}`;
  }

  /** The clip an element belongs to (a link, a grid card or the player), or ''. */
  function clipFromElement(element) {
    let depth = 0;
    for (let node = element; node && node.nodeType === 1 && depth < 25; node = node.parentElement, depth++) {
      if (node.tagName === 'A' && node.href) {
        const id = clipIdFromUrl(node.href);
        if (id) return id;
      }
      const own = typeof node.id === 'string' ? node.id : '';
      if (own) {
        const m = PLAYER_ID.exec(own) || CARD_ID.exec(own);
        if (m && ID_ONLY.test(m[1])) return m[1];
      }
    }
    return '';
  }

  function snapshot({ stack, target }) {
    const nodes = (stack && stack.length ? stack : [target]).filter(Boolean).slice(0, 12);
    for (const node of nodes) {
      const id = clipFromElement(node);
      if (id) return { id };
    }
    // A video on a clip page that isn't inside another clip's card: this clip.
    const video = nodes.find((n) => n.tagName === 'VIDEO');
    const pageId = clipIdFromUrl(window.location.href);
    if (video && pageId) return { id: pageId };
    return { id: '', element: video || null };
  }

  async function resolve(ctx) {
    const snap = ctx.snapshot || snapshot(ctx);
    let id = snap && snap.id;
    if (!id && ctx.info && ctx.info.linkUrl) id = clipIdFromUrl(ctx.info.linkUrl);
    if (!id && ctx.page) id = clipIdFromUrl(window.location.href);
    if (!id) {
      // A video that isn't a clip (Medal's own promo videos): save it as it plays.
      const el = snap && snap.element;
      if (el && el.tagName === 'VIDEO' && JDI.generic) {
        const item = JDI.generic.mediaItem(el);
        if (item) return { site: 'Medal', title: 'Medal', focus: 0, items: [item] };
      }
      return null;
    }
    return JDI.core.resolveLink(clipUrl(id));
  }

  function pageSnapshot() {
    const id = clipIdFromUrl(window.location.href);
    return id ? { id } : null;
  }

  util.registerHandler({ id: 'medal', name: 'Medal', priority: 100, matches: isMedal, snapshot, resolve, pageSnapshot });

  // ---------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------

  /** The clip whose player sits near an element (the action row under it), else the page's clip. */
  function clipNear(element) {
    let depth = 0;
    for (let node = element; node && node.nodeType === 1 && depth < 10; node = node.parentElement, depth++) {
      const player = node.querySelector('video[id$="-player"]');
      const m = player ? PLAYER_ID.exec(player.id) : null;
      if (m && ID_ONLY.test(m[1])) return m[1];
    }
    return clipIdFromUrl(window.location.href);
  }

  if (JDI.buttons && typeof window !== 'undefined' && isMedal(window.location)) {
    JDI.buttons.register((api) => {
      api.onChange(() => {
        // The action row under a clip: like, share, copy link, more.
        for (const icon of document.querySelectorAll('[data-shape="share"]')) {
          const trigger = icon.closest('button');
          const slot = trigger && trigger.parentElement;
          const row = slot && slot.parentElement;
          if (!row || !row.querySelector('[data-shape="like"]') || row.querySelector(':scope > [data-jdi-medal]')) continue;
          if (!clipNear(row)) continue;
          const button = api.create({
            look: 'medal-action',
            label: 'Download',
            title: 'Download',
            onClick: (hostEl) => {
              const id = clipNear(hostEl);
              if (id) JDI.core.openPicker({ handlerId: 'medal', snapshot: { id }, anchor: hostEl });
            },
          });
          button.setAttribute('data-jdi-medal', '');
          // The row's own 8px gap spaces it next to share and copy link.
          const more = row.lastElementChild && row.lastElementChild.querySelector('[data-shape="kebab"]') ? row.lastElementChild : null;
          row.insertBefore(button, more);
        }
      });
      api.hoverVideos({
        look: 'medal-overlay',
        size: 36,
        minWidth: 240,
        minHeight: 130,
        onClick: (video, hostEl) => {
          let snap = { id: clipFromElement(video) };
          if (!snap.id) snap = snapshot(api.centreOf(video));
          if (!snap.id && !snap.element) snap.element = video;
          JDI.core.openPicker({ handlerId: 'medal', snapshot: snap, anchor: hostEl });
        },
      });
    });
  }

  JDI.medal = { clipIdFromUrl, clipUrl, clipFromElement, snapshot };
})();
