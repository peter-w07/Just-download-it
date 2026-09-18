/*
 * Spotify links: tracks, albums, playlists and artists (their top tracks).
 *
 * Spotify's audio is DRM-protected and is never downloaded or decrypted. What
 * the picker offers instead:
 *  - the full song as MP3 or M4A, found on YouTube Music ('song' jobs, see
 *    ../youtube.js) and tagged with Spotify's title, artists, album and cover;
 *  - the cover art at the largest size Spotify's image CDN keeps (up to 2000 px);
 *  - the 30-second preview MP3, where Spotify has one.
 *
 * How it works (checked against open.spotify.com in September 2026):
 *  - Everything comes from the public embed page, open.spotify.com/embed/<type>/<id>.
 *    Its __NEXT_DATA__ JSON holds the entity (name, artists, duration, release
 *    date, images, audioPreview) and, for albums, playlists and artists, a
 *    trackList (title, "Artist, Artist" subtitle, duration, preview; at most
 *    100 tracks). No login, no API key, no cookies. A missing or private entity
 *    comes back as pageProps.status 404.
 *  - Album art URLs look like /image/ab67616d0000<size><hash>; size 82c1 is
 *    the original upload (b273 = 640 px, 1e02 = 300 px, 4851 = 64 px).
 *  - A single track is matched on YouTube Music straight away, so the picker
 *    can say what it found. Tracks of a list are looked up when their download
 *    starts, so opening a 100-track playlist doesn't search 100 times.
 *  - Track lists carry no cover or date per track. Albums use the album's
 *    cover and read the date from the first track's embed. Playlists and
 *    artists read each track's embed, a few at a time and time-boxed.
 *
 * Tags (what ends up in the files and their names):
 *  - A track embed names no album, so a single track is looked up once in the
 *    iTunes Search API (../metadata.js) for its album, album artist, track
 *    number, genre and full date. Only a confident match is used.
 *  - Albums know album, album artist, track number and total from the album
 *    itself; one iTunes lookup of the first track adds the genre.
 *  - Playlists and artists' top tracks get title, artists, date and cover.
 *    They are never looked up per track while listing; the service worker
 *    fills in the album from iTunes when each song is downloaded.
 *  - Lists carry Resolution.collection { name, artist, coverUrl, kind } for
 *    "Download all" folders, ZIP names and mix tags.
 */
import { fetchText, userError } from '../net.js';
import { matchTrack, songVariants } from '../youtube.js';
import { enrichSong } from '../metadata.js';

const SITE = 'Spotify';
const EMBED_TTL_MS = 10 * 60 * 1000;
const EMBED_CACHE_MAX = 400;
const TRACK_LOOKUP_CONCURRENCY = 8;
const TRACK_LOOKUP_BUDGET_MS = 5000;
const EMBED_TRACK_LIMIT = 100;

// /track/<id>, /intl-de/album/<id>, /embed/playlist/<id>, /user/<name>/playlist/<id>
const ENTITY_PATH = /^\/(?:intl-[a-z]{2}(?:-[a-z0-9]{2,4})?\/)?(?:embed\/)?(?:user\/[^/]+\/)?(track|album|playlist|artist)\/([A-Za-z0-9]{22})(?:\/|$)/i;

const NOT_FOUND = {
  track: 'Spotify says this song doesn’t exist (the link may be wrong, or the song was removed).',
  album: 'Spotify says this album doesn’t exist (the link may be wrong, or the album was removed).',
  playlist: 'Spotify doesn’t share this playlist publicly (it may be private or deleted).',
  artist: 'Spotify says this artist doesn’t exist (the link may be wrong).',
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** { type, id } for an open.spotify.com link, or null. */
export function parseSpotifyUrl(href) {
  let u;
  try {
    u = new URL(String(href || ''));
  } catch {
    return null;
  }
  if (!/^(open|play)\.spotify\.com$/i.test(u.hostname)) return null;
  const m = ENTITY_PATH.exec(u.pathname);
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
}

/** The entity inside an embed page. Throws a userMessage error if it's missing. */
export function entityFromEmbed(html, type) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
  let data = null;
  try {
    data = m ? JSON.parse(m[1]) : null;
  } catch {
    data = null;
  }
  const props = data && data.props && data.props.pageProps;
  if (!props) throw userError('bad-page', 'Spotify sent something unexpected. Try again.');
  const entity = props.state && props.state.data && props.state.data.entity;
  if (Number(props.status) === 404 || !entity || typeof entity !== 'object') {
    throw userError('not-found', NOT_FOUND[type] || NOT_FOUND.track);
  }
  return entity;
}

