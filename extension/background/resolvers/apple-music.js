/*
 * Apple Music links (albums, songs, playlists, artists' top songs).
 *
 * Apple Music's own audio is DRM-protected, so it is never downloaded. Each
 * song is offered as:
 *  - the full song as MP3/M4A, found on YouTube Music ('song' jobs),
 *  - the cover art at its original size (mzstatic's thumbnail service never
 *    upscales, so asking for a huge box returns the largest it has),
 *  - Apple's preview clip (a plain AAC file), when there is one.
 *
 * Data: albums and songs come from the public iTunes Lookup API. Playlists and
 * artists aren't in it, so their track list is read from the page's embedded
 * JSON (<script id="serialized-server-data">) and filled in with one batched
 * lookup for previews, track numbers, genres and dates.
 *
 * Tags follow Apple Music: the artist string as Apple writes it ("The Weeknd &
 * Daft Punk"), album without " - Single"/" - EP", album artist, track and disc
 * numbers, genre, date and a 1400 px cover. Tracks of an album all share the
 * album's artist and release date (a track's own date is often its single's).
 * Lists carry Resolution.collection { name, artist, coverUrl, kind } for
 * "Download all" folders, ZIP names and mix tags.
 */
import '../../shared/util.js';
import { timedFetch, fetchText, userError } from '../net.js';
import { matchTrack, songVariants } from '../youtube.js';

const SITE = 'Apple Music';
const HOST = /^(embed\.|geo\.|beta\.)?music\.apple\.com$/i;
const PATH = /^\/(?:([a-z]{2})\/)?(album|song|playlist|artist)\/(?:[^/]+\/)?([^/]+)/i;

const COVER_MAX = 10000; // capped to the original by mzstatic (usually 1400 to 3000 px)
const COVER_TAG = 1400; // embedded in audio files
const THUMB = 160;
const LOOKUP_BATCH = 100;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** { kind: 'album' | 'song' | 'playlist' | 'artist', id, trackId, country } or null */
export function parseLink(url) {
  if (!HOST.test(url.hostname)) return null;
  const m = PATH.exec(url.pathname);
  if (!m) return null;
  const kind = m[2].toLowerCase();
  const id = m[3];
  if (kind === 'playlist' ? !/^pl\.[\w-]+$/i.test(id) : !/^\d{3,20}$/.test(id)) return null;
  const i = url.searchParams.get('i') || '';
  return { kind, id, trackId: kind === 'album' && /^\d{3,20}$/.test(i) ? i : '', country: (m[1] || 'us').toLowerCase() };
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

/**
 * An mzstatic artwork URL at another size. Works for lookup URLs (…/100x100bb.jpg)
 * and page templates (…/{w}x{h}bb.{f}, …/{w}x{h}{c}.{f}).
 */
export function coverAt(url, size) {
  const m = /^(https:\/\/[a-z0-9-]+\.mzstatic\.com\/image\/thumb\/.+)\/[^/]+$/i.exec(String(url || ''));
  return m ? `${m[1]}/${size}x${size}bb.jpg` : '';
}

/** Width and height from the start of a JPEG, or null. */
export function jpegSize(bytes) {
  const b = bytes;
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

/** The pixel size mzstatic will return for a cover, from its first few KB. Null if unknown. */
async function coverSize(url) {
  if (!url) return null;
  const res = await timedFetch(url, { headers: { Range: 'bytes=0-32767' } }, 4000);
  if (!res || !res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < 32768) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return jpegSize(bytes);
}

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

async function lookup(params) {
  const res = await timedFetch(`https://itunes.apple.com/lookup?${new URLSearchParams(params)}`, { headers: { Accept: 'application/json' } }, 15000);
  if (!res) throw userError('network', 'Couldn’t reach Apple Music. Check your connection and try again.');
  if (res.status === 403 || res.status === 429) throw userError('rate-limited', 'Apple Music is limiting requests right now. Wait a minute and try again.');
  if (!res.ok) throw userError('http', `Apple Music didn’t answer (HTTP ${res.status}). Try again.`);
  try {
    const data = await res.json();
    return Array.isArray(data && data.results) ? data.results : [];
  } catch {
    throw userError('bad-json', 'Apple Music sent something unexpected. Try again.');
  }
}

/** Lookup results for many song ids, keyed by id. Missing songs are simply absent. */
async function lookupSongs(ids, country) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const results = await lookup({ id: ids.slice(i, i + LOOKUP_BATCH).join(','), country }).catch(() => []);
    for (const r of results) if (r && r.kind === 'song' && r.trackId) found.set(String(r.trackId), r);
  }
  return found;
}

