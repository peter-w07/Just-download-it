// Just download it: what the website can download by itself, with no extension.
//
// A web page may only read another site when that site allows it (CORS), and
// most don't: YouTube, TikTok, Instagram, Facebook, Snapchat, Medal and Spotify
// refuse, so their videos and songs need the extension. These allow it, so the
// page does the whole job in the browser, like the extension would:
//  - X: every quality of a post's videos and GIFs, and its photos at original
//    size, from fxtwitter (api.fxtwitter.com, a free public service that reads
//    X's public embed data; X's own embed endpoint only answers its own embed
//    site). X's video server turns away requests that carry a Referer, so none
//    is sent.
//  - Twitch clips, every quality, from Twitch's own API and clip servers.
//  - Apple Music: cover art at full size and each song's 30-second preview,
//    from Apple's public iTunes lookup API.
//  - YouTube, YouTube Music, TikTok and Spotify: the thumbnail or cover art.
//  - A direct link to a file, when its server allows it.
//
// resolveOnWeb(url) resolves with
//   { site, title, thumbnail, items: [{ label, thumbnail, variants }], needs, complete }
// where each variant is { kind, label, detail, url, ext, filename }, `needs`
// says what only the extension can get ('' when nothing), and `complete` is
// true when the page got everything the link offers. It throws an Error with
// a userMessage when the link can't be used at all.
// save(variant, onProgress) downloads one variant and saves it under its name.

const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Twitch's public web client
const FILE_EXT = /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|gif|webp|avif|svg|pdf|zip)$/i;

const userError = (message) => Object.assign(new Error(message), { userMessage: message });

const LOOKUP_TIMEOUT = 15000; // a service that never answers shouldn't leave the page waiting

