/*
 * Just download it: Facebook handler.
 *
 *  - The video id comes from a link in the post (/watch/?v=<id>, /reel/<id>,
 *    /videos/<id>, video.php?v=<id>) or the address bar (reels viewer, watch page).
 *  - The links come from Facebook's own data, searched near that id:
 *    browser_native_hd_url / browser_native_sd_url (MP4s with sound) and DASH
 *    representations (sharper video-only tracks plus an audio track, combined
 *    on this computer). Sources, in order: responses captured by
 *    main/facebook-hook.js (feed and reels load videos that way), the page's
 *    JSON scripts, then the video's own page fetched with the user's session.
 *  - fbcdn links are signed, so they download directly.
 *  - Button: a hover button on videos (Facebook's markup is obfuscated and
 *    translated, so nothing depends on class names or labels).
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const VIDEO_URL = [
    /[?&]v=(\d{6,25})/, // /watch/?v=, video.php?v=
    /\/reels?\/(\d{6,25})/,
    /\/videos\/(?:[^/?#]+\/)?(\d{6,25})/,
  ];
  const NEAR = 60000; // how far (in characters) data may sit from the id

  function isFacebook(loc) {
    return /^(www\.|web\.|m\.)?facebook\.com$/i.test(loc.hostname);
  }

  function idFromHref(href) {
    let u;
    try {
      u = new URL(String(href || ''), window.location.href);
    } catch {
      return '';
    }
    if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return '';
    const path = u.pathname + u.search;
    for (const re of VIDEO_URL) {
      const m = re.exec(path);
      if (m) return m[1];
    }
    return '';
  }

  const POST = '[role="article"], [aria-posinset], [data-pagelet^="FeedUnit"], [data-virtualized]';

  function idFrom(element) {
    const start = element && element.nodeType === 1 ? element : null;
    if (!start) return '';
    const link = start.closest('a[href]');
    const fromLink = link && idFromHref(link.getAttribute('href'));
    if (fromLink) return fromLink;
    const post = start.closest(POST);
    if (post) {
      for (const a of post.querySelectorAll('a[href]')) {
        const id = idFromHref(a.getAttribute('href'));
        if (id) return id;
      }
    }
    return '';
  }

  function snapshot({ stack, target }) {
    for (const node of (stack && stack.length ? stack : [target]).filter(Boolean).slice(0, 12)) {
      const id = idFrom(node);
      if (id) return { videoId: id };
    }
    return { videoId: idFromHref(window.location.href) };
  }

  // ---------------------------------------------------------------------------
  // Finding links for a video id in Facebook's data
  // ---------------------------------------------------------------------------

  const captured = []; // response texts from facebook-hook.js, newest last
  let capturedSize = 0;
  document.addEventListener('jdi:facebook-data', (event) => {
    const text = event.detail;
    if (typeof text !== 'string') return;
    captured.push(text);
    capturedSize += text.length;
    while (captured.length > 1 && (captured.length > 40 || capturedSize > 40 * 1024 * 1024)) capturedSize -= captured.shift().length;
  });

  function decode(raw) {
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return '';
    }
  }

  function idPositions(text, id) {
    const out = [];
    let at = text.indexOf(id);
    while (at >= 0 && out.length < 500) {
      // Only whole ids (not part of a longer number).
      if (!/\d/.test(text[at - 1] || '') && !/\d/.test(text[at + id.length] || '')) out.push(at);
      at = text.indexOf(id, at + id.length);
    }
    return out;
  }

  function distance(positions, index) {
    let best = Infinity;
    for (const p of positions) best = Math.min(best, Math.abs(p - index));
    return best;
  }

  /** Everything we can find about one video in one blob of Facebook data. */
  function scan(text, id) {
    const positions = idPositions(text, id);
    if (!positions.length) return null;
    const result = { hd: null, sd: null, reps: [], thumbnail: null, title: null, owner: null };

    const keep = (slot, url, index, extra = {}) => {
      const d = distance(positions, index);
      if (d > NEAR || !/^https:\/\/[^/]*(fbcdn\.net|facebook\.com)\//i.test(url)) return;
      if (!result[slot] || d < result[slot].d) result[slot] = { url, d, ...extra };
    };

    for (const m of text.matchAll(/"(browser_native_hd_url|playable_url_quality_hd|hd_src|browser_native_sd_url|playable_url|sd_src)":"((?:[^"\\]|\\.)*)"/g)) {
      const url = decode(m[2]);
      if (!url) continue;
      keep(/hd/.test(m[1]) ? 'hd' : 'sd', url, m.index);
    }

    for (const m of text.matchAll(/\{[^{}]*"base_url":"(?:[^"\\]|\\.)*"[^{}]*\}/g)) {
      let rep;
      try {
        rep = JSON.parse(m[0]);
      } catch {
        continue;
      }
      const d = distance(positions, m.index);
      if (d > NEAR || !/^https:/i.test(rep.base_url || '')) continue;
      const mime = String(rep.mime_type || rep.mimeType || '');
      result.reps.push({
        url: rep.base_url,
        d,
        audio: /^audio\//.test(mime) || (!rep.width && !rep.height && /mp4a|opus/.test(String(rep.codecs || ''))),
        width: Number(rep.width) || 0,
        height: Number(rep.height) || 0,
        bandwidth: Number(rep.bandwidth) || 0,
        codecs: String(rep.codecs || ''),
      });
    }

    for (const m of text.matchAll(/"(?:preferred_thumbnail|thumbnailImage|first_frame_thumbnail)":\{(?:"image":\{)?"uri":"((?:[^"\\]|\\.)*)"/g)) {
      const url = decode(m[1]);
      if (url) keep('thumbnail', url, m.index);
    }
    for (const m of text.matchAll(/"owner":\{[^{}]*?"name":"((?:[^"\\]|\\.)*)"/g)) {
      const d = distance(positions, m.index);
      if (d <= NEAR && (!result.owner || d < result.owner.d)) result.owner = { name: decode(m[1]), d };
    }
    return result.hd || result.sd || result.reps.length ? result : null;
  }

  function merge(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      hd: a.hd || b.hd,
      sd: a.sd || b.sd,
      reps: a.reps.length ? a.reps : b.reps,
      thumbnail: a.thumbnail || b.thumbnail,
      owner: a.owner || b.owner,
    };
  }

  function pageScriptsText() {
    let text = '';
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const t = script.textContent || '';
      if (/browser_native_|playable_url|"base_url"/.test(t)) text += `${t}\n`;
    }
    return text;
  }

  const cache = new Map();

  async function findVideo(id) {
    let found = null;
    for (let i = captured.length - 1; i >= 0 && !(found && (found.hd || found.reps.length)); i--) found = merge(found, scan(captured[i], id));
    if (!found || !(found.hd || found.sd)) found = merge(found, scan(pageScriptsText(), id));
    if (found && (found.hd || found.sd || found.reps.length)) return found;

    const hit = cache.get(id);
    if (hit && Date.now() - hit.time < 10 * 60 * 1000) return hit.promise;
    const promise = (async () => {
      let res;
      try {
        res = await fetch(`${window.location.origin}/video.php?v=${encodeURIComponent(id)}`, { credentials: 'include', headers: { Accept: 'text/html' } });
      } catch {
        throw Object.assign(new Error('network'), { userMessage: 'Couldn’t reach Facebook.' });
      }
      const fromPage = scan(await res.text(), id);
      if (!fromPage) {
        throw Object.assign(new Error('no links'), {
          userMessage: 'Facebook didn’t share this video’s links. Play the video for a moment (or open it on its own page) and try again.',
        });
      }
      return fromPage;
    })();
    cache.set(id, { time: Date.now(), promise });
    promise.catch(() => cache.delete(id));
    return promise;
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  function buildResolution(found, id) {
    const owner = found.owner && found.owner.name ? found.owner.name : '';
    const base = [owner, 'facebook', id].filter(Boolean).join('_');
    const videos = found.reps.filter((r) => !r.audio && (r.width || r.height)).sort((a, b) => b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth);
    const audio = found.reps.filter((r) => r.audio).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    const variants = [];

    const sharpest = videos[0];
    const side = sharpest ? Math.min(sharpest.width || sharpest.height, sharpest.height || sharpest.width) : 0;
    // Facebook's HD MP4 is usually 720p; offer the DASH track when it's sharper or the only option.
    if (sharpest && (side > 720 || !(found.hd || found.sd))) {
      variants.push({
        kind: 'video',
        label: `${side}p MP4`,
        detail: [sharpest.width && sharpest.height ? `${sharpest.width} × ${sharpest.height}` : '', audio ? 'with sound' : 'no sound'].filter(Boolean).join(' · '),
        url: sharpest.url,
        ext: 'mp4',
        filename: base,
        job: audio ? { type: 'mux', video: sharpest.url, audio: audio.url } : undefined,
      });
    }
    if (found.hd) {
      variants.push({ kind: 'video', label: 'HD MP4', detail: 'with sound', url: found.hd.url, ext: 'mp4', filename: variants.length ? `${base}_hd` : base });
    }
    if (found.sd) {
      variants.push({ kind: 'video', label: 'SD MP4', detail: 'with sound · smaller file', url: found.sd.url, ext: 'mp4', filename: variants.length ? `${base}_sd` : base });
    }
    if (audio) {
      variants.push({
        kind: 'audio',
        group: 'Other',
        label: 'Audio only',
        detail: ['M4A', audio.bandwidth ? `${Math.round(audio.bandwidth / 1000)} kbps` : ''].filter(Boolean).join(' · '),
        url: audio.url,
        ext: 'm4a',
        filename: `${base}_audio`,
        job: { type: 'mux', audio: audio.url },
      });
    }
    if (found.thumbnail) {
      variants.push({
        kind: 'image',
        group: 'Other',
        label: 'Thumbnail',
        detail: (util.extFromUrl(found.thumbnail.url) || 'jpg').toUpperCase(),
        url: found.thumbnail.url,
        ext: util.extFromUrl(found.thumbnail.url) || 'jpg',
        filename: `${base}_thumbnail`,
      });
    }
    if (!variants.length) return null;
    return {
      site: 'Facebook',
      title: owner || 'Facebook video',
      focus: 0,
      items: [{ label: 'Video', thumbnail: found.thumbnail ? found.thumbnail.url : '', variants }],
    };
  }

  // ---------------------------------------------------------------------------
  // Page mode (a pasted link)
  // ---------------------------------------------------------------------------

  const PAGE_LOGIN_MESSAGE = 'Facebook only shares this video when you’re logged in. Log in at facebook.com in this browser, then paste the link again.';
  const LOGIN_PATH = /^\/(login|checkpoint|recover)(\.php)?(\/|$)/;
  const SHARE_PATH = /^\/share\/(v|r)\//; // share links that redirect to the video

  function loggedIn() {
    return /(?:^|;\s*)c_user=\d+/.test(document.cookie || '');
  }

  /** The video this page shows (a pasted link), or null for photos and posts (the generic handler looks at those). */
  function pageSnapshot() {
    const loc = window.location;
    if (LOGIN_PATH.test(loc.pathname)) throw Object.assign(new Error('login'), { final: true, userMessage: PAGE_LOGIN_MESSAGE });
    const id = idFromHref(loc.href);
    if (id) return { videoId: id, page: true };
    if (SHARE_PATH.test(loc.pathname)) {
      // Still on the share link: Facebook didn't send us on to the video.
      if (!loggedIn()) throw Object.assign(new Error('login'), { final: true, userMessage: PAGE_LOGIN_MESSAGE });
      return null;
    }
    // A post whose main content is a video.
    const main = document.querySelector('[role="main"]') || document;
    for (const video of main.querySelectorAll('video')) {
      const found = idFrom(video);
      if (found) return { videoId: found, page: true, fromVideo: true };
    }
    return null;
  }

  function pageGeneric(loc) {
    return !idFromHref(loc.href) && !LOGIN_PATH.test(loc.pathname) && !SHARE_PATH.test(loc.pathname);
  }

  async function resolve(ctx) {
    if (ctx.page && ctx.snapshot && ctx.snapshot.videoId) {
      const id = ctx.snapshot.videoId;
      // Asked again until the page answers. The page keeps loading data, so
      // look again every few seconds, not on every retry.
      const once = (JDI.generic && JDI.generic.pageOnce) || ((k, fn) => fn());
      try {
        return await once(`facebook:${id}`, () => resolve({ ...ctx, page: false }), 3000);
      } catch (err) {
        if (!loggedIn()) throw Object.assign(new Error('login'), { final: true, userMessage: PAGE_LOGIN_MESSAGE });
        throw err;
      }
    }
    const snap = ctx.snapshot || snapshot(ctx);
    if (!snap.videoId) {
      // A video we can't identify (feed posts sometimes hide the link).
      if (ctx.snapshot && ctx.snapshot.fromVideo) {
        throw Object.assign(new Error('no id'), {
          userMessage: 'Facebook didn’t say which video this is. Click the video’s date or open it, then try again.',
        });
      }
      return null; // photos and the rest: the generic handler takes over
    }
    const found = await findVideo(snap.videoId);
    const resolution = buildResolution(found, snap.videoId);
    if (!resolution) {
      throw Object.assign(new Error('no formats'), { userMessage: 'Facebook didn’t offer a downloadable version of this video.' });
    }
    return resolution;
  }

  util.registerHandler({ id: 'facebook', name: 'Facebook', priority: 100, matches: isFacebook, snapshot, pageSnapshot, pageGeneric, resolve });

  if (JDI.buttons && isFacebook(window.location)) {
    JDI.buttons.register((api) => {
      // In the band Facebook's own reel controls use, clear of the player's
      // control bar along the bottom.
      api.hoverVideos({
        look: 'facebook-overlay',
        size: 36,
        inset: 12,
        onClick: (video, hostEl) => {
          const snap = snapshot(api.centreOf(video));
          if (!snap.videoId) snap.videoId = idFrom(video);
          JDI.core.openPicker({ handlerId: 'facebook', snapshot: { ...snap, fromVideo: true }, anchor: hostEl });
        },
      });
    });
  }

  JDI.facebook = { idFromHref, scan, buildResolution, snapshot };
})();
