/*
 * Just download it: Snapchat handler.
 *
 *  - Public Snapchat web pages (Spotlight, public profiles and their Stories,
 *    story.snapchat.com) are Next.js pages: #__NEXT_DATA__ holds every snap
 *    with its media link (snapUrls.mediaUrl, videoMetadata.contentUrl) and a
 *    preview image. The site navigates without reloading, so when the address
 *    changed since load the page is fetched again for fresh data.
 *  - The snap the user pointed at is matched by its video's link; otherwise
 *    the first snap is focused and the rest are offered alongside it.
 *  - Snapchat serves one quality per snap, from a public CDN (direct download).
 *  - Button: a hover button on videos.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  function isSnapchat(loc) {
    return /^(www\.|story\.)?snapchat\.com$/i.test(loc.hostname);
  }

  function snapshot({ x, y, stack, target }) {
    const media = JDI.dom.findMediaAt(stack || [], x, y);
    const video = media.find((m) => m.tagName === 'VIDEO') || (target && target.tagName === 'VIDEO' ? target : null);
    const img = media.find((m) => m.tagName === 'IMG');
    const src = video ? video.currentSrc || video.src : img ? img.currentSrc || img.src : '';
    return {
      mediaSrc: /^https:/i.test(src || '') ? src : '',
      poster: video && video.poster ? video.poster : '',
      element: video || img || null,
      pageUrl: window.location.href,
    };
  }

  function pathOf(url) {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  }

  /** Walk Next.js data and collect every snap-like object with a media link. */
  function collectSnaps(data) {
    const snaps = [];
    const seen = new Set();
    let username = '';
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 40) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      if (!username && typeof node.username === 'string') username = node.username;
      const urls = node.snapUrls || {};
      const video = node.videoMetadata || {};
      const media = [urls.mediaUrl, node.mediaUrl, video.contentUrl, node.contentUrl].find((u) => typeof u === 'string' && /^https:/i.test(u));
      if (media && !seen.has(media)) {
        seen.add(media);
        const preview = [urls.mediaPreviewUrl && urls.mediaPreviewUrl.value, urls.mediaPreviewUrl, node.mediaPreviewUrl, video.thumbnailUrl, node.thumbnailUrl].find(
          (u) => typeof u === 'string' && /^https:/i.test(u),
        );
        const type = node.snapMediaType != null ? Number(node.snapMediaType) : video.contentUrl || node.contentUrl ? 1 : null;
        snaps.push({
          url: media,
          preview: preview || '',
          isVideo: type === 1 || (type == null && /\.(mp4|mov|webm)(\?|$)/i.test(media)),
          id: String(node.snapId && node.snapId.value ? node.snapId.value : node.snapId || node.id || video.id || '').slice(0, 40),
          title: typeof video.name === 'string' ? video.name : typeof node.title === 'string' ? node.title : '',
          time: Number(node.timestampInSec && node.timestampInSec.value ? node.timestampInSec.value : node.timestampInSec) || 0,
        });
      }
      for (const key of Object.keys(node)) walk(node[key], depth + 1);
    };
    walk(data, 0);
    return { snaps, username };
  }

  function nextData(doc) {
    const script = doc.getElementById('__NEXT_DATA__');
    if (!script) return null;
    try {
      return JSON.parse(script.textContent);
    } catch {
      return null;
    }
  }

  async function loadData() {
    const nav = performance.getEntriesByType('navigation')[0];
    const fresh = !nav || nav.name === window.location.href;
    let data = fresh ? nextData(document) : null;
    if (data && collectSnaps(data).snaps.length) return data;
    try {
      const res = await fetch(window.location.href, { credentials: 'include', headers: { Accept: 'text/html' } });
      data = nextData(new DOMParser().parseFromString(await res.text(), 'text/html'));
    } catch {
      data = null;
    }
    return data;
  }

  function buildResolution({ snaps, username }, snap) {
    const wanted = pathOf(snap.mediaSrc);
    let focus = wanted ? snaps.findIndex((s) => pathOf(s.url) === wanted) : -1;
    if (focus < 0 && snap.poster) focus = snaps.findIndex((s) => s.preview && pathOf(s.preview) === pathOf(snap.poster));
    // A pasted link names its snap (ids are shortened to 40 characters when collected).
    if (focus < 0 && snap.focusId) {
      const id = snap.focusId;
      focus = snaps.findIndex((s) => s.id && s.id.length >= 8 && (id.startsWith(s.id) || s.id.startsWith(id)));
      if (focus < 0) focus = snaps.findIndex((s) => s.url.includes(id) || (s.preview && s.preview.includes(id)));
    }
    const multi = snaps.length > 1;
    const who = username || 'snapchat';
    const items = snaps.map((s, i) => {
      const ext = util.extFromUrl(s.url) || (s.isVideo ? 'mp4' : 'jpg');
      const filename = [who, s.time ? util.formatDate(s.time) : '', s.id || (multi ? String(i + 1) : 'snap')].filter(Boolean).join('_');
      const variants = [
        { kind: s.isVideo ? 'video' : 'image', label: 'Original', detail: [s.isVideo ? 'Video' : 'Photo', ext.toUpperCase()].join(' · '), url: s.url, ext, filename },
      ];
      if (s.preview && s.preview !== s.url) {
        variants.push({ kind: 'image', group: 'Other', label: 'Thumbnail', detail: (util.extFromUrl(s.preview) || 'jpg').toUpperCase(), url: s.preview, ext: util.extFromUrl(s.preview) || 'jpg', filename: `${filename}_thumbnail` });
      }
      const noun = s.isVideo ? 'Video' : 'Photo';
      return { label: multi ? `Snap ${i + 1} of ${snaps.length}` : s.title || noun, thumbnail: s.preview || (s.isVideo ? '' : s.url), variants };
    });
    return { site: 'Snapchat', title: username ? `@${username}` : 'Snapchat', focus: Math.max(focus, 0), items };
  }

  /**
   * The snap a pasted link names: /spotlight/<id>, /@user/spotlight/<id>,
   * /p/<story>/<snap>, /s/<id>. '' for profiles and story lists.
   */
  function snapIdFromPath(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    const at = parts.findIndex((p) => /^(spotlight|p|s|highlight|story)$/i.test(p));
    if (at < 0) return '';
    return parts[parts.length - 1] !== parts[at] ? parts[parts.length - 1] : '';
  }

  /** The page's snaps, focused on the one in the address (a pasted link). */
  function pageSnapshot() {
    return { mediaSrc: '', poster: '', element: null, pageUrl: window.location.href, focusId: snapIdFromPath(window.location.pathname), page: true };
  }

  async function resolve(ctx) {
    const snap = ctx.snapshot || snapshot(ctx);
    const data = await loadData();
    const collected = data ? collectSnaps(data) : { snaps: [], username: '' };
    if (collected.snaps.length) return buildResolution(collected, snap);
    if (ctx.page) {
      throw Object.assign(new Error('no data'), {
        userMessage: 'That Snapchat page has no public snaps to save. Snapchat only shares public Stories and Spotlight videos on the web.',
      });
    }

    // No page data: the element's own link still works for plain videos/images.
    if (snap.element) {
      const item = snap.element.tagName === 'VIDEO' ? JDI.generic.mediaItem(snap.element) : JDI.generic.imageItem(snap.element);
      if (item) return { site: 'Snapchat', title: 'Snapchat', focus: 0, items: [item] };
    }
    if (snap.mediaSrc || (snap.element && snap.element.tagName === 'VIDEO')) {
      throw Object.assign(new Error('no data'), { userMessage: 'Snapchat only shares public Stories and Spotlight videos on the web.' });
    }
    return null;
  }

  util.registerHandler({ id: 'snapchat', name: 'Snapchat', priority: 100, matches: isSnapchat, snapshot, pageSnapshot, pageGeneric: false, resolve });

  if (JDI.buttons && isSnapchat(window.location)) {
    JDI.buttons.register((api) => {
      // One more control in the player's top-right cluster: 10px in from the
      // edges and Snapchat's own 8px gap to the left of its mute button.
      api.hoverVideos({
        look: 'snapchat-overlay',
        size: 40,
        inset: 10,
        gap: 48,
        minWidth: 160,
        minHeight: 160,
        onClick: (video, hostEl) => {
          const snap = snapshot(api.centreOf(video));
          if (!snap.element) {
            snap.element = video;
            snap.mediaSrc = /^https:/i.test(video.currentSrc || '') ? video.currentSrc : '';
            snap.poster = video.poster || '';
          }
          JDI.core.openPicker({ handlerId: 'snapchat', snapshot: snap, anchor: hostEl });
        },
      });
    });
  }

  JDI.snapchat = { collectSnaps, buildResolution, snapshot };
})();