async function getJson(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(LOOKUP_TIMEOUT), ...init });
  } catch {
    throw Object.assign(new Error(`network ${url}`), { network: true });
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

function dateOf(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Safe as a file name on Windows, macOS and Linux. */
export function cleanName(text, max = 120) {
  let s = String(text || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (Array.from(s).length > max) s = Array.from(s).slice(0, max).join('').replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  return s || 'download';
}

// ---------------------------------------------------------------------------
// X
// ---------------------------------------------------------------------------

const X_HOST = /^(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com$/i;
const X_STATUS = /\/status(?:es)?\/(\d{5,25})(?:\/(?:photo|video)\/(\d))?/;
const X_UNAVAILABLE = 'X doesn’t share this post publicly (it may be protected, deleted or age-restricted).';

async function resolveX(url) {
  const m = X_STATUS.exec(url.pathname);
  if (!m) throw userError('That X link isn’t a post. Paste the link to a post (it has /status/ in it).');
  const id = m[1];
  let res;
  try {
    res = await getJson(`https://api.fxtwitter.com/status/${id}`);
  } catch {
    throw userError('Couldn’t reach X’s post data right now. Try again in a minute.');
  }
  const code = (res.data && res.data.code) || res.status;
  if (code === 404 || code === 401 || code === 500) throw userError(X_UNAVAILABLE);
  const tweet = res.data && res.data.tweet;
  if (!tweet) throw userError('X’s post data didn’t come back. Try again in a minute.');
  const own = xItems(tweet, id);
  const quote = tweet.quote && tweet.quote.media ? xItems(tweet.quote, tweet.quote.id).map((item) => ({ ...item, label: `Quoted @${(tweet.quote.author && tweet.quote.author.screen_name) || 'post'}: ${item.label}` })) : [];
  const items = own.concat(quote);
  if (!items.length) throw userError('This post has no photos, videos or GIFs.');
  const user = tweet.author && tweet.author.screen_name;
  return {
    site: 'X',
    title: user ? `@${user}` : 'X post',
    thumbnail: items[0].thumbnail,
    focus: m[2] ? Math.min(Number(m[2]) - 1, items.length - 1) : 0,
    items,
    needs: '',
    complete: true,
  };
}

function xItems(tweet, id) {
  const media = (tweet.media && tweet.media.all) || [];
  const user = (tweet.author && tweet.author.screen_name) || '';
  const created = tweet.created_timestamp ? tweet.created_timestamp * 1000 : tweet.created_at;
  const base = [user, dateOf(created), tweet.id || id].filter(Boolean).join('_');
  const multi = media.length > 1;
  return media.map((m, i) => {
    const filename = multi ? `${base}_${i + 1}` : base;
    const noun = m.type === 'photo' ? 'Photo' : m.type === 'gif' ? 'GIF' : 'Video';
    const label = multi ? `${noun} ${i + 1} of ${media.length}` : noun;
    if (m.type === 'photo') {
      let u;
      try {
        u = new URL(m.url);
      } catch {
        return { label, variants: [] };
      }
      const ext = (/\.([a-z0-9]+)$/i.exec(u.pathname) || [, 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg');
      const at = (name) => {
        const v = new URL(u.href);
        v.searchParams.set('name', name);
        return v.href;
      };
      return {
        label,
        thumbnail: at('small'),
        variants: [
          { kind: 'image', label: 'Original', detail: [m.width && m.height ? `${m.width} × ${m.height}` : '', ext.toUpperCase()].filter(Boolean).join(' · '), url: at('orig'), ext, filename },
          { kind: 'image', label: 'Large', detail: 'Up to 2048 px', url: at('large'), ext, filename: `${filename}_large` },
          { kind: 'image', label: 'Medium', detail: 'Up to 1200 px', url: at('medium'), ext, filename: `${filename}_medium` },
        ],
      };
    }
    const mp4s = (m.variants || [])
      .filter((v) => v && v.content_type === 'video/mp4' && /^https:/i.test(v.url || ''))
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    if (!mp4s.length && /^https:.+\.mp4/i.test(m.url || '')) mp4s.push({ url: m.url, bitrate: 0 });
    const variants = mp4s.map((v, j) => {
      const dims = /\/(\d{2,5})x(\d{2,5})\//.exec(v.url);
      const w = dims ? Number(dims[1]) : j === 0 ? Number(m.width) || 0 : 0;
      const h = dims ? Number(dims[2]) : j === 0 ? Number(m.height) || 0 : 0;
      const kbps = Math.round((Number(v.bitrate) || 0) / 1000);
      const p = w && h ? `${Math.min(w, h)}p` : '';
      return {
        kind: 'video',
        label: p ? `${p} MP4` : j === 0 ? 'Best MP4' : 'MP4',
        detail: [w && h ? `${w} × ${h}` : '', kbps ? `${kbps} kbps` : '', m.type === 'gif' ? 'GIF as video' : 'with sound'].filter(Boolean).join(' · '),
        url: v.url,
        ext: 'mp4',
        filename: j === 0 ? filename : `${filename}_${p || j}`,
      };
    });
    if (m.thumbnail_url) {
      variants.push({ kind: 'image', group: 'Other', label: 'Thumbnail', detail: 'JPG', url: m.thumbnail_url, ext: 'jpg', filename: `${filename}_thumbnail` });
    }
    return { label, thumbnail: m.thumbnail_url || '', variants };
  });
}

// ---------------------------------------------------------------------------
// Twitch clips
// ---------------------------------------------------------------------------

function twitchTarget(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'clips.twitch.tv') {
    if (parts[0] === 'embed') return url.searchParams.get('clip') ? { clip: url.searchParams.get('clip') } : null;
    return parts[0] ? { clip: parts[0] } : null;
  }
  if (parts[1] === 'clip' && parts[2]) return { clip: parts[2] };
  if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) return { vod: parts[1] };
  return null;
}

async function resolveTwitch(url) {
  const target = twitchTarget(url);
  if (target && target.vod) {
    return { site: 'Twitch', title: 'Past broadcast', items: [], needs: 'Twitch’s past broadcasts', complete: false };
  }
  if (!target) throw userError('That Twitch page isn’t a clip. Paste the link to a clip, or to a past broadcast.');
  let res;
  try {
    res = await getJson('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        query: `query { clip(slug: ${JSON.stringify(target.clip)}) { title broadcaster { displayName } thumbnailURL(width: 480, height: 272) playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { signature value } videoQualities { frameRate quality sourceURL } } }`,
      }),
    });
  } catch {
    throw userError('Couldn’t reach Twitch.');
  }
  const clip = res.data && res.data.data && res.data.data.clip;
  if (!clip) throw userError('Twitch couldn’t find that clip.');
  const token = clip.playbackAccessToken || {};
  const signed = (u) => `${u}${u.includes('?') ? '&' : '?'}sig=${encodeURIComponent(token.signature || '')}&token=${encodeURIComponent(token.value || '')}`;
  const broadcaster = (clip.broadcaster && clip.broadcaster.displayName) || '';
  const base = [broadcaster, clip.title, target.clip].filter(Boolean).join(' - ');
  const variants = (clip.videoQualities || [])
    .filter((q) => q && /^https:/i.test(q.sourceURL || ''))
    .sort((a, b) => Number(b.quality) - Number(a.quality) || Number(b.frameRate) - Number(a.frameRate))
    .map((q, i) => {
      const fps = Math.round(Number(q.frameRate) || 0);
      const label = `${q.quality}p${fps > 30 ? fps : ''}`;
      return { kind: 'video', label, detail: 'MP4 · with sound', url: signed(q.sourceURL), ext: 'mp4', filename: i === 0 ? base : `${base} ${label}` };
    });
  if (clip.thumbnailURL) variants.push({ kind: 'image', group: 'Other', label: 'Thumbnail', detail: 'JPG', url: clip.thumbnailURL, ext: 'jpg', filename: `${base} thumbnail` });
  if (!variants.length) throw userError('Twitch didn’t offer a downloadable version of this clip.');
  return { site: 'Twitch', title: clip.title || 'Twitch clip', thumbnail: clip.thumbnailURL || '', items: [{ label: broadcaster || 'Clip', variants }], needs: '', complete: true };
}

// ---------------------------------------------------------------------------
// Apple Music: cover art and previews
// ---------------------------------------------------------------------------

const coverAt = (url, size) => {
  const m = /^(https:\/\/[a-z0-9-]+\.mzstatic\.com\/image\/thumb\/.+)\/[^/]+$/i.exec(String(url || ''));
  return m ? `${m[1]}/${size}x${size}bb.jpg` : '';
};

function coverItem(artwork, name) {
  return {
    label: 'Cover art',
    thumbnail: coverAt(artwork, 200),
    variants: [
      { kind: 'image', label: 'Full size', detail: 'Up to 3000 × 3000 · JPG', url: coverAt(artwork, 3000), ext: 'jpg', filename: `${name} (cover)` },
      { kind: 'image', label: '1400 × 1400', detail: 'JPG', url: coverAt(artwork, 1400), ext: 'jpg', filename: `${name} (cover 1400)` },
      { kind: 'image', label: '600 × 600', detail: 'JPG', url: coverAt(artwork, 600), ext: 'jpg', filename: `${name} (cover 600)` },
    ],
  };
}

async function resolveAppleMusic(url) {
  const m = /^\/([a-z]{2})\/(album|song)\/(?:[^/]+\/)?(\d+)/i.exec(url.pathname);
  if (!m) {
    return { site: 'Apple Music', title: 'Apple Music', items: [], needs: 'this page’s songs', complete: false };
  }
  const country = m[1].toLowerCase();
  const trackId = m[2] === 'song' ? m[3] : url.searchParams.get('i');
  let res;
  try {
    res = await getJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(trackId || m[3])}&entity=song&country=${country}&limit=200`);
  } catch {
    throw userError('Couldn’t reach Apple Music.');
  }
  const results = (res.data && res.data.results) || [];
  const songs = results.filter((r) => r.wrapperType === 'track' && r.kind === 'song');
  const collection = results.find((r) => r.wrapperType === 'collection');
  const one = trackId ? songs.find((s) => String(s.trackId) === String(trackId)) || songs[0] : null;
  const first = one || collection || songs[0];
  if (!first) throw userError('Apple Music couldn’t find that. It may not be available in this country.');
  const artist = first.artistName || '';
  const preview = (s) => ({
    kind: 'audio',
    label: '30-second preview',
    detail: 'M4A · AAC',
    url: s.previewUrl,
    ext: 'm4a',
    filename: `${s.artistName} - ${s.trackName} (preview)`,
  });
  const items = [];
  if (one) {
    items.push(coverItem(one.artworkUrl100, `${artist} - ${one.collectionName || one.trackName}`));
    if (one.previewUrl) items.push({ label: one.trackName, thumbnail: coverAt(one.artworkUrl100, 200), variants: [preview(one)] });
  } else {
    const album = (collection && collection.collectionName) || songs[0].collectionName;
    items.push(coverItem((collection || songs[0]).artworkUrl100, `${artist} - ${album}`));
    for (const s of songs.sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber))) {
      if (s.previewUrl) items.push({ label: `${String(s.trackNumber).padStart(2, '0')}. ${s.trackName}`, variants: [preview(s)] });
    }
  }
  return {
    site: 'Apple Music',
    title: one ? `${one.trackName} · ${artist}` : `${(collection && collection.collectionName) || ''} · ${artist}`,
    thumbnail: coverAt(first.artworkUrl100, 200),
    items,
    needs: one ? 'the full song' : 'the full songs',
    complete: false,
  };
}

// ---------------------------------------------------------------------------
// Thumbnails and covers: YouTube, YouTube Music, TikTok, Spotify
// ---------------------------------------------------------------------------

function youtubeId(url) {
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return url.pathname.slice(1).split('/')[0];
  if (!/^(youtube\.com|youtube-nocookie\.com)$/.test(host)) return '';
  if (url.searchParams.get('v')) return url.searchParams.get('v');
  const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(url.pathname);
  return m ? m[1] : '';
}

async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(LOOKUP_TIMEOUT) });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveYouTube(url, music) {
  const id = youtubeId(url);
  const site = music ? 'YouTube Music' : 'YouTube';
  if (!/^[\w-]{11}$/.test(id)) {
    return { site, title: site, items: [], needs: music ? 'these songs' : 'these videos', complete: false };
  }
  const meta = await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`).catch(() => null);
  if (!meta) throw userError('Couldn’t reach YouTube right now. Try again in a minute.');
  const title = (meta && meta.data && meta.data.title) || '';
  const author = (meta && meta.data && meta.data.author_name) || '';
  if (meta && meta.status === 401) throw userError('This video is private or can’t be embedded, so its details aren’t public.');
  if (meta && meta.status === 404 && !title) throw userError('YouTube couldn’t find that video.');
  const name = [title, `[${id}]`].filter(Boolean).join(' ');
  const hd = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  const variants = [];
  if (await exists(hd)) variants.push({ kind: 'image', label: 'Thumbnail, HD', detail: '1280 × 720 · JPG', url: hd, ext: 'jpg', filename: `${name} thumbnail` });
  variants.push({ kind: 'image', label: variants.length ? 'Thumbnail, small' : 'Thumbnail', detail: '480 × 360 · JPG', url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, ext: 'jpg', filename: `${name} thumbnail small` });
  return {
    site,
    title: title ? `${title}${author ? ` · ${author}` : ''}` : site,
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    items: [{ label: 'Thumbnail', variants }],
    needs: music ? 'the song' : 'the video',
    complete: false,
  };
}