/** "The Weeknd, Daft Punk" -> ['The Weeknd', 'Daft Punk'] */
export function splitArtists(text) {
  return String(text || '')
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/** Every https image of an entity, largest first. */
function imagesOf(entity) {
  const list = [];
  const visual = entity.visualIdentity && entity.visualIdentity.image;
  for (const img of Array.isArray(visual) ? visual : []) {
    if (img && img.url) list.push({ url: String(img.url), width: Number(img.maxWidth) || 0 });
  }
  const sources = entity.coverArt && entity.coverArt.sources;
  for (const s of Array.isArray(sources) ? sources : []) {
    if (s && s.url) list.push({ url: String(s.url), width: Number(s.width) || 0 });
  }
  return list.filter((i) => /^https:\/\//i.test(i.url)).sort((a, b) => b.width - a.width);
}

/** Album art at its original size (up to 2000 px), or '' if the URL isn't album art. */
export function originalCoverUrl(url) {
  const m = /\/image\/ab67616d0000(?:b273|1e02|4851|82c1)([0-9a-f]{24,})$/i.exec(String(url || ''));
  return m ? `https://i.scdn.co/image/ab67616d000082c1${m[1]}` : '';
}

/**
 * The cover of an entity: `full` for saving and tagging, `thumb` for the picker.
 * @returns { full, thumb, detail } or null
 */
export function coverOf(entity) {
  const images = imagesOf(entity || {});
  if (!images.length) return null;
  const best = images[0];
  const thumb = images.filter((i) => i.width >= 160 && i.width <= 320).sort((a, b) => b.width - a.width)[0] || best;
  const original = originalCoverUrl(best.url);
  return {
    full: original || best.url,
    thumb: thumb.url,
    detail: original ? 'Largest size (up to 2000 × 2000) · JPG' : best.width ? `${best.width} × ${best.width} · JPG` : 'JPG',
  };
}

/** "2020-03-20" from an entity's releaseDate, or ''. */
export function dateOf(entity) {
  const iso = entity && entity.releaseDate && entity.releaseDate.isoString;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ''));
  return m ? m[1] : '';
}

function previewOf(entity) {
  const url = entity && entity.audioPreview && entity.audioPreview.url;
  return /^https:\/\/p\.scdn\.co\//i.test(String(url || '')) ? String(url) : '';
}

function idFromUri(uri) {
  const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(String(uri || ''));
  return m ? m[1] : '';
}

function fileBase(artist, title) {
  return [artist, title].filter(Boolean).join(' - ') || 'Spotify';
}

/** The cover art and preview rows shown under "Other". */
function otherVariants({ cover, coverName, preview, name }) {
  const out = [];
  if (cover) {
    out.push({ kind: 'image', group: 'Other', label: 'Cover art', detail: cover.detail, url: cover.full, ext: 'jpg', filename: `${coverName} (cover)` });
  }
  if (preview) {
    out.push({ kind: 'audio', group: 'Other', label: '30-second preview', detail: 'MP3 · Spotify’s preview clip', url: preview, ext: 'mp3', filename: `${name} (preview)` });
  }
  return out;
}

function withoutEmpty(tags) {
  return Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== '' && v != null && v !== 0));
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const embedCache = new Map();

