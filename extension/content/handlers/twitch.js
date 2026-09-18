/*
 * Just download it: Twitch handler.
 *
 *  - Clips (clips.twitch.tv/<slug>, twitch.tv/<channel>/clip/<slug>): Twitch's
 *    GraphQL API returns every quality as a plain MP4 plus a playback token;
 *    those download directly.
 *  - Past broadcasts (twitch.tv/videos/<id>): a playback token opens the VOD's
 *    HLS master playlist (one entry per quality). The chosen quality is an
 *    "hls" job: the offscreen document copies its segments into one MP4.
 *  - Requests go to gql.twitch.tv with Twitch's public web client id, plus the
 *    user's own login token when they're signed in (for sub-only VODs they can
 *    already watch). Live streams aren't supported.
 *  - Button: in the player's control bar, next to settings.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  // Persisted query hashes Twitch's web app uses (checked September 2026).
  const HASH_CLIP = '2db6a3b20eabf510bd3cf465ae2408834b59eb6b8af89ca73ab1486cacecfb63'; // ShareClipRenderStatus
  const HASH_TOKEN = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9'; // PlaybackAccessToken

  function isTwitch(loc) {
    return /(^|\.)twitch\.tv$/i.test(loc.hostname);
  }

  /** { clip } or { vod } for a Twitch URL, or null. */
  function targetFromUrl(href) {
    let u;
    try {
      u = new URL(String(href || ''), window.location.href);
    } catch {
      return null;
    }
    if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.hostname === 'clips.twitch.tv' && parts[0] && parts[0] !== 'embed') return { clip: parts[0] };
    if (u.hostname === 'clips.twitch.tv' && parts[0] === 'embed') return u.searchParams.get('clip') ? { clip: u.searchParams.get('clip') } : null;
    if (parts[1] === 'clip' && parts[2]) return { clip: parts[2] };
    if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) return { vod: parts[1] };
    if (u.searchParams.get('video')) return { vod: u.searchParams.get('video').replace(/^v/, '') };
    return null;
  }

  function snapshot({ stack, target }) {
    for (const node of (stack && stack.length ? stack : [target]).filter(Boolean).slice(0, 12)) {
      const link = node.closest && node.closest('a[href]');
      const t = link && targetFromUrl(link.getAttribute('href'));
      if (t) return t;
    }
    return targetFromUrl(window.location.href) || {};
  }

  function authToken() {
    const m = /(?:^|;\s*)auth-token=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function gql(body) {
    const token = authToken();
    let res;
    try {
      res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8', ...(token ? { Authorization: `OAuth ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw Object.assign(new Error('network'), { userMessage: 'Couldn’t reach Twitch.' });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw Object.assign(new Error(`gql ${res.status}`), { userMessage: 'Twitch didn’t answer. Try again.' });
    return data;
  }

  function persisted(operationName, variables, sha256Hash) {
    return { operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash } } };
  }

  const safeName = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);

  // ---------------------------------------------------------------------------
  // Clips
  // ---------------------------------------------------------------------------

  async function resolveClip(slug) {
    let clip = null;
    try {
      const [res] = await gql([persisted('ShareClipRenderStatus', { slug }, HASH_CLIP)]);
      clip = res && res.data && res.data.clip;
    } catch {
      /* fall back to a plain query below */
    }
    if (!clip) {
      const res = await gql({
        query: `query { clip(slug: ${JSON.stringify(slug)}) { title broadcaster { displayName } playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { signature value } videoQualities { frameRate quality sourceURL } } }`,
      });
      clip = res && res.data && res.data.clip;
    }
    if (!clip) throw Object.assign(new Error('no clip'), { userMessage: 'Twitch couldn’t find that clip.' });
    return buildClip(clip, slug);
  }

  function buildClip(clip, slug) {
    const token = clip.playbackAccessToken || {};
    const withToken = (url) => `${url}${url.includes('?') ? '&' : '?'}sig=${encodeURIComponent(token.signature || '')}&token=${encodeURIComponent(token.value || '')}`;
    const broadcaster = (clip.broadcaster && clip.broadcaster.displayName) || '';
    const base = [broadcaster, safeName(clip.title), slug].filter(Boolean).join(' - ');
    const assets = Array.isArray(clip.assets) && clip.assets.length ? clip.assets : [{ videoQualities: clip.videoQualities || [] }];

    const variants = [];
    assets.forEach((asset, a) => {
      const portrait = a > 0 || /portrait/i.test(String(asset.aspectRatio || asset.type || ''));
      (asset.videoQualities || [])
        .filter((q) => q && /^https:/i.test(q.sourceURL || ''))
        .sort((x, y) => Number(y.quality) - Number(x.quality) || Number(y.frameRate) - Number(x.frameRate))
        .forEach((q) => {
          const fps = Math.round(Number(q.frameRate) || 0);
          const label = `${q.quality}p${fps > 30 ? fps : ''}`;
          variants.push({
            kind: 'video',
            group: portrait ? 'Vertical' : '',
            label,
            detail: 'MP4 · with sound',
            url: withToken(q.sourceURL),
            ext: 'mp4',
            filename: variants.length ? `${base} ${label}${portrait ? ' vertical' : ''}` : base,
          });
        });
    });
    if (!variants.length) throw Object.assign(new Error('no qualities'), { userMessage: 'Twitch didn’t offer a downloadable version of this clip.' });
    return { site: 'Twitch', title: clip.title || 'Twitch clip', focus: 0, items: [{ label: broadcaster || 'Clip', variants }] };
  }

  // ---------------------------------------------------------------------------
  // Past broadcasts
  // ---------------------------------------------------------------------------

  function parseAttributes(text) {
    const out = {};
    for (const m of String(text).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    return out;
  }

  /** The quality list from an HLS master playlist. */
  function parseMaster(text, baseUrl) {
    const lines = String(text).split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const attrs = parseAttributes(lines[i].slice(18));
      let uri = lines[++i];
      while (uri !== undefined && (uri.startsWith('#') || uri === '')) uri = lines[++i];
      if (!uri) break;
      const [w, h] = String(attrs.RESOLUTION || 'x').split('x').map(Number);
      variants.push({
        name: attrs['IVS-NAME'] || attrs.VIDEO || (h ? `${h}p` : 'Audio only'),
        url: new URL(uri, baseUrl).href,
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        width: w || 0,
        height: h || 0,
        fps: attrs['FRAME-RATE'] ? Math.round(Number(attrs['FRAME-RATE'])) : 0,
        audioOnly: !attrs.RESOLUTION,
      });
    }
    return variants;
  }

  /** @param meta  { title, channel } when known (page mode), instead of reading the page */
  async function resolveVod(id, meta) {
    let token = null;
    try {
      const [res] = await gql([
        persisted('PlaybackAccessToken', { isLive: false, login: '', isVod: true, vodID: id, playerType: 'site', platform: 'web' }, HASH_TOKEN),
      ]);
      token = res && res.data && res.data.videoPlaybackAccessToken;
    } catch {
      /* fall back below */
    }
    if (!token) {
      const res = await gql({
        query: `{ videoPlaybackAccessToken(id: ${JSON.stringify(id)}, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }`,
      });
      token = res && res.data && res.data.videoPlaybackAccessToken;
    }
    if (!token) throw Object.assign(new Error('no token'), { userMessage: 'Twitch couldn’t find that video.' });

    const params = new URLSearchParams({
      allow_source: 'true',
      allow_audio_only: 'true',
      platform: 'web',
      player: 'twitchweb',
      supported_codecs: 'h264', // H.264 plays everywhere once saved
      playlist_include_framerate: 'true',
      p: String(Math.floor(Math.random() * 1e7)),
      sig: token.signature,
      token: token.value,
    });
    const masterUrl = `https://usher.ttvnw.net/vod/v2/${encodeURIComponent(id)}.m3u8?${params}`;
    // Fetched by the service worker: the playlist server may not let pages read it.
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'jdi:fetch-json', as: 'text', url: masterUrl });
    } catch {
      /* handled below */
    }
    if (!res || (!res.ok && !res.status)) {
      throw Object.assign(new Error('network'), { userMessage: 'Couldn’t reach Twitch’s video servers.' });
    }
    if (res.status === 403) {
      throw Object.assign(new Error('restricted'), { userMessage: 'This video is for subscribers only. Sign in with an account that can watch it.' });
    }
    if (!res.ok) throw Object.assign(new Error(`usher ${res.status}`), { userMessage: 'Twitch didn’t offer this video right now.' });
    const qualities = parseMaster(res.text, masterUrl);
    return buildVod(qualities, id, meta);
  }

  function buildVod(qualities, id, meta) {
    const title = meta && meta.title ? safeName(meta.title) : safeName((document.querySelector('meta[property="og:title"]') || {}).content || document.title.replace(/ - Twitch$/, ''));
    const channel = meta && meta.channel ? safeName(meta.channel) : safeName(((document.querySelector('meta[property="og:site_name"]') || {}).content || '').replace(/^Twitch$/, ''));
    const base = [channel, title, `v${id}`].filter(Boolean).join(' - ');
    const videos = qualities.filter((q) => !q.audioOnly).sort((a, b) => b.height - a.height || b.fps - a.fps || b.bandwidth - a.bandwidth);
    const audio = qualities.filter((q) => q.audioOnly).sort((a, b) => b.bandwidth - a.bandwidth)[0];

    const variants = videos.map((q, i) => {
      const label = q.height ? `${q.height}p${q.fps > 30 ? q.fps : ''}` : q.name;
      return {
        kind: 'video',
        label,
        detail: [q.width && q.height ? `${q.width} × ${q.height}` : '', 'MP4', i === 0 ? 'source quality' : ''].filter(Boolean).join(' · '),
        url: q.url,
        ext: 'mp4',
        filename: i === 0 ? base : `${base} ${label}`,
        job: { type: 'hls', url: q.url },
      };
    });
    if (audio) {
      variants.push({ kind: 'audio', group: 'Audio only', label: 'M4A', detail: 'Audio track', url: audio.url, ext: 'm4a', filename: `${base} audio`, job: { type: 'hls', url: audio.url, audioOnly: true } });
    }
    if (!variants.length) throw Object.assign(new Error('no variants'), { userMessage: 'Twitch didn’t offer any qualities for this video.' });
    return {
      site: 'Twitch',
      title: title || `Twitch video ${id}`,
      notice: 'Long broadcasts take a while: the video is assembled on your computer. You can keep browsing.',
      focus: 0,
      items: [{ label: channel || 'Video', variants }],
    };
  }

  // ---------------------------------------------------------------------------
  // Page mode (a pasted link)
  // ---------------------------------------------------------------------------

  // First path segments that aren't channels.
  const NOT_CHANNELS = new Set([
    'directory', 'videos', 'search', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'friends', 'messages',
    'downloads', 'jobs', 'turbo', 'prime', 'store', 'p', 'login', 'signup', 'logout', 'following', 'moderator', 'u',
    'bits', 'payments', 'redeem', 'broadcast', 'creatorcamp', 'team', 'event', 'popout', 'embed', 'clips', 'clip', 'dashboard',
  ]);

  const once = (key, fn, ttl) => ((JDI.generic && JDI.generic.pageOnce) || ((k, f) => f()))(key, fn, ttl);

  async function channelIsLive(login) {
    try {
      const res = await gql({ query: `query { user(login: ${JSON.stringify(login)}) { id stream { id } } }` });
      const user = res && res.data && res.data.user;
      return user ? !!user.stream : null;
    } catch {
      return null;
    }
  }

  /** A past broadcast's title and channel. A page opened in the background may not have filled them in yet. */
  async function vodMeta(id) {
    try {
      const res = await gql({ query: `query { video(id: ${JSON.stringify(id)}) { title owner { displayName } } }` });
      const video = res && res.data && res.data.video;
      return video ? { title: video.title || '', channel: (video.owner && video.owner.displayName) || '' } : null;
    } catch {
      return null;
    }
  }

  /** The clip or past broadcast this page shows (a pasted link). */
  async function pageSnapshot() {
    const target = targetFromUrl(window.location.href);
    if (target) return target;
    const parts = window.location.pathname.split('/').filter(Boolean);
    const channel = parts[0] && /^[A-Za-z0-9_]{2,25}$/.test(parts[0]) && !NOT_CHANNELS.has(parts[0].toLowerCase()) ? parts[0] : '';
    if (channel && parts.length === 1) {
      const live = await once(`twitch-live:${channel.toLowerCase()}`, () => channelIsLive(channel), 60000);
      if (live !== false) {
        throw Object.assign(new Error('live'), { final: true, userMessage: 'Live streams can’t be downloaded. Clips and past broadcasts (on the channel’s Videos tab) can: paste the link to one.' });
      }
      throw Object.assign(new Error('offline'), { final: true, userMessage: 'That’s a Twitch channel, not a video. Paste the link to one of its clips or past broadcasts (on its Videos tab).' });
    }
    throw Object.assign(new Error('not a video'), { final: true, userMessage: 'That Twitch page isn’t a clip or past broadcast. Paste the link to one.' });
  }

  async function resolve(ctx) {
    const snap = ctx.snapshot || snapshot(ctx);
    // Asked again until the page answers: look each video up once.
    if (ctx.page && snap.clip) return once(`twitch-clip:${snap.clip}`, () => resolveClip(snap.clip), 60000);
    if (ctx.page && snap.vod) return once(`twitch-vod:${snap.vod}`, async () => resolveVod(snap.vod, await vodMeta(snap.vod)), 60000);
    if (snap.clip) return resolveClip(snap.clip);
    if (snap.vod) return resolveVod(snap.vod);
    // A channel page with a live player.
    if (ctx.stack && ctx.stack.some((n) => n.tagName === 'VIDEO') && /^\/[A-Za-z0-9_]{3,}\/?$/.test(window.location.pathname)) {
      throw Object.assign(new Error('live'), { final: true, userMessage: 'Live streams can’t be saved. Clips and past broadcasts (the Videos tab) can.' });
    }
    return null;
  }

  util.registerHandler({ id: 'twitch', name: 'Twitch', priority: 100, matches: isTwitch, snapshot, pageSnapshot, pageGeneric: false, resolve });

  // ---------------------------------------------------------------------------
  // Button in the player controls
  // ---------------------------------------------------------------------------

  if (JDI.buttons && isTwitch(window.location)) {
    JDI.buttons.register((api) => {
      const open = (hostEl) => JDI.core.openPicker({ handlerId: 'twitch', snapshot: targetFromUrl(window.location.href) || {}, anchor: hostEl });
      api.onChange(() => {
        const target = targetFromUrl(window.location.href);
        const existing = document.querySelector(`${api.TAG}[data-look="twitch-control"]`);
        if (!target) {
          if (existing) existing.remove();
          return;
        }
        // A sibling of the gear, captions and fullscreen buttons in the
        // control group itself: each of those sits in its own wrapper, so
        // going through the group keeps our button the same size as them.
        const settings = document.querySelector('[data-a-target="player-settings-button"]');
        const group = settings && settings.closest('.player-controls__right-control-group');
        const slot = group
          ? Array.from(group.children).find((c) => c.contains(settings))
          : settings && (settings.closest('[class*="tw-tooltip-wrapper"], .tw-tooltip__container') || settings.parentElement);
        if (!slot || !slot.parentElement) return;
        if (existing && existing.nextElementSibling === slot) return;
        const button = existing || api.create({ look: 'twitch-control', label: 'Download', title: 'Download', onClick: open });
        slot.parentElement.insertBefore(button, slot);
      });
      api.hoverVideos({
        look: 'twitch-overlay',
        size: 36,
        minWidth: 320,
        onClick: (video, hostEl) => {
          if (document.querySelector(`${api.TAG}[data-look="twitch-control"]`)) return open(hostEl);
          return JDI.core.openPicker({ handlerId: 'twitch', snapshot: snapshot(api.centreOf(video)), anchor: hostEl });
        },
      });
    });
  }

  JDI.twitch = { targetFromUrl, parseMaster, buildClip, snapshot };
})();