async function resolveTikTok(url) {
  const res = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url.href)}`).catch(() => null);
  const d = res && res.data;
  if (!d || !d.thumbnail_url) {
    return { site: 'TikTok', title: 'TikTok', items: [], needs: 'this TikTok', complete: false };
  }
  const id = (/\/video\/(\d+)/.exec(url.pathname) || [])[1] || '';
  const name = [d.author_unique_id || d.author_name, id].filter(Boolean).join('_');
  return {
    site: 'TikTok',
    title: [d.title, d.author_name].filter(Boolean).join(' · ').slice(0, 140) || 'TikTok',
    thumbnail: d.thumbnail_url,
    items: [{ label: 'Cover', variants: [{ kind: 'image', label: 'Cover image', detail: [d.thumbnail_width && d.thumbnail_height ? `${d.thumbnail_width} × ${d.thumbnail_height}` : '', 'JPG'].filter(Boolean).join(' · '), url: d.thumbnail_url, ext: 'jpg', filename: `${name || 'tiktok'} cover` }] }],
    needs: 'the video',
    complete: false,
  };
}

async function resolveSpotify(url) {
  const res = await getJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(url.href)}`).catch(() => null);
  const d = res && res.data;
  const kind = (/^\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode|show)\//.exec(url.pathname) || [])[1] || '';
  const needs = kind === 'track' ? 'the song' : kind === 'episode' ? 'the episode' : 'the songs';
  if (!d || !d.thumbnail_url) return { site: 'Spotify', title: 'Spotify', items: [], needs, complete: false };
  // Album art: /image/ab67616d0000<size><hash>, where 82c1 is the original upload.
  const m = /\/image\/ab67616d0000(?:b273|1e02|4851|82c1)([0-9a-f]{24,})$/i.exec(d.thumbnail_url);
  const name = cleanName(d.title || 'Spotify');
  const variants = m
    ? [
        { kind: 'image', label: 'Cover art, full size', detail: 'Usually 640 to 2000 px · JPG', url: `https://i.scdn.co/image/ab67616d000082c1${m[1]}`, ext: 'jpg', filename: `${name} (cover)` },
        { kind: 'image', label: 'Cover art, 640 × 640', detail: 'JPG', url: `https://i.scdn.co/image/ab67616d0000b273${m[1]}`, ext: 'jpg', filename: `${name} (cover 640)` },
      ]
    : [{ kind: 'image', label: 'Cover image', detail: 'JPG', url: d.thumbnail_url, ext: 'jpg', filename: `${name} (cover)` }];
  return { site: 'Spotify', title: d.title || 'Spotify', thumbnail: d.thumbnail_url, items: [{ label: 'Cover art', variants }], needs, complete: false };
}

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