function fetchEntity(type, id) {
  const key = `${type}:${id}`;
  const hit = embedCache.get(key);
  if (hit && Date.now() - hit.time < EMBED_TTL_MS) return hit.promise;
  const promise = fetchText(`https://open.spotify.com/embed/${type}/${id}`, { site: SITE }).then((html) => entityFromEmbed(html, type));
  embedCache.set(key, { time: Date.now(), promise });
  promise.catch(() => embedCache.delete(key));
  if (embedCache.size > EMBED_CACHE_MAX) embedCache.delete(embedCache.keys().next().value);
  return promise;
}

/**
 * Cover and release date for each track id, from the tracks' own embed pages.
 * Stops starting new requests once the time budget is used up or Spotify
 * pushes back; tracks without details just get no cover.
 */
async function trackDetails(ids) {
  const queue = [...new Set(ids.filter(Boolean))];
  const found = new Map();
  let stopped = false;
  const worker = async () => {
    while (!stopped && queue.length) {
      const id = queue.shift();
      try {
        const entity = await fetchEntity('track', id);
        found.set(id, { cover: coverOf(entity), date: dateOf(entity) });
      } catch (err) {
        if (err && (err.code === 'rate-limited' || err.code === 'network')) stopped = true;
      }
    }
  };
  let timer = 0;
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(TRACK_LOOKUP_CONCURRENCY, queue.length) }, worker)),
    new Promise((resolve) => {
      timer = setTimeout(resolve, TRACK_LOOKUP_BUDGET_MS);
    }),
  ]);
  clearTimeout(timer);
  stopped = true;
  return new Map(found);
}

// ---------------------------------------------------------------------------
// Resolutions
// ---------------------------------------------------------------------------

async function resolveTrack(id) {
  const entity = await fetchEntity('track', id);
  const title = cleanText(entity.name || entity.title);
  const artistList = Array.isArray(entity.artists) ? entity.artists.map((a) => cleanText(a && a.name)).filter(Boolean) : [];
  const artists = artistList.length ? artistList : splitArtists(entity.subtitle);
  const artist = artists.join(', ');
  const durationMs = Number(entity.duration) || 0;
  const cover = coverOf(entity);
  const preview = previewOf(entity);
  const name = fileBase(artist, title);

  // The album comes from iTunes (the embed doesn't name it), never from
  // YouTube Music's match, which is often the single and wouldn't go with
  // Spotify's cover. Both lookups run at the same time.
  let lookupFailed = false;
  const [matched, tags] = await Promise.all([
    matchTrack({ title, artists, album: '', durationMs }).catch(() => {
      lookupFailed = true; // YouTube Music didn't answer; look again when the download starts
      return null;
    }),
    enrichSong(withoutEmpty({ title, artist, date: dateOf(entity), coverUrl: cover ? cover.full : '' }), { durationMs }),
  ]);

  const variants = [];
  if (matched) variants.push(...songVariants({ videoId: matched.videoId, matched, tags, filename: name }));
  else if (lookupFailed) variants.push(...songVariants({ match: { title, artists, album: tags.album || '', durationMs }, tags, filename: name }));
  const coverName = tags.album ? fileBase(tags.albumArtist || artist, tags.album) : name;
  variants.push(...otherVariants({ cover, coverName, preview, name }));

  let notice = '';
  if (!matched && !lookupFailed) {
    const rest = cover && preview ? 'the cover art and preview' : cover ? 'the cover art' : preview ? 'the preview' : '';
    notice = rest ? `Couldn’t find this song on YouTube Music, so only ${rest} can be saved.` : 'Couldn’t find this song on YouTube Music.';
  }
  if (!variants.length) throw userError('no-match', notice || 'Couldn’t find anything to download for this song.');

  return {
    site: SITE,
    title: title || 'Spotify song',
    ...(notice ? { notice } : {}),
    focus: 0,
    items: [{ label: [artist, tags.album].filter(Boolean).join(' · ') || 'Song', thumbnail: cover ? cover.thumb : '', variants }],
  };
}

