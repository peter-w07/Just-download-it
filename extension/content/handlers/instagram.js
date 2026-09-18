/*
 * Just download it: Instagram handler.
 *
 * How it works (checked against instagram.com in September 2026):
 *  - Instagram lays a transparent <div> over every photo and video, so Chrome's
 *    own "Save image as" never sees the image. core.js hit-tests the click
 *    position instead, and JDI.dom.findMediaAt digs out the <img>/<video>.
 *  - The post's shortcode comes from a link around the element (profile grid,
 *    explore), the feed <article>'s permalink, or the page URL (post page,
 *    modal, reels viewer). /stories/<user>/<pk>/ URLs carry the media pk.
 *  - The shortcode converts to a numeric media pk, and the same-origin web API
 *    GET /api/v1/media/<pk>/info/ (sent with the user's own session, exactly
 *    like the site's own requests) returns every size Instagram has: originals
 *    up to 4096px, the progressive MP4 with sound, and a DASH manifest with
 *    sharper silent video tracks and an audio-only track.
 *  - Every size of one photo shares a CDN filename, so the clicked <img> is
 *    matched to its carousel slide by filename.
 *  - Requests only happen when the user picks a menu item, one at a time, are
 *    cached, and back off hard when Instagram complains. If the API isn't
 *    available we fall back to what the page shows.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // Instagram's public web app id. The live value is read from the page when possible.
  const FALLBACK_APP_ID = '936619743392459';
  const ASBD_ID = '359341';
  const POST_PATH = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})(?=\/|$)/;
  const NOT_SHORTCODES = new Set(['audio', 'explore', 'liked_by', 'comments', 'tagged']);
  // Top-level paths that are not usernames.
  const RESERVED_PATHS = new Set([
    'accounts', 'explore', 'reels', 'reel', 'p', 'tv', 'stories', 'direct', 'about', 'legal', 'developer',
    'web', 'api', 'challenge', 'emails', 'session', 'privacy', 'terms', 'your_activity', 'notifications', 's',
  ]);

  const CACHE_TTL_MS = 20 * 60 * 1000;
  const MIN_GAP_MS = 1000;
  const RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000;
  const FLAGGED_PAUSE_MS = 60 * 60 * 1000;
  const PAUSE_KEY = 'instagramPausedUntil';

  // ---------------------------------------------------------------------------
  // Pure helpers (unit tested)
  // ---------------------------------------------------------------------------

  /** Shortcode -> numeric media pk (decimal string). '' if invalid. */
  function shortcodeToPk(code) {
    let s = String(code || '').trim();
    // Posts from private accounts get a 28-character suffix. What's left can be
    // shorter than 11 characters for older posts, so don't just keep 11.
    if (s.length > 28) s = s.slice(0, -28);
    if (!s || s.length > 11) return '';
    let n = 0n;
    for (const ch of s) {
      const i = ALPHABET.indexOf(ch);
      if (i < 0) return '';
      n = n * 64n + BigInt(i);
    }
    return n > 0n && n < 1n << 63n ? n.toString() : '';
  }

  /** Numeric media pk -> shortcode. Accepts "123" or "123_456" (item ids). */
  function pkToShortcode(pk) {
    const digits = String(pk == null ? '' : pk).split('_')[0];
    if (!/^\d+$/.test(digits)) return '';
    let n = BigInt(digits);
    if (n === 0n) return '';
    let out = '';
    while (n > 0n) {
      out = ALPHABET[Number(n % 64n)] + out;
      n /= 64n;
    }
    return out;
  }

  function pathOf(pathOrUrl) {
    try {
      return new URL(String(pathOrUrl || ''), 'https://www.instagram.com').pathname;
    } catch {
      return '';
    }
  }

  function shortcodeFromPath(pathOrUrl) {
    const m = POST_PATH.exec(pathOf(pathOrUrl));
    if (!m || NOT_SHORTCODES.has(m[1].toLowerCase())) return '';
    return m[1];
  }

  /** "/some.user/" -> "some.user"; '' for anything that isn't a profile link. */
  function usernameFromPath(pathOrUrl) {
    const m = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(pathOf(pathOrUrl));
    if (!m || RESERVED_PATHS.has(m[1].toLowerCase())) return '';
    return m[1];
  }

  /** The CDN filename (last path segment), identical across all sizes of one photo. */
  function fileKey(url) {
    const path = pathOf(url);
    return path ? path.split('/').pop() : '';
  }

  /** Image type from the signed `stp` render directive; the path can say .webp for a JPEG. */
  function imageExt(url) {
    try {
      const stp = new URL(url).searchParams.get('stp') || '';
      const m = /dst-(jpe?g|webp|png|heic|avif)/i.exec(stp);
      if (m) return util.normalizeExt(m[1]);
    } catch {
      /* fall through */
    }
    return util.extFromUrl(url) || 'jpg';
  }

  function parseDash(manifest) {
    const result = { video: [], audio: [] };
    if (!manifest || typeof DOMParser === 'undefined') return result;
    let doc;
    try {
      doc = new DOMParser().parseFromString(String(manifest), 'application/xml');
    } catch {
      return result;
    }
    const byTag = (node, tag) =>
      Array.from(node.getElementsByTagNameNS ? node.getElementsByTagNameNS('*', tag) : node.getElementsByTagName(tag));
    if (byTag(doc, 'parsererror').length || !byTag(doc, 'MPD').length) return result;

    for (const rep of byTag(doc, 'Representation')) {
      const set = rep.parentNode;
      const attr = (name) => rep.getAttribute(name) || (set && set.getAttribute ? set.getAttribute(name) : '') || '';
      const baseUrl = byTag(rep, 'BaseURL')[0];
      const url = baseUrl ? baseUrl.textContent.trim() : '';
      if (!/^https:/i.test(url)) continue;
      const mime = attr('mimeType');
      const contentType = (set && set.getAttribute && set.getAttribute('contentType')) || '';
      const entry = {
        url,
        mime,
        codecs: attr('codecs'),
        bandwidth: Number(rep.getAttribute('bandwidth')) || Number(rep.getAttribute('FBAvgBitrate')) || 0,
        width: Number(attr('width')) || 0,
        height: Number(attr('height')) || 0,
        size: Number(rep.getAttribute('FBContentLength')) || 0,
      };
      if (mime.startsWith('audio/') || contentType === 'audio') result.audio.push(entry);
      else if (mime.startsWith('video/') || contentType === 'video') result.video.push(entry);
    }
    result.video.sort((a, b) => b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth);
    result.audio.sort((a, b) => b.bandwidth - a.bandwidth);
    return result;
  }

  function codecName(codecs) {
    const c = String(codecs || '').toLowerCase();
    if (c.startsWith('vp09') || c.startsWith('vp9')) return 'VP9';
    if (c.startsWith('av01')) return 'AV1';
    if (c.startsWith('avc1') || c.startsWith('avc3')) return 'H.264';
    if (c.startsWith('hvc1') || c.startsWith('hev1')) return 'HEVC';
    return '';
  }

  function pixels(w, h) {
    return w && h ? `${Math.min(w, h)}p` : '';
  }

  /** Photo variants, best first. Drops Instagram's square center-crops. */
  function imageVariants(node, filename) {
    const candidates = ((node.image_versions2 && node.image_versions2.candidates) || []).filter(
      (c) => c && c.url && c.width > 0 && c.height > 0,
    );
    if (!candidates.length) return [];
    const ow = Number(node.original_width) || 0;
    const oh = Number(node.original_height) || 0;
    const largest = candidates.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    const ratio = ow && oh ? ow / oh : largest.width / largest.height;

    let list = candidates.filter((c) => Math.abs(c.width / c.height - ratio) / ratio < 0.03);
    if (!list.length) list = candidates;
    const byWidth = new Map();
    for (const c of list) if (!byWidth.has(c.width)) byWidth.set(c.width, c);
    list = Array.from(byWidth.values()).sort((a, b) => b.width - a.width);

    return list.map((c, i) => {
      const ext = imageExt(c.url);
      const isOriginal = i === 0 && (!ow || c.width >= ow);
      return {
        kind: 'image',
        label: i === 0 ? (isOriginal ? 'Original' : 'Largest available') : `${c.width} × ${c.height}`,
        detail: i === 0 ? `${c.width} × ${c.height} · ${ext.toUpperCase()}` : ext.toUpperCase(),
        url: c.url,
        ext,
        filename: i === 0 ? filename : `${filename}_${c.width}w`,
        width: c.width,
        height: c.height,
      };
    });
  }

  /**
   * Video variants, best first:
   *  - if DASH has a sharper track than the progressive MP4, that track muxed
   *    with the audio track (a `job` the service worker runs on this computer),
   *  - the progressive MP4s (sound included),
   *  - sharper silent tracks on their own, audio only.
   */
  function videoVariants(node, filename) {
    const out = [];
    const hasSound = node.has_audio !== false;

    const seen = new Set();
    const progressive = (node.video_versions || [])
      .filter((v) => v && v.url)
      .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))
      .filter((v) => {
        // Instagram often lists one file several times with different query strings.
        const key = `${fileKey(v.url)}|${v.width}x${v.height}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    const dash = parseDash(node.video_dash_manifest);
    const audio = hasSound ? dash.audio[0] : null;
    const bestProgressive = progressive[0] ? (progressive[0].width || 0) * (progressive[0].height || 0) : 0;
    const sharper = dash.video.filter((rep) => rep.width * rep.height > bestProgressive);

    if (sharper[0]) {
      const rep = sharper[0];
      const codec = codecName(rep.codecs);
      out.push({
        kind: 'video',
        label: `${pixels(rep.width, rep.height)} MP4`,
        detail: [`${rep.width} × ${rep.height}`, codec, audio ? 'with sound' : 'no sound'].filter(Boolean).join(' · '),
        ext: 'mp4',
        filename,
        width: rep.width,
        height: rep.height,
        size: rep.size && audio ? rep.size + (audio.size || 0) : rep.size || 0,
        // Without audio there's nothing to combine: the track itself is the file.
        url: rep.url,
        job: audio ? { type: 'mux', video: rep.url, audio: audio.url } : undefined,
      });
    }

    progressive.forEach((v, i) => {
      out.push({
        kind: 'video',
        label: `${pixels(v.width, v.height) || 'Video'} MP4`,
        detail: [v.width && v.height ? `${v.width} × ${v.height}` : '', hasSound ? 'with sound' : 'no sound'].filter(Boolean).join(' · '),
        url: v.url,
        ext: 'mp4',
        filename: i === 0 && !sharper[0] ? filename : `${filename}_${pixels(v.width, v.height) || 'video'}`,
        width: v.width,
        height: v.height,
      });
    });

    // The silent DASH tracks on their own, when we couldn't offer them with sound.
    if (!audio) {
      for (const rep of sharper.slice(sharper[0] && !audio ? 1 : 0)) {
        out.push({
          kind: 'video',
          group: 'Sharper, but no sound',
          label: `${pixels(rep.width, rep.height)} video only`,
          detail: [`${rep.width} × ${rep.height}`, codecName(rep.codecs)].filter(Boolean).join(' · '),
          url: rep.url,
          ext: 'mp4',
          filename: `${filename}_${pixels(rep.width, rep.height)}_no-sound`,
          width: rep.width,
          height: rep.height,
          size: rep.size,
        });
      }
    }

    if (audio) {
      out.push({
        kind: 'audio',
        group: 'Other',
        label: 'Audio only',
        detail: ['M4A', audio.bandwidth ? `${Math.round(audio.bandwidth / 1000)} kbps` : ''].filter(Boolean).join(' · '),
        url: audio.url,
        ext: 'm4a',
        filename: `${filename}_audio`,
        size: audio.size,
        // Instagram serves the track as video/mp4, and Chrome renames a
        // download whose extension doesn't match its type (.m4a -> .mp4).
        // Repackaging it on this computer yields a real audio/mp4 file.
        job: { type: 'mux', audio: audio.url },
      });
    }
    return out;
  }

  function thumbnailFor(node) {
    const candidates = ((node.image_versions2 && node.image_versions2.candidates) || []).filter((c) => c && c.url && c.width);
    if (!candidates.length) return '';
    const sorted = candidates.slice().sort((a, b) => a.width - b.width);
    return (sorted.find((c) => c.width >= 240) || sorted[sorted.length - 1]).url;
  }

  function nodeFileKeys(node) {
    const keys = new Set();
    for (const c of (node.image_versions2 && node.image_versions2.candidates) || []) keys.add(fileKey(c.url));
    for (const v of node.video_versions || []) keys.add(fileKey(v.url));
    keys.delete('');
    return keys;
  }

  /**
   * Turn a media object from /api/v1/media/<pk>/info/ (or a story/highlight
   * reel) into a Resolution.
   * @param focus { fileKeys?: string[], pk?: string, index?: number }
   */
  function buildResolution(media, { focus = {}, notice, kindHint } = {}) {
    const username = (media.user && media.user.username) || (media.owner && media.owner.username) || '';
    const date = util.formatDate(media.taken_at);
    const isStory = kindHint === 'story' || media.product_type === 'story';
    const idPart = isStory ? `story_${String(media.pk || media.id || '').split('_')[0]}` : media.code || pkToShortcode(media.pk);
    const baseName = [username, date, idPart].filter(Boolean).join('_') || 'instagram';

    const nodes = Array.isArray(media.carousel_media) && media.carousel_media.length ? media.carousel_media : [media];
    const multi = nodes.length > 1;

    const items = nodes.map((node, i) => {
      const isVideo = node.media_type === 2 || (Array.isArray(node.video_versions) && node.video_versions.length > 0);
      // Stories can turn a photo into a short video; the photo is the real thing.
      const photoAsVideo = isVideo && node.original_media_type === 1;
      const nodePk = String(node.pk || node.id || '').split('_')[0];
      let filename = multi ? `${baseName}_${String(i + 1).padStart(2, '0')}` : baseName;
      if (isStory && multi && nodePk) {
        // Highlights and story reels: each item is its own post with its own date.
        filename = [username, util.formatDate(node.taken_at || media.taken_at), `story_${nodePk}`].filter(Boolean).join('_');
      }
      const images = imageVariants(node, filename);
      let variants = images;
      if (photoAsVideo) {
        variants = [...images, ...videoVariants(node, `${filename}_video`).map((v) => ({ ...v, group: v.group || 'As a video' }))];
      } else if (isVideo) {
        variants = videoVariants(node, filename);
        if (images[0]) variants.push({ ...images[0], group: 'Other', label: 'Cover image', filename: `${filename}_cover` });
      }
      const noun = isVideo && !photoAsVideo ? 'Video' : 'Photo';
      return {
        label: multi ? `${noun} ${i + 1} of ${nodes.length}` : isStory ? `Story ${noun.toLowerCase()}` : noun,
        thumbnail: thumbnailFor(node),
        variants,
        pk: String(node.pk || node.id || '').split('_')[0],
        fileKeys: nodeFileKeys(node),
        takenAt: Number(node.taken_at) || 0,
      };
    });

    // Most reliable first: the clicked file, the pk from the URL, the story's
    // on-screen timestamp, then the carousel position.
    let focusIndex = 0;
    const wantedPk = focus.pk ? String(focus.pk).split('_')[0] : '';
    // fileKeys are ordered topmost first; the first key that matches wins.
    let byFile = -1;
    for (const key of (focus.fileKeys || []).filter(Boolean)) {
      byFile = items.findIndex((item) => item.fileKeys.has(key));
      if (byFile >= 0) break;
    }
    const byPk = wantedPk ? items.findIndex((item) => item.pk === wantedPk) : -1;
    let byTime = -1;
    if (focus.takenAt && items.some((item) => item.takenAt)) {
      let best = Infinity;
      items.forEach((item, i) => {
        const d = Math.abs(item.takenAt - focus.takenAt);
        if (item.takenAt && d < best) {
          best = d;
          byTime = i;
        }
      });
    }
    if (byFile >= 0) focusIndex = byFile;
    else if (byPk >= 0) focusIndex = byPk;
    else if (byTime >= 0) focusIndex = byTime;
    else if (Number.isInteger(focus.index) && focus.index >= 0 && focus.index < items.length) focusIndex = focus.index;

    return {
      site: 'Instagram',
      title: username ? `@${username}` : 'Instagram',
      notice,
      focus: focusIndex,
      items: items.map(({ label, thumbnail, variants }) => ({ label, thumbnail, variants })),
    };
  }

  /** Profile picture variants from /api/v1/users/<pk>/info/. */
  function profilePictureResolution(user) {
    const username = user.username || '';
    const seen = new Set();
    const list = [user.hd_profile_pic_url_info, ...(user.hd_profile_pic_versions || [])]
      .filter((c) => c && c.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0))
      .filter((c) => {
        if (seen.has(c.width)) return false;
        seen.add(c.width);
        return true;
      });
    if (!list.length && user.profile_pic_url) list.push({ url: user.profile_pic_url });
    const base = `${username || 'instagram'}_profile-picture`;
    const variants = list.map((c, i) => {
      const ext = imageExt(c.url);
      return {
        kind: 'image',
        label: i === 0 ? 'Largest' : `${c.width} × ${c.height}`,
        detail: [c.width && c.height && i === 0 ? `${c.width} × ${c.height}` : '', ext.toUpperCase()].filter(Boolean).join(' · '),
        url: c.url,
        ext,
        filename: i === 0 ? base : `${base}_${c.width}w`,
        width: c.width,
        height: c.height,
      };
    });
    return {
      site: 'Instagram',
      title: username ? `@${username}` : 'Instagram',
      focus: 0,
      items: [{ label: 'Profile picture', thumbnail: list.length ? list[list.length - 1].url : '', variants }],
    };
  }

  // ---------------------------------------------------------------------------
  // Page inspection
  // ---------------------------------------------------------------------------

  let cachedAppId = '';
  function appId() {
    if (cachedAppId) return cachedAppId;
    try {
      for (const script of document.querySelectorAll('script[type="application/json"]')) {
        const text = script.textContent;
        if (!text || text.indexOf('APP_ID') < 0) continue;
        const m = /"APP_ID":"(\d{6,20})"/.exec(text);
        if (m) return (cachedAppId = m[1]);
      }
    } catch {
      /* ignore */
    }
    return FALLBACK_APP_ID;
  }

  function cookie(name) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  function wwwClaim() {
    try {
      return sessionStorage.getItem('www-claim-v2') || '0';
    } catch {
      return '0';
    }
  }

  /** Which post does this element belong to? */
  function findShortcode(element) {
    const start = element && element.nodeType === 1 ? element : null;

    // A link around the element: profile grid, explore, "more posts from".
    const link = start && start.closest('a[href]');
    const fromLink = link ? shortcodeFromPath(link.getAttribute('href')) : '';
    if (fromLink) return fromLink;

    // A post opened as a pop-up: the address bar shows that post.
    const fromUrl = shortcodeFromPath(window.location.pathname);
    if (fromUrl && start && start.closest('[role="dialog"]')) return fromUrl;

    // A feed post: its <article> links to its own permalink (the timestamp link).
    const article = start && start.closest('article');
    if (article) {
      const time = article.querySelector('a[href] time');
      const fromTime = time ? shortcodeFromPath(time.closest('a').getAttribute('href')) : '';
      if (fromTime) return fromTime;
      const counts = new Map();
      for (const a of article.querySelectorAll('a[href]')) {
        const code = shortcodeFromPath(a.getAttribute('href'));
        if (code) counts.set(code, (counts.get(code) || 0) + 1);
      }
      if (counts.size) return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
    }

    // Post page, reels viewer.
    return fromUrl;
  }

  /**
   * If the element is someone's profile picture, return their username.
   * Relies on structure first (alt text is localized):
   *  - a small square image inside a link to /<username>/;
   *  - the feed (Sept 2026): the avatar is a <span role="link"> with no href,
   *    and the username link sits in the same header row;
   *  - the big header image on a profile page.
   */
  function profilePictureOwner(img) {
    if (!img || img.tagName !== 'IMG') return '';
    const r = img.getBoundingClientRect();
    const square = r.width > 0 && Math.abs(r.width - r.height) <= 2;
    if (!square) return '';

    const link = img.closest('a[href]');
    // Square post thumbnails (grids, "more posts") are links to the post, not avatars.
    if (link && shortcodeFromPath(link.getAttribute('href'))) return '';
    const fromLink = link ? usernameFromPath(link.getAttribute('href')) : '';
    if (fromLink && r.width <= 200) return fromLink;

    if (r.width <= 96 && img.closest('[role="link"], [role="button"]')) {
      // English UI names the owner in the alt text; collab posts stack two avatars.
      const fromAlt = /^([A-Za-z0-9._]{1,30})'s profile picture$/.exec(img.alt || '');
      if (fromAlt && usernameFromPath(`/${fromAlt[1]}/`)) return fromAlt[1];
      for (let row = img.parentElement, depth = 0; row && depth < 10; depth++, row = row.parentElement) {
        if (row.getBoundingClientRect().height > 120) break; // left the header row
        const users = Array.from(row.querySelectorAll('a[href]'), (a) => usernameFromPath(a.getAttribute('href'))).filter(Boolean);
        if (users.length) return users.find((u) => (img.alt || '').includes(u)) || users[0];
      }
    }

    const onProfile = usernameFromPath(window.location.pathname);
    if (onProfile && img.closest('header')) return onProfile;
    return '';
  }

  /**
   * Carousel slide index, or -1. Only ~3 slides exist in the DOM at a time, each
   * placed with translateX(n * slideWidth), so the index comes from the offset.
   */
  function carouselIndex(element) {
    const li = element && element.closest && element.closest('li');
    const m = li ? /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(li.style.transform || '') : null;
    const width = li ? li.offsetWidth || li.getBoundingClientRect().width : 0;
    if (m && width) return Math.round(Math.abs(Number(m[1])) / width);
    // Permalink pages remember the slide as ?img_index=N (1-based).
    const fromUrl = Number(new URLSearchParams(window.location.search).get('img_index'));
    return fromUrl >= 1 ? fromUrl - 1 : -1;
  }

  /** The story viewer's visible timestamp (unix seconds), to find the item without class names. */
  function storyTakenAt() {
    for (const t of document.querySelectorAll('section time[datetime]')) {
      if (!t.getClientRects().length) continue;
      const ms = Date.parse(t.getAttribute('datetime'));
      if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    }
    return 0;
  }

  function clickedFileKeys(media) {
    const keys = [];
    for (const m of media) {
      if (m.tagName === 'IMG') keys.push(fileKey(m.currentSrc || m.src));
      if (m.tagName === 'VIDEO' && m.poster) keys.push(fileKey(m.poster));
      if (m.tagName === 'VIDEO' && /^https:/i.test(m.currentSrc || '')) keys.push(fileKey(m.currentSrc));
    }
    return keys.filter(Boolean);
  }

  /** The profile's user pk from the page's own HTML, if this document was loaded as that profile. */
  function userPkFromPage(username) {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav || usernameFromPath(nav.name).toLowerCase() !== username.toLowerCase()) return '';
      for (const script of document.querySelectorAll('script[type="application/json"]')) {
        const text = script.textContent;
        if (!text || text.indexOf('profile_id') < 0) continue;
        const m = /"profile_id":"(\d{1,20})"/.exec(text);
        if (m) return m[1];
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // API (polite: cached, one request at a time, backs off when told to)
  // ---------------------------------------------------------------------------

  class InstagramError extends Error {
    constructor(code, userMessage) {
      super(code);
      this.code = code;
      this.userMessage = userMessage;
    }
  }

  const MESSAGES = {
    login: 'Log in to Instagram to download in full quality.',
    paused: 'Instagram asked for a break from requests.',
    flagged: 'Instagram wants you to confirm something on your account. Open instagram.com in a tab and check for a prompt.',
    rateLimited: 'Instagram is limiting requests right now.',
    failed: "Instagram didn't return media info.",
    notFound: "Instagram couldn't find that. It may be private, deleted, or your session may need a refresh.",
  };

  const cache = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  async function pausedUntil() {
    try {
      const stored = await chrome.storage.local.get(PAUSE_KEY);
      return Number(stored[PAUSE_KEY]) || 0;
    } catch {
      return 0;
    }
  }

  function pause(ms) {
    try {
      chrome.storage.local.set({ [PAUSE_KEY]: Date.now() + ms });
    } catch {
      /* extension context gone */
    }
  }

  async function request(path) {
    const until = await pausedUntil();
    if (until > Date.now()) {
      const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
      throw new InstagramError('paused', `${MESSAGES.paused} Full quality is back in about ${minutes} min.`);
    }
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();

    const headers = {
      Accept: '*/*',
      'X-IG-App-ID': appId(),
      'X-ASBD-ID': ASBD_ID,
      'X-IG-WWW-Claim': wwwClaim(),
      'X-Requested-With': 'XMLHttpRequest',
    };
    const csrf = cookie('csrftoken');
    if (csrf) headers['X-CSRFToken'] = csrf;

    let res;
    try {
      res = await fetch(new URL(path, window.location.origin).href, { credentials: 'include', headers });
    } catch {
      throw new InstagramError('network', "Couldn't reach Instagram.");
    }

    if (res.redirected) {
      const p = pathOf(res.url);
      if (p === '/' || p.startsWith('/accounts/login')) throw new InstagramError('login', MESSAGES.login);
      if (p.startsWith('/challenge')) {
        pause(FLAGGED_PAUSE_MS);
        throw new InstagramError('flagged', MESSAGES.flagged);
      }
    }
    if (res.status === 429) {
      pause(RATE_LIMIT_PAUSE_MS);
      throw new InstagramError('rate-limited', MESSAGES.rateLimited);
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* handled below */
    }
    const message = String((data && data.message) || '');
    if (/feedback_required|checkpoint_required|challenge_required/i.test(message)) {
      pause(FLAGGED_PAUSE_MS);
      throw new InstagramError('flagged', MESSAGES.flagged);
    }
    // Instagram often sends its throttle as HTTP 401 with require_login:true and
    // "Please wait a few minutes", so check for that before treating it as a login problem.
    if (/wait a few minutes|rate limit|try again later/i.test(message)) {
      pause(RATE_LIMIT_PAUSE_MS);
      throw new InstagramError('rate-limited', MESSAGES.rateLimited);
    }
    if ((data && data.require_login) || /login_required/i.test(message) || res.status === 401) {
      throw new InstagramError('login', MESSAGES.login);
    }
    if (res.status === 404) throw new InstagramError('not-found', MESSAGES.notFound);
    if (!res.ok || !data || (data.status && data.status !== 'ok')) throw new InstagramError('failed', MESSAGES.failed);
    return data;
  }

  function api(path) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.promise;
    const promise = (queue = queue.catch(() => {}).then(() => request(path)));
    cache.set(path, { time: Date.now(), promise });
    promise.catch(() => cache.delete(path));
    return promise;
  }

  async function mediaInfo(pk) {
    const data = await api(`/api/v1/media/${encodeURIComponent(pk)}/info/`);
    const item = data && Array.isArray(data.items) ? data.items[0] : null;
    if (!item) throw new InstagramError('failed', MESSAGES.failed);
    return item;
  }

  async function reelItems(reelId) {
    const data = await api(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`);
    const reels = (data && data.reels) || {};
    const list = Array.isArray(data && data.reels_media) ? data.reels_media : [];
    const reel = reels[reelId] || list.find((r) => String(r.id) === String(reelId)) || null;
    const items = reel && Array.isArray(reel.items) ? reel.items : [];
    if (!items.length) throw new InstagramError('not-found', "Instagram didn't return that story. It may have expired.");
    return { reel, items };
  }

  const userPks = new Map();
  async function userPk(username) {
    const key = username.toLowerCase();
    if (userPks.has(key)) return userPks.get(key);
    let pk = userPkFromPage(username);
    if (!pk) {
      const data = await api(`/web/search/topsearch/?query=${encodeURIComponent(username)}`);
      const hit = ((data && data.users) || []).map((u) => u.user).find((u) => u && String(u.username).toLowerCase() === key);
      pk = hit ? String(hit.pk || hit.pk_id || hit.id || '') : '';
    }
    if (!pk) throw new InstagramError('not-found', MESSAGES.notFound);
    userPks.set(key, pk);
    return pk;
  }

  // ---------------------------------------------------------------------------
  // Resolve
  // ---------------------------------------------------------------------------

  /** What the page itself shows, for when the API isn't available. */
  function pageFallback(media, notice) {
    const video = media.find((m) => m.tagName === 'VIDEO');
    const img = media.find((m) => m.tagName === 'IMG');
    const items = [];
    if (video && /^https:/i.test(video.currentSrc || '')) {
      const item = JDI.generic.mediaItem(video);
      if (item) items.push(item);
    }
    if (!items.length && img) {
      const item = JDI.generic.imageItem(img);
      if (item) {
        item.label = video ? 'Video cover image' : 'Photo';
        item.variants.forEach((v) => {
          v.filename = `instagram_${v.filename}`;
          if (v.label === 'As shown on the page') v.label = 'As shown on the page (may be smaller)';
        });
        items.push(item);
      }
    }
    if (!items.length) return null;
    return { site: 'Instagram', title: 'Instagram', notice, items, focus: 0 };
  }

  function withFallback(media, err) {
    const reason = err.userMessage || MESSAGES.failed;
    const fallback = pageFallback(media, `${reason} Here's the version on the page instead.`);
    if (fallback) return fallback;
    throw err;
  }

  /**
   * Called on every right-click (by core.js) to record what was under the
   * cursor before anything on the page moves. Cheap: no network.
   */
  function snapshot({ x, y, stack, target }) {
    // With a post open as a pop-up, the page behind it is still rendered and
    // shows up in the hit test. Only look at the pop-up.
    let layer = stack || [];
    const dialog = layer[0] && layer[0].closest ? layer[0].closest('[role="dialog"]') : null;
    if (dialog) layer = layer.filter((node) => dialog.contains(node));
    const media = JDI.dom.findMediaAt(layer, x, y);
    const element = media[0] || target || layer[0] || null;
    const path = window.location.pathname;
    const highlight = /^\/stories\/highlights\/(\d+)/.exec(path);
    const story = highlight ? null : /^\/stories\/([^/]+)(?:\/(\d+))?/.exec(path);
    const img = media.find((m) => m.tagName === 'IMG');
    // Check for a profile picture first: a feed post's avatar sits inside the
    // post's <article>, which would otherwise resolve to the post.
    const avatarOf = highlight || story ? '' : profilePictureOwner(img);
    const code = highlight || story || avatarOf ? '' : findShortcode(element);
    return {
      media,
      code,
      highlightId: highlight ? highlight[1] : '',
      storyUser: story ? story[1] : '',
      storyPk: story && story[2] ? story[2] : '',
      avatarOf,
      focus: {
        fileKeys: clickedFileKeys(media),
        index: carouselIndex(media[0] || element),
        takenAt: highlight || story ? storyTakenAt() : 0,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Page mode (a link pasted into the toolbar popup, opened in a background tab)
  // ---------------------------------------------------------------------------

  const PAGE_LOGIN_MESSAGE = 'Instagram only shows this when you’re logged in. Log in at instagram.com in this browser, then paste the link again.';
  // Profile sub-pages that still mean "this person".
  const PROFILE_TABS = /^\/([A-Za-z0-9._]{1,30})\/(?:reels|tagged|saved|followers|following|featured)\/?$/;

  /** Instagram's login wall: the login page, or a "Log in" link with no session. */
  function loginWallShown() {
    if (/^\/accounts\/(login|emailsignup|signup)/.test(window.location.pathname)) return true;
    if (cookie('ds_user_id')) return false;
    return !!document.querySelector('a[href^="/accounts/login"], a[href*="instagram.com/accounts/login"], input[name="password"]');
  }

  /** The post's own photos/videos, biggest first (a fallback when the API can't be used). */
  function pageMedia() {
    const list = [];
    for (const node of document.querySelectorAll('main img, main video, article img, article video, section img, section video, [role="dialog"] img, [role="dialog"] video')) {
      if (list.includes(node)) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 150 || r.height < 150) continue;
      const link = node.closest('a[href]');
      if (link && shortcodeFromPath(link.getAttribute('href'))) continue; // another post's tile
      list.push(node);
    }
    return list.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
  }

  /** A highlight share link (/s/<base64 of "highlight:<id>">). */
  function highlightFromShareLink(loc) {
    const m = /^\/s\/([A-Za-z0-9+/=_-]{8,})\/?$/.exec(loc.pathname);
    if (!m) return '';
    try {
      const text = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
      const h = /^highlight:(\d+)$/.exec(text);
      return h ? h[1] : '';
    } catch {
      return '';
    }
  }

  async function pageSnapshot() {
    const loc = window.location;
    const path = loc.pathname;
    const params = new URLSearchParams(loc.search);
    // Logged out, Instagram sends links to its login page (the link stays in ?next=).
    if (/^\/accounts\/(login|emailsignup|signup)/.test(path)) throw Object.assign(new InstagramError('login', PAGE_LOGIN_MESSAGE), { final: true });
    if (/^\/challenge/.test(path)) throw new InstagramError('flagged', MESSAGES.flagged);

    const empty = { media: [], code: '', highlightId: '', storyUser: '', storyPk: '', avatarOf: '', page: true, focus: { fileKeys: [], index: -1, takenAt: 0 } };
    const highlight = /^\/stories\/highlights\/(\d+)/.exec(path);
    const shared = highlight ? '' : highlightFromShareLink(loc);
    const story = highlight || shared ? null : /^\/stories\/([A-Za-z0-9._]{1,30})(?:\/(\d+))?/.exec(path);
    const code = shortcodeFromPath(path);
    const profile = usernameFromPath(path) || (PROFILE_TABS.exec(path) || [])[1] || '';
    const avatarOf = profile && !RESERVED_PATHS.has(profile.toLowerCase()) ? profile : '';

    let snap = null;
    if (highlight || shared) {
      const storyMedia = String(params.get('story_media_id') || '').split('_')[0];
      snap = { ...empty, highlightId: highlight ? highlight[1] : shared, focus: { ...empty.focus, pk: storyMedia, takenAt: storyTakenAt() } };
    } else if (story) {
      snap = { ...empty, storyUser: story[1], storyPk: story[2] || '', focus: { ...empty.focus, takenAt: story[2] ? 0 : storyTakenAt() } };
    } else if (code) {
      const imgIndex = Number(params.get('img_index'));
      snap = { ...empty, code, focus: { ...empty.focus, index: imgIndex >= 1 ? imgIndex - 1 : -1 } };
    } else if (avatarOf) {
      snap = { ...empty, avatarOf };
    }
    if (!snap) {
      throw new InstagramError('not-media', 'That Instagram page isn’t a post, reel, story or profile. Paste the link to one.');
    }

    // No session cookie: give the page a moment to show its login prompt
    // rather than asking the API (which may count it against the user).
    if (!cookie('ds_user_id')) {
      for (let i = 0; i < 10 && !loginWallShown(); i++) await new Promise((r) => setTimeout(r, 200));
      if (loginWallShown()) snap.loggedOut = true;
    }
    snap.media = pageMedia();
    return snap;
  }

  async function resolvePageSnapshot(ctx, snap) {
    // Stories and highlights never show without an account; posts sometimes do.
    if (snap.loggedOut && (snap.highlightId || snap.storyUser)) throw Object.assign(new InstagramError('login', PAGE_LOGIN_MESSAGE), { final: true });
    if (snap.loggedOut) {
      const fallback = pageFallback(snap.media, 'You’re not logged in to Instagram, so this is the smaller version shown on the page. Log in at instagram.com for full quality.');
      if (fallback && snap.code) return fallback;
      throw Object.assign(new InstagramError('login', PAGE_LOGIN_MESSAGE), { final: true });
    }
    if (!ctx.settings || !ctx.settings.instagramApi) {
      const fallback = pageFallback(snap.media, 'Full-quality lookup is off in settings, so this is the version on the page.');
      if (fallback) return fallback;
      throw new InstagramError('api-off', 'Full-quality lookup for Instagram is off in settings, and this page doesn’t show a file to save.');
    }
    // The service worker asks again until the page answers: ask Instagram once.
    const key = `instagram:${snap.code}|${snap.highlightId}|${snap.storyUser}|${snap.storyPk}|${snap.avatarOf}`;
    const once = (JDI.generic && JDI.generic.pageOnce) || ((k, fn) => fn());
    try {
      return await once(key, () => resolve({ ...ctx, page: false, snapshot: { ...snap, media: [] } }), 10 * 60 * 1000);
    } catch (err) {
      if (err && err.code === 'login') throw Object.assign(new InstagramError('login', PAGE_LOGIN_MESSAGE), { final: true });
      if (err instanceof InstagramError && snap.code) return withFallback(pageMedia(), err);
      throw err;
    }
  }

  async function resolve(ctx) {
    if (ctx.page && ctx.snapshot) return resolvePageSnapshot(ctx, ctx.snapshot);
    const snap = ctx.snapshot || snapshot(ctx);
    const { media, code, highlightId, storyUser, storyPk, avatarOf, focus } = snap;

    if (snap.reel && !code) {
      const err = new InstagramError('no-code', 'Instagram hasn’t shown which reel this is yet. Scroll to it again, then click Download.');
      throw err;
    }
    // Not a post, story or profile picture (UI, text...): let the generic handler try.
    if (!code && !highlightId && !storyUser && !avatarOf) return null;

    if (!ctx.settings.instagramApi) {
      return pageFallback(media, 'Full-quality lookup is off in settings, so this is the version on the page.');
    }

    try {
      if (highlightId) {
        const { reel, items } = await reelItems(`highlight:${highlightId}`);
        const owner = (reel && reel.user) || items[0].user || {};
        const resolution = buildResolution(
          { carousel_media: items, user: owner, taken_at: items[0].taken_at, pk: `highlight-${highlightId}` },
          { focus, kindHint: 'story' },
        );
        return { ...resolution, title: owner.username ? `@${owner.username} · highlight` : 'Highlight' };
      }
      if (storyUser && storyPk) {
        const item = await mediaInfo(storyPk);
        return buildResolution(item, { focus: { ...focus, pk: storyPk }, kindHint: 'story' });
      }
      if (storyUser) {
        // /stories/<user>/ without an item id: fetch the whole story reel.
        const pk = await userPk(storyUser);
        const { reel, items } = await reelItems(pk);
        const owner = (reel && reel.user) || items[0].user || { username: storyUser };
        const resolution = buildResolution(
          { carousel_media: items, user: owner, taken_at: items[0].taken_at, pk: `stories-${pk}` },
          { focus, kindHint: 'story' },
        );
        return { ...resolution, title: `@${owner.username || storyUser} · story` };
      }
      if (avatarOf) {
        const pk = await userPk(avatarOf);
        const data = await api(`/api/v1/users/${encodeURIComponent(pk)}/info/`);
        if (!data || !data.user) throw new InstagramError('failed', MESSAGES.failed);
        return profilePictureResolution(data.user);
      }
      const pk = shortcodeToPk(code);
      if (!pk) return pageFallback(media, "Couldn't read this post's address. Here's the version on the page instead.");
      return buildResolution(await mediaInfo(pk), { focus });
    } catch (err) {
      if (!(err instanceof InstagramError)) console.warn('[Just download it]', err);
      return withFallback(media, err);
    }
  }

  util.registerHandler({
    id: 'instagram',
    name: 'Instagram',
    priority: 100,
    // Only the app itself: help., about., business. etc. are ordinary sites.
    matches: (loc) => /^(www\.)?instagram\.com$/i.test(loc.hostname),
    snapshot,
    pageSnapshot,
    // A page-wide image scan on Instagram would only find thumbnails and avatars.
    pageGeneric: false,
    resolve,
  });

  // ---------------------------------------------------------------------------
  // Download button in each post's action row (like, comment, repost, share)
  // ---------------------------------------------------------------------------

  /**
   * The action row, as of September 2026: a <section> laid out as two groups,
   * [like, comment, repost, share] and [save]. Class names change constantly,
   * so this relies on shape: two children, icon buttons, one row tall.
   */
  function isActionRow(section) {
    if (section.children.length !== 2) return false;
    const rect = section.getBoundingClientRect();
    if (!rect.height || rect.height > 64) return false;
    const [left, right] = section.children;
    const leftIcons = left.querySelectorAll('svg').length;
    const leftButtons = left.querySelectorAll('[role="button"], button').length;
    return leftIcons >= 3 && leftButtons >= 3 && right.querySelectorAll('svg').length >= 1;
  }

  /** What the Download button in `section` refers to: the post's visible media. */
  function snapshotForActionRow(section) {
    const container = section.closest('article') || section.closest('[role="dialog"]') || section.closest('main') || document.body;
    const vp = { width: window.innerWidth, height: window.innerHeight };

    let best = null;
    for (const node of container.querySelectorAll('img, video')) {
      const r = node.getBoundingClientRect();
      if (r.width < 150 || r.height < 150) continue;
      // Tiles linking to other posts ("more posts from") aren't this post.
      const link = node.closest('a[href]');
      if (link && shortcodeFromPath(link.getAttribute('href'))) continue;
      const left = Math.max(r.left, 0);
      const right = Math.min(r.right, vp.width);
      const top = Math.max(r.top, 0);
      const bottom = Math.min(r.bottom, vp.height);
      if (right - left < 20 || bottom - top < 20) continue;
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      // Carousels keep neighbouring slides in the DOM but clip them; only
      // media that is really on screen at its centre counts.
      const stack = JDI.dom.deepElementsFromPoint(x, y);
      if (!stack.includes(node)) continue;
      const area = (right - left) * (bottom - top);
      const score = area + (node.tagName === 'VIDEO' ? 1 : 0);
      if (!best || score > best.score) best = { node, x, y, stack, score };
    }

    const snap = best
      ? snapshot({ x: best.x, y: best.y, stack: best.stack, target: best.node })
      : snapshot({ x: NaN, y: NaN, stack: [], target: section });
    // The button belongs to a post, never to a profile picture.
    snap.avatarOf = '';
    if (!snap.code) snap.code = findShortcode(section);
    return snap;
  }

  /**
   * The Reels viewer (Sept 2026): each reel is [video area, action column]; the
   * column stacks Like, Comment, Repost, Share, Save, More, audio. Found by
   * shape: a narrow, tall sibling of the video with several icon buttons.
   */
  function reelColumnFor(video) {
    let node = video;
    // The signed-out viewer wraps the video in a few more single-child divs
    // than the signed-in one: measured at 12 levels there, so leave room.
    for (let depth = 0; node && depth < 18; depth++, node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent || parent.children.length !== 2) continue;
      const column = parent.children[0] === node ? parent.children[1] : parent.children[0];
      const r = column.getBoundingClientRect();
      if (r.width > 0 && r.width < 120 && r.height > 250 && column.children.length >= 4 && column.querySelectorAll('svg').length >= 4) {
        return column;
      }
    }
    return null;
  }

  /** The reel a column belongs to: Instagram keeps the one on screen in the address bar. */
  function snapshotForReel(column) {
    const item = column.parentElement;
    const media = Array.from(item.querySelectorAll('video, img')).filter((m) => m.getBoundingClientRect().width >= 150);
    return {
      media,
      code: shortcodeFromPath(window.location.pathname),
      highlightId: '',
      storyUser: '',
      storyPk: '',
      avatarOf: '',
      reel: true,
      focus: { fileKeys: clickedFileKeys(media), index: -1, takenAt: 0 },
    };
  }

  if (JDI.buttons && /^(www\.)?instagram\.com$/i.test(window.location.hostname)) {
    JDI.buttons.register((api) => {
      api.onChange(() => {
        // Feed and post pages: after Share in the action row.
        for (const section of document.querySelectorAll('section')) {
          const left = section.firstElementChild;
          if (!left || left.querySelector(`:scope > ${api.TAG}`)) continue;
          if (!isActionRow(section)) continue;
          const button = api.create({
            look: 'instagram-icon',
            label: 'Download',
            title: 'Download',
            theme: 'auto',
            onClick: (hostEl) => {
              const row = hostEl.closest('section');
              if (!row) return;
              JDI.core.openPicker({ handlerId: 'instagram', snapshot: snapshotForActionRow(row), anchor: hostEl });
            },
          });
          left.appendChild(button);
        }

        // Reels viewer: after Share in each reel's vertical column.
        if (/^\/reels?\//.test(window.location.pathname)) {
          for (const video of document.querySelectorAll('video')) {
            const column = reelColumnFor(video);
            if (!column || column.querySelector(`:scope > ${api.TAG}`)) continue;
            const share = Array.from(column.children).find((c) => c.querySelector('svg[aria-label="Share"]'));
            const save = Array.from(column.children).find((c) => c.querySelector('svg[aria-label="Save"], svg[aria-label="Remove"]'));
            const button = api.create({
              look: 'instagram-column',
              label: 'Download',
              title: 'Download',
              theme: 'auto',
              onClick: (hostEl) => {
                const col = hostEl.parentElement;
                if (!col) return;
                JDI.core.openPicker({ handlerId: 'instagram', snapshot: snapshotForReel(col), anchor: hostEl });
              },
            });
            const after = share || (save && save.previousElementSibling) || column.children[3] || column.lastElementChild;
            column.insertBefore(button, after ? after.nextSibling : null);
          }
        }
      });

      // Any Instagram video (feed, reels, stories): a button on hover.
      api.hoverVideos({
        onClick: (video, hostEl) => {
          const column = reelColumnFor(video);
          const snapshot = column && /^\/reels?\//.test(window.location.pathname) ? snapshotForReel(column) : JDI.instagram.snapshot(api.centreOf(video));
          JDI.core.openPicker({ handlerId: 'instagram', snapshot, anchor: hostEl });
        },
      });
    });
  }

  JDI.instagram = {
    shortcodeToPk,
    pkToShortcode,
    shortcodeFromPath,
    usernameFromPath,
    fileKey,
    imageExt,
    parseDash,
    imageVariants,
    videoVariants,
    buildResolution,
    profilePictureResolution,
    snapshot,
  };
})();