const EXTENSION_ONLY = [
  [/(^|\.)instagram\.com$/, 'Instagram', 'this post'],
  [/(^|\.)(facebook\.com|fb\.watch)$/, 'Facebook', 'this video'],
  [/(^|\.)snapchat\.com$/, 'Snapchat', 'this snap'],
  [/(^|\.)medal\.tv$/, 'Medal', 'this clip'],
];

export async function resolveOnWeb(href) {
  const url = new URL(href);
  const host = url.hostname.toLowerCase();
  if (X_HOST.test(host)) return resolveX(url);
  if (/(^|\.)twitch\.tv$/.test(host)) return resolveTwitch(url);
  if (host === 'music.apple.com') return resolveAppleMusic(url);
  if (host === 'music.youtube.com') return resolveYouTube(url, true);
  if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return resolveYouTube(url, false);
  if (/(^|\.)tiktok\.com$/.test(host)) return resolveTikTok(url);
  if (host === 'open.spotify.com' || host === 'spotify.link') return resolveSpotify(url);
  for (const [pattern, site, what] of EXTENSION_ONLY) {
    if (pattern.test(host)) return { site, title: site, items: [], needs: what, complete: false };
  }
  if (FILE_EXT.test(url.pathname)) {
    const file = decodeURIComponent(url.pathname.split('/').pop() || 'download');
    const ext = (FILE_EXT.exec(url.pathname)[1] || '').toLowerCase().replace('jpeg', 'jpg');
    return {
      site: host.replace(/^www\./, ''),
      title: file,
      items: [{ label: 'File', variants: [{ kind: 'file', label: file, detail: ext.toUpperCase(), url: url.href, ext, filename: file.replace(/\.[^.]+$/, '') }] }],
      needs: '',
      complete: true,
    };
  }
  return { site: host.replace(/^www\./, ''), title: host, items: [], needs: 'what’s on this page', complete: false };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Download a variant into memory (with progress) and save it under its own
 * name. If its server won't let the page read it, open it in a new tab instead,
 * where it can be saved by hand: resolves { opened: true } then.
 */
export async function save(variant, onProgress = () => {}) {
  let res;
  try {
    res = await fetch(variant.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    window.open(variant.url, '_blank', 'noopener,noreferrer');
    return { opened: true };
  }
  if (!res.ok) throw userError(res.status === 403 || res.status === 410 ? 'The link has expired. Look it up again.' : `The server answered ${res.status}. Try again.`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(total ? received / total : -1, received);
    }
  } else {
    chunks.push(new Uint8Array(await res.arrayBuffer()));
  }
  const blob = new Blob(chunks, { type: res.headers.get('content-type') || '' });
  const name = `${cleanName(variant.filename)}.${variant.ext || 'bin'}`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60 * 1000);
  return { name, size: blob.size };
}