/** The embedded page data of an Apple Music page. */
async function pageData(href) {
  const html = await fetchText(href, { site: SITE, headers: { Accept: 'text/html' } });
  const start = html.indexOf('id="serialized-server-data"');
  const open = start >= 0 ? html.indexOf('>', start) : -1;
  const close = open >= 0 ? html.indexOf('</script>', open) : -1;
  if (close < 0) throw userError('no-data', 'Apple Music’s page didn’t include the song list. Try again in a moment.');
  try {
    return JSON.parse(html.slice(open + 1, close));
  } catch {
    throw userError('bad-json', 'Apple Music sent something unexpected. Try again.');
  }
}

function sectionsOf(data) {
  return ((data && data.data) || []).flatMap((entry) => (entry && entry.data && Array.isArray(entry.data.sections) ? entry.data.sections : []));
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

const plainAlbum = (name) => String(name || '').replace(/ - (Single|EP)$/i, '');
const isoDate = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value || '')) ? String(value).slice(0, 10) : '');

/** One song in the shape the rest of this file uses. */
function fromLookup(r) {
  return {
    id: String(r.trackId || ''),
    title: String(r.trackName || ''),
    artist: String(r.artistName || ''),
    album: String(r.collectionName || ''),
    albumArtist: String(r.collectionArtistName || r.artistName || ''),
    trackNumber: Number(r.trackNumber) || 0,
    tracksTotal: Number(r.trackCount) || 0,
    discNumber: Number(r.discNumber) || 0,
    discsTotal: Number(r.discCount) || 0,
    date: isoDate(r.releaseDate),
    genre: String(r.primaryGenreName || ''),
    durationMs: Number(r.trackTimeMillis) || 0,
    artwork: String(r.artworkUrl100 || ''),
    artWidth: 0,
    artHeight: 0,
    previewUrl: /^https:\/\//i.test(String(r.previewUrl || '')) ? r.previewUrl : '',
  };
}

/** A trackLockup (playlist, album page) or an artist top-songs entry. */
function fromPageItem(item, fallbackArtist = '') {
  const descriptor = item.contentDescriptor || {};
  const art = (item.artwork && item.artwork.dictionary) || {};
  const subtitle = ((item.subtitleLinks || [])[0] || {}).title || '';
  const tertiary = ((item.tertiaryLinks || [])[0] || {}).title || '';
  return {
    id: String((descriptor.identifiers && descriptor.identifiers.storeAdamID) || item.id || ''),
    title: String(item.title || ''),
    artist: String(item.artistName || (tertiary ? subtitle : '') || fallbackArtist),
    album: String(tertiary || (subtitle.includes(' · ') ? subtitle.split(' · ')[0] : '')),
    albumArtist: '',
    trackNumber: Number(item.trackNumber) || 0,
    tracksTotal: 0,
    discNumber: 0,
    discsTotal: 0,
    date: '',
    genre: '',
    durationMs: Number(item.duration) || 0,
    artwork: String(art.url || ''),
    artWidth: Number(art.width) || 0,
    artHeight: Number(art.height) || 0,
    previewUrl: '',
    kind: descriptor.kind || '',
  };
}

/** Page data first, then whatever the lookup knows better. */
function merge(page, found) {
  if (!found) return page;
  const better = fromLookup(found);
  const out = { ...page };
  for (const [key, value] of Object.entries(better)) if (value) out[key] = value;
  return out;
}

