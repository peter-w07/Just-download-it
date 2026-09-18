/*
 * Just download it: YouTube handler.
 *
 * How it works (checked against youtube.com in September 2026):
 *  - The watch page's own player data no longer contains stream URLs (YouTube
 *    streams through its SABR protocol). Asking the InnerTube player API as the
 *    VISIONOS client, with the page's visitor id, returns plain HTTPS URLs for
 *    every format: no signature cipher, no throttling parameter, up to 4K.
 *    The request is same-origin from this tab and sends no cookies.
 *  - Video and audio come as separate tracks, so every MP4 is a "mux" job the
 *    offscreen document combines without re-encoding. MP3 is an "mp3" job.
 *  - A Download button sits just left of the Like button on watch pages.
 *
 * YouTube changes which clients work every few months. CLIENTS is the one
 * place to update when that happens.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const CACHE_TTL_MS = 30 * 60 * 1000; // stream URLs last ~6 hours

  const CLIENTS = [
    {
      name: 'VISIONOS',
      headerId: '101',
      version: '1.02',
      context: {
        clientName: 'VISIONOS',
        clientVersion: '1.02',
        deviceMake: 'Apple',
        deviceModel: 'RealityDevice17,1',
        osName: 'visionOS',
        osVersion: '26.5.23O471',
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // Pure helpers (unit tested)
  // ---------------------------------------------------------------------------

  /** Video id from any YouTube URL shape, or ''. */
  function videoIdFromUrl(href, base) {
    let u;
    try {
      u = new URL(String(href || ''), base || 'https://www.youtube.com/');
    } catch {
      return '';
    }
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.split('/')[1] || '';
      return VIDEO_ID.test(id) ? id : '';
    }
    if (!/(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(u.hostname)) return '';
    if (u.pathname === '/watch') {
      const v = u.searchParams.get('v') || '';
      return VIDEO_ID.test(v) ? v : '';
    }
    const m = /^\/(?:shorts|embed|live|v|e)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(u.pathname);
    return m ? m[1] : '';
  }

  function codecOf(mimeType) {
    const m = /codecs="([^"]+)"/.exec(String(mimeType || ''));
    const c = (m ? m[1] : '').toLowerCase();
    if (c.startsWith('avc1')) return 'avc1';
    if (c.startsWith('vp9') || c.startsWith('vp09')) return 'vp9';
    if (c.startsWith('av01')) return 'av01';
    if (c.startsWith('mp4a')) return 'mp4a';
    if (c.startsWith('opus')) return 'opus';
    return c.split('.')[0];
  }

  const CODEC_NAMES = { avc1: 'H.264', vp9: 'VP9', av01: 'AV1', mp4a: 'AAC', opus: 'Opus' };

  function usableFormat(f) {
    if (!f || typeof f.url !== 'string' || !/^https:/i.test(f.url)) return false;
    if (f.signatureCipher || f.cipher) return false;
    if (Array.isArray(f.drmFamilies) && f.drmFamilies.length) return false;
    try {
      // An "n" parameter means the URL is throttled until solved with YouTube's player JS.
      if (new URL(f.url).searchParams.has('n')) return false;
    } catch {
      return false;
    }
    return true;
  }

  /** Best audio track, optionally of one codec. Skips "DRC" (compressed-dynamics) duplicates. */
  function pickAudio(audios, codec) {
    const list = audios.filter((f) => !codec || codecOf(f.mimeType) === codec);
    const plain = list.filter((f) => !f.isDrc && !/drc/i.test(String(f.xtags || '')));
    const pool = plain.length ? plain : list;
    return pool.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0] || null;
  }

  function shortSide(f) {
    const w = Number(f.width) || 0;
    const h = Number(f.height) || 0;
    return w && h ? Math.min(w, h) : h || w;
  }

  function qualityLabel(f) {
    if (f.qualityLabel) return String(f.qualityLabel);
    const side = shortSide(f);
    const fps = Number(f.fps) || 0;
    return side ? `${side}p${fps > 30 ? fps : ''}` : 'Video';
  }

  /** One video format per quality, best first. H.264 up to 1080p (plays everywhere), VP9/AV1 above. */
  function pickVideos(videos) {
    const groups = new Map();
    for (const f of videos) {
      const label = qualityLabel(f);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(f);
    }
    const chosen = [];
    for (const [label, list] of groups) {
      const side = shortSide(list[0]);
      const order = side <= 1080 ? ['avc1', 'vp9', 'av01'] : ['vp9', 'av01', 'avc1'];
      const rank = (f) => {
        const i = order.indexOf(codecOf(f.mimeType));
        return i < 0 ? order.length : i;
      };
      list.sort((a, b) => rank(a) - rank(b) || (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
      chosen.push({ label, format: list[0], side, fps: Number(list[0].fps) || 0, hdr: /hdr/i.test(label) });
    }
    return chosen.sort((a, b) => b.side - a.side || b.fps - a.fps || Number(a.hdr) - Number(b.hdr));
  }

  class YouTubeError extends Error {
    constructor(code, userMessage) {
      super(code);
      this.code = code;
      this.userMessage = userMessage;
    }
  }

  function playabilityError(status) {
    const reason = String(status.reason || '').trim();
    switch (status.status) {
      case 'LOGIN_REQUIRED':
        return new YouTubeError(
          'login',
          /bot/i.test(reason)
            ? 'YouTube asked to confirm you’re not a bot. Play the video for a moment, reload the page, and try again.'
            : 'This video needs a signed-in account (age-restricted, private or members-only), which isn’t supported yet.',
        );
      case 'AGE_CHECK_REQUIRED':
      case 'CONTENT_CHECK_REQUIRED':
        return new YouTubeError('age', 'Age-restricted videos aren’t supported yet.');
      case 'LIVE_STREAM_OFFLINE':
        return new YouTubeError('live', 'This live stream hasn’t started yet.');
      default:
        return new YouTubeError('unplayable', reason ? `YouTube says: ${reason}` : 'YouTube won’t play this video here.');
    }
  }

  /** Turn a player API response into a Resolution. Throws YouTubeError with a userMessage. */
  function buildResolution(player, videoId) {
    const status = (player && player.playabilityStatus) || {};
    if (status.status !== 'OK') throw playabilityError(status);
    const details = player.videoDetails || {};
    if (details.isLive || details.isUpcoming) {
      throw new YouTubeError('live', 'Live streams can’t be downloaded while they’re live.');
    }

    const sd = player.streamingData || {};
    const all = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
    const formats = all.filter(usableFormat);
    const videos = formats.filter((f) => /^video\//.test(f.mimeType) && !f.audioQuality);
    const audios = formats.filter((f) => /^audio\//.test(f.mimeType));
    if (!videos.length && !audios.length) {
      throw new YouTubeError('no-formats', 'YouTube didn’t offer a downloadable version of this video just now. Try again in a little while.');
    }

    const title = String(details.title || videoId);
    const base = `${title} [${videoId}]`;
    const audioForMp4 = pickAudio(audios, 'mp4a') || pickAudio(audios);
    const audioForMp3 = pickAudio(audios, 'opus') || audioForMp4;

    const variants = [];
    if (audioForMp4) {
      for (const { label, format } of pickVideos(videos)) {
        const codec = codecOf(format.mimeType);
        const w = Number(format.width) || 0;
        const h = Number(format.height) || 0;
        const size = (Number(format.contentLength) || 0) + (Number(audioForMp4.contentLength) || 0);
        variants.push({
          kind: 'video',
          label,
          detail: [w && h ? `${w} × ${h}` : '', CODEC_NAMES[codec] || codec.toUpperCase(), 'MP4'].filter(Boolean).join(' · '),
          url: format.url,
          ext: 'mp4',
          filename: `${base} ${label}`,
          width: w,
          height: h,
          size: Number(format.contentLength) && Number(audioForMp4.contentLength) ? size : 0,
          job: { type: 'mux', video: format.url, audio: audioForMp4.url },
        });
      }
    }

    if (audioForMp3) {
      variants.push({
        kind: 'audio',
        group: 'Audio only',
        label: 'MP3',
        detail: 'Converted on your computer',
        url: audioForMp3.url,
        ext: 'mp3',
        filename: base,
        job: { type: 'mp3', audio: audioForMp3.url },
      });
    }
    if (audioForMp4) {
      const codec = codecOf(audioForMp4.mimeType);
      const kbps = Math.round((Number(audioForMp4.averageBitrate || audioForMp4.bitrate) || 0) / 1000);
      variants.push({
        kind: 'audio',
        group: 'Audio only',
        label: codec === 'mp4a' ? 'M4A' : 'Audio',
        detail: [CODEC_NAMES[codec] || codec, kbps ? `${kbps} kbps` : '', 'original quality'].filter(Boolean).join(' · '),
        url: audioForMp4.url,
        ext: codec === 'mp4a' ? 'm4a' : 'mp4',
        filename: base,
        size: Number(audioForMp4.contentLength) || 0,
        job: { type: 'mux', audio: audioForMp4.url },
      });
    }

    const thumbs = ((details.thumbnail && details.thumbnail.thumbnails) || []).filter((t) => t && /^https:/i.test(t.url || ''));
    const largest = thumbs.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    if (largest) {
      const ext = util.extFromUrl(largest.url) || 'jpg';
      variants.push({
        kind: 'image',
        group: 'Other',
        label: 'Thumbnail',
        detail: [largest.width && largest.height ? `${largest.width} × ${largest.height}` : '', ext.toUpperCase()].filter(Boolean).join(' · '),
        url: largest.url,
        ext,
        filename: `${base} thumbnail`,
      });
    }

    const small = thumbs.slice().sort((a, b) => (a.width || 0) - (b.width || 0)).find((t) => (t.width || 0) >= 160) || largest;
    return {
      site: 'YouTube',
      title,
      focus: 0,
      items: [{ label: details.author ? `by ${details.author}` : 'Video', thumbnail: small ? small.url : '', variants }],
    };
  }

  // ---------------------------------------------------------------------------
  // Page
  // ---------------------------------------------------------------------------

  function isYouTubePage() {
    return /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(window.location.hostname);
  }

  /** The video the page is showing (watch page, Shorts, embed). */
  function currentVideoId() {
    const fromUrl = videoIdFromUrl(window.location.href);
    if (fromUrl) return fromUrl;
    const flexy = document.querySelector('ytd-watch-flexy[video-id]');
    const id = flexy ? flexy.getAttribute('video-id') : '';
    return VIDEO_ID.test(id || '') ? id : '';
  }

  const PLAYER_AREAS = '#movie_player, .html5-video-player, ytd-player, ytd-watch-metadata, #shorts-player, ytd-reel-video-renderer';

  /** What a right-click landed on. No network. */
  function snapshot({ stack, target }) {
    const nodes = (stack && stack.length ? stack : [target]).filter(Boolean).slice(0, 15);
    // A link to a video: thumbnails, titles, end screens, playlist entries.
    for (const node of nodes) {
      const link = node.closest && node.closest('a[href]');
      const id = link ? videoIdFromUrl(link.href) : '';
      if (id) return { videoId: id, source: 'link' };
    }
    const top = nodes[0];
    if (top && top.closest && top.closest(PLAYER_AREAS)) {
      const id = currentVideoId();
      if (id) return { videoId: id, source: 'player' };
    }
    return { videoId: '', source: '' };
  }

  let cachedVisitorData = '';
  function visitorData() {
    if (cachedVisitorData) return cachedVisitorData;
    try {
      for (const script of document.scripts) {
        const text = script.textContent;
        if (!text || text.indexOf('VISITOR_DATA') < 0) continue;
        const m = /"VISITOR_DATA":"([^"]+)"/.exec(text);
        if (m) return (cachedVisitorData = m[1]);
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  const cache = new Map();

  async function fetchPlayer(videoId) {
    const hit = cache.get(videoId);
    if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.promise;

    const promise = (async () => {
      const visitor = visitorData();
      let lastError = null;
      for (const client of CLIENTS) {
        let res;
        try {
          res = await fetch(new URL('/youtubei/v1/player?prettyPrint=false', window.location.origin).href, {
            method: 'POST',
            credentials: 'omit',
            headers: {
              'Content-Type': 'application/json',
              'X-YouTube-Client-Name': client.headerId,
              'X-YouTube-Client-Version': client.version,
              ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}),
            },
            body: JSON.stringify({
              context: { client: { ...client.context, hl: 'en', gl: 'US', ...(visitor ? { visitorData: visitor } : {}) } },
              videoId,
              playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
              contentCheckOk: true,
              racyCheckOk: true,
            }),
          });
        } catch {
          lastError = new YouTubeError('network', 'Couldn’t reach YouTube.');
          continue;
        }
        if (res.status === 429) {
          lastError = new YouTubeError('rate-limited', 'YouTube is limiting requests right now. Wait a minute and try again.');
          continue;
        }
        let data = null;
        try {
          data = await res.json();
        } catch {
          /* handled below */
        }
        if (!res.ok || !data) {
          lastError = new YouTubeError('failed', `YouTube didn’t answer (HTTP ${res.status}). Try again.`);
          continue;
        }
        try {
          buildResolution(data, videoId); // throws if this client can't be used
          return data;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError || new YouTubeError('failed', 'YouTube didn’t answer. Try again.');
    })();

    cache.set(videoId, { time: Date.now(), promise });
    promise.catch(() => cache.delete(videoId));
    return promise;
  }

  async function resolve(ctx) {
    const snap = ctx.snapshot || snapshot(ctx);
    let videoId = snap.videoId;
    if (!videoId && ctx.info && ctx.info.linkUrl) videoId = videoIdFromUrl(ctx.info.linkUrl);
    if (!videoId) return null; // not a video: let the generic handler look (e.g. an image)
    const player = await fetchPlayer(videoId);
    return buildResolution(player, videoId);
  }

  util.registerHandler({
    id: 'youtube',
    name: 'YouTube',
    priority: 100,
    matches: (loc) => /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(loc.hostname),
    snapshot,
    resolve,
  });

  // ---------------------------------------------------------------------------
  // Download button next to Like
  // ---------------------------------------------------------------------------

  const ROW_SELECTOR = 'ytd-watch-metadata #top-level-buttons-computed';
  const LIKE_SELECTOR =
    ':scope > segmented-like-dislike-button-view-model, :scope > like-button-view-model, :scope > ytd-segmented-like-dislike-button-renderer';

  if (JDI.buttons && isYouTubePage() && window.location.hostname === 'www.youtube.com') {
    JDI.buttons.register((api) => {
      let button = null;
      api.onChange(() => {
        const onWatch = window.location.pathname === '/watch' && currentVideoId();
        const row = onWatch ? document.querySelector(ROW_SELECTOR) : null;
        if (!row) {
          if (button && button.isConnected) button.remove();
          return;
        }
        if (!button) {
          button = api.create({
            look: 'youtube-pill',
            label: 'Download',
            title: 'Download this video',
            theme: 'auto',
            onClick: (hostEl) =>
              JDI.core.openPicker({ handlerId: 'youtube', snapshot: { videoId: currentVideoId(), source: 'button' }, anchor: hostEl }),
          });
        }
        const like = row.querySelector(LIKE_SELECTOR);
        const reference = like || Array.from(row.children).find((c) => c !== button) || null;
        if (button.parentElement !== row || (reference && button.nextElementSibling !== reference)) {
          row.insertBefore(button, reference);
        }
        // The row is 40px tall on today's watch page; the older 36px row is
        // still around on narrow layouts, so follow Like rather than assume.
        const likeHeight = like ? like.getBoundingClientRect().height : 0;
        const size = likeHeight && likeHeight < 38 ? '36' : '40';
        if (likeHeight && button.getAttribute('data-size') !== size) button.setAttribute('data-size', size);
      });
    });
  }

  JDI.youtube = { videoIdFromUrl, codecOf, usableFormat, pickAudio, pickVideos, buildResolution, snapshot, CLIENTS };
})();