async function resolveList(type, id) {
  const entity = await fetchEntity(type, id);
  const listName = cleanText(entity.name || entity.title);
  const all = Array.isArray(entity.trackList) ? entity.trackList : [];
  const rows = all.filter((row) => row && cleanText(row.title) && (row.entityType === 'track' || idFromUri(row.uri)));
  if (!rows.length) {
    throw userError(
      'empty',
      type === 'artist' ? 'Spotify doesn’t list any top tracks for this artist.' : `Spotify doesn’t share any songs from this ${type}.`,
    );
  }

  const listCover = coverOf(entity);
  const isAlbum = type === 'album';
  // The album's artists as Spotify shows them ("Daft Punk"), else the first track's first artist.
  const albumArtist = isAlbum ? cleanText(entity.subtitle) || splitArtists(rows[0].subtitle)[0] || '' : '';
  let albumDate = dateOf(entity);
  let genre = '';
  let details = new Map();
  if (isAlbum) {
    // The release date is on the tracks' embeds, the genre in iTunes (one
    // lookup for the whole album, only kept when it matches this album).
    const first = idFromUri(rows[0].uri);
    const [date, probe] = await Promise.all([
      !albumDate && first ? fetchEntity('track', first).then(dateOf, () => '') : albumDate,
      enrichSong({ title: cleanText(rows[0].title), artist: cleanText(rows[0].subtitle), album: listName }, { durationMs: Number(rows[0].duration) || 0 }),
    ]);
    const sameAlbum = !!probe.albumArtist; // fillTags only adds album details when the album names agree
    albumDate = date || (sameAlbum ? probe.date || '' : '');
    genre = probe.genre || '';
  } else {
    details = await trackDetails(rows.map((row) => idFromUri(row.uri)));
  }
  const albumName = isAlbum ? fileBase(albumArtist, listName) : '';

  const items = rows.map((row, i) => {
    const n = i + 1;
    const title = cleanText(row.title);
    const artist = cleanText(row.subtitle);
    const artists = splitArtists(artist);
    const durationMs = Number(row.duration) || 0;
    const info = details.get(idFromUri(row.uri)) || {};
    const cover = isAlbum ? listCover : info.cover || null;
    const name = fileBase(artist, title);
    const tags = withoutEmpty({
      title,
      artist,
      album: isAlbum ? listName : '',
      albumArtist,
      trackNumber: isAlbum ? n : 0,
      tracksTotal: isAlbum ? rows.length : 0,
      date: isAlbum ? albumDate : info.date || '',
      genre,
      coverUrl: cover ? cover.full : '',
    });
    const variants = [
      ...songVariants({ match: { title, artists, album: isAlbum ? listName : '', durationMs }, tags, filename: name }),
      ...otherVariants({ cover, coverName: isAlbum ? albumName : name, preview: previewOf(row), name }),
    ];
    const thumb = cover || listCover;
    return { label: `${n}. ${title}${artist ? ` · ${artist}` : ''}`, thumbnail: thumb ? thumb.thumb : '', variants };
  });

  const notice = type === 'playlist' && all.length >= EMBED_TRACK_LIMIT
    ? `Spotify only shares the first ${EMBED_TRACK_LIMIT} songs of a playlist, so any after that aren’t listed.`
    : '';

  const title = type === 'artist' ? `${listName || 'Artist'} · Top tracks` : listName || (isAlbum ? 'Spotify album' : 'Spotify playlist');
  // Albums: the album artist. Playlists: the owner Spotify shows ("Spotify", a user name). Artists: the artist.
  const collection = withoutEmpty({
    name: title,
    artist: isAlbum ? albumArtist : type === 'artist' ? listName : cleanText(entity.subtitle),
    coverUrl: listCover ? listCover.full : '',
    kind: type,
  });
  return {
    site: SITE,
    title,
    ...(notice ? { notice } : {}),
    focus: 0,
    items,
    collection,
  };
}

export default {
  id: 'spotify',
  matches: (url) => !!parseSpotifyUrl(url.href),
  resolve(url) {
    const entity = parseSpotifyUrl(url.href);
    if (!entity) return Promise.resolve(null);
    return entity.type === 'track' ? resolveTrack(entity.id) : resolveList(entity.type, entity.id);
  },
};