function splitArtists(artist) {
  return String(artist || '')
    .split(/\s*,\s*|\s+&\s+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

function tagsFor(t) {
  return {
    title: t.title,
    artist: t.artist,
    album: plainAlbum(t.album),
    albumArtist: t.albumArtist || undefined,
    trackNumber: t.trackNumber || undefined,
    tracksTotal: t.tracksTotal || undefined,
    discNumber: t.discsTotal > 1 ? t.discNumber : undefined,
    discsTotal: t.discsTotal > 1 ? t.discsTotal : undefined,
    date: t.date || undefined,
    genre: t.genre || undefined,
    coverUrl: coverAt(t.artwork, COVER_TAG) || undefined,
  };
}

const songName = (t) => (t.artist ? `${t.artist} - ${t.title}` : t.title);

/** Resolution.collection for a list, with the cover at the size used in tags. */
function collectionOf({ name, artist = '', artwork = '', kind }) {
  const coverUrl = coverAt(artwork, COVER_TAG);
  return { name: String(name || ''), ...(artist ? { artist: String(artist) } : {}), ...(coverUrl ? { coverUrl } : {}), kind };
}

/** Cover art and preview clip variants. */
function extras(t, probed) {
  const out = [];
  const size = probed || (t.artWidth && t.artHeight ? { width: Math.min(t.artWidth, COVER_MAX), height: Math.min(t.artHeight, COVER_MAX) } : null);
  const cover = coverAt(t.artwork, COVER_MAX);
  if (cover) {
    const coverName = t.album ? `${t.albumArtist || t.artist ? `${t.albumArtist || t.artist} - ` : ''}${plainAlbum(t.album)}` : songName(t);
    out.push({
      kind: 'image',
      group: 'Other',
      label: 'Cover art',
      detail: size ? `${size.width} × ${size.height} · JPG` : 'Largest size · JPG',
      url: cover,
      ext: 'jpg',
      filename: `${coverName} (cover)`,
      ...(size ? { width: size.width, height: size.height } : {}),
    });
  }
  if (t.previewUrl) {
    out.push({
      kind: 'audio',
      group: 'Other',
      label: 'Preview',
      detail: 'Apple Music’s short preview clip · AAC',
      url: t.previewUrl,
      ext: 'm4a',
      filename: `${songName(t)} (preview)`,
    });
  }
  return out;
}

function trackItem(t, number, size = null) {
  const filename = songName(t);
  const match = { title: t.title, artists: splitArtists(t.artist), album: plainAlbum(t.album), durationMs: t.durationMs };
  return {
    label: `${number}. ${t.title}${t.artist ? ` · ${t.artist}` : ''}`,
    thumbnail: coverAt(t.artwork, THUMB),
    variants: [...songVariants({ match, tags: tagsFor(t), filename }), ...extras(t, size)],
  };
}

// ---------------------------------------------------------------------------
// Resolutions
// ---------------------------------------------------------------------------

async function resolveSong(t) {
  const filename = songName(t);
  const tags = tagsFor(t);
  let failed = false;
  const [matched, size] = await Promise.all([
    matchTrack({ title: t.title, artists: splitArtists(t.artist), album: plainAlbum(t.album), durationMs: t.durationMs }).catch((err) => {
      failed = true;
      console.warn('[Just download it] Apple Music match', err);
      return null;
    }),
    coverSize(coverAt(t.artwork, COVER_MAX)),
  ]);
  const variants = [...(matched ? songVariants({ videoId: matched.videoId, matched, tags, filename }) : []), ...extras(t, size)];
  let notice;
  if (!matched) {
    const what = t.previewUrl ? 'the cover art and Apple’s preview clip are' : 'the cover art is';
    notice = failed
      ? `Couldn’t reach YouTube Music to find the full song just now, so only ${what} listed. Try again in a moment.`
      : `Couldn’t find this song on YouTube Music, so only ${what} listed.`;
  }
  return {
    site: SITE,
    title: t.title,
    ...(notice ? { notice } : {}),
    focus: 0,
    items: [{ label: [t.artist, plainAlbum(t.album)].filter(Boolean).join(' · ') || 'Song', thumbnail: coverAt(t.artwork, THUMB), variants }],
  };
}

async function resolveAlbum(link, url) {
  const results = await lookup({ id: link.id, entity: 'song', country: link.country, limit: 200 });
  const collection = results.find((r) => r.wrapperType === 'collection');
  // The album's own artist and release date for every track (a featured
  // artist's track would otherwise name them as album artist, and a track's
  // own date is often its single's).
  const albumArtist = String((collection && collection.artistName) || '');
  const albumDate = isoDate(collection && collection.releaseDate);
  const songs = results
    .filter((r) => r.wrapperType === 'track' && r.kind === 'song')
    .map(fromLookup)
    .map((t) => ({ ...t, albumArtist: albumArtist || t.albumArtist, date: albumDate || t.date }))
    .sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
  if (!songs.length) {
    // Brand-new or region-limited releases can be missing from the lookup API.
    if (collection || !results.length) return resolvePageList(link, url);
    throw userError('empty', 'This album has no songs Apple Music shares publicly.');
  }
  const size = await coverSize(coverAt(songs[0].artwork, COVER_MAX));
  const multiDisc = songs.some((s) => s.discsTotal > 1);
  const items = songs.map((t, i) => trackItem(t, t.trackNumber ? (multiDisc ? `${t.discNumber}-${t.trackNumber}` : t.trackNumber) : i + 1, size));
  const focus = link.trackId ? Math.max(0, songs.findIndex((s) => s.id === link.trackId)) : 0;
  const albumName = String((collection && collection.collectionName) || songs[0].album || '');
  return {
    site: SITE,
    title: albumName || 'Album',
    focus,
    items,
    collection: collectionOf({
      name: plainAlbum(albumName) || 'Album',
      artist: albumArtist || songs[0].albumArtist,
      artwork: (collection && collection.artworkUrl100) || songs[0].artwork,
      kind: 'album',
    }),
  };
}

/** Playlists, artists' top songs, and albums the lookup API doesn't know yet. */
async function resolvePageList(link, url) {
  const href = `https://music.apple.com${(PATH.exec(url.pathname) || [url.pathname])[0]}`; // no /see-all… suffix
  const sections = sectionsOf(await pageData(href));
  let title = '';
  let entries = [];
  let expected = 0;
  let owner = ''; // album artist, playlist curator, or the artist
  let headerArt = '';
  const artOf = (item) => String((item && item.artwork && item.artwork.dictionary && item.artwork.dictionary.url) || '');

  if (link.kind === 'artist') {
    const header = sections.find((s) => s.itemKind === 'artistDetailHeader');
    const head = (header && header.items && header.items[0]) || {};
    const artist = String(head.title || '');
    owner = artist;
    headerArt = artOf(head);
    const top = sections.find((s) => s.itemKind === 'artistFeaturedContentAndTracks');
    const tracks = (top && top.items && top.items[0] && top.items[0].tracks) || [];
    entries = tracks.map((item) => fromPageItem(item, artist));
    title = artist ? `${artist} · Top songs` : 'Top songs';
    if (!entries.length) {
      // No top-songs shelf on the page: the lookup API's songs for the artist.
      const results = await lookup({ id: link.id, entity: 'song', country: link.country, limit: 25 });
      entries = results.filter((r) => r.wrapperType === 'track' && r.kind === 'song').map(fromLookup);
    }
  } else {
    const header = sections.find((s) => s.itemKind === 'containerDetailHeaderLockup');
    const head = (header && header.items && header.items[0]) || {};
    title = String(head.title || '');
    expected = Number(head.trackCount) || 0;
    owner = String(((head.subtitleLinks || [])[0] || {}).title || '');
    headerArt = artOf(head);
    const list = sections.filter((s) => s.itemKind === 'trackLockup');
    entries = list.flatMap((s) => s.items || []).map((item) => fromPageItem(item));
    if (link.kind === 'album') {
      const count = expected || entries.length;
      entries = entries.map((e) => ({ ...e, album: e.album || title, albumArtist: e.albumArtist || owner, artist: e.artist || owner, tracksTotal: e.tracksTotal || count, artwork: e.artwork || headerArt }));
    }
  }

  entries = entries.filter((e) => e.title && (!e.kind || e.kind === 'song'));
  if (!entries.length) {
    throw userError('empty', link.kind === 'playlist' ? 'This playlist has no songs Apple Music shows publicly.' : link.kind === 'artist' ? 'Apple Music doesn’t list top songs for this artist.' : 'This album has no songs Apple Music shares publicly.');
  }

  // Fill in previews, track numbers, genres and dates (one request per 100 songs).
  const ids = entries.map((e) => e.id).filter((id) => /^\d+$/.test(id));
  const found = ids.length ? await lookupSongs(ids, link.country) : new Map();
  let songs = entries.map((e) => merge(e, found.get(e.id)));
  if (link.kind === 'album' && owner) songs = songs.map((t) => ({ ...t, albumArtist: owner })); // the album's artist, not each track's

  const items = songs.map((t, i) => trackItem(t, link.kind === 'album' && t.trackNumber ? t.trackNumber : i + 1));
  const focus = link.trackId ? Math.max(0, songs.findIndex((s) => s.id === link.trackId)) : 0;
  const notice = expected > songs.length ? `Apple Music’s page lists the first ${songs.length} of ${expected} songs, so those are shown here.` : undefined;
  const heading = title || (link.kind === 'playlist' ? 'Playlist' : 'Album');
  return {
    site: SITE,
    title: heading,
    ...(notice ? { notice } : {}),
    focus,
    items,
    collection: collectionOf({
      name: link.kind === 'album' ? plainAlbum(heading) : heading,
      artist: owner,
      artwork: headerArt || (link.kind === 'album' && songs[0] ? songs[0].artwork : ''),
      kind: link.kind,
    }),
  };
}

async function resolve(url) {
  const link = parseLink(url);
  if (!link) return null;

  if (link.kind === 'song' || link.trackId) {
    const id = link.kind === 'song' ? link.id : link.trackId;
    const results = await lookup({ id, country: link.country });
    const song = results.find((r) => r.wrapperType === 'track' && r.kind === 'song');
    if (song) return resolveSong(fromLookup(song));
    if (link.kind === 'album') return resolveAlbum(link, url);
    throw userError('not-found', 'Apple Music doesn’t have this song, or it isn’t available in this country.');
  }
  if (link.kind === 'album') return resolveAlbum(link, url);
  return resolvePageList(link, url);
}

export default {
  id: 'apple-music',
  matches: (url) => !!parseLink(url),
  resolve,
};
