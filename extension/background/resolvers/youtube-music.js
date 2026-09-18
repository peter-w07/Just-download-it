/*
 * YouTube Music links (music.youtube.com), resolved from the service worker
 * with the same InnerTube API the site uses (no cookies, so only public and
 * unlisted content).
 *
 *   /watch?v=ID[&list=…]       one song: audio first, tagged from the "next" endpoint
 *                              (from an album, the album's audio track rather than its music video)
 *   /browse/MPREb_…            an album: one item per track
 *   /playlist?list=OLAK5uy_…   an album's own playlist: resolved as the album
 *   /playlist?list=…           a playlist, following continuations up to MAX_TRACKS
 *   /browse/VL…                the same playlist
 *   /channel/UC…               an artist's top songs
 *   /@handle                   the same, for an artist’s handle
 *
 * Tracks of albums and playlists are lazy "song" jobs (songVariants): the
 * stream is looked up when the download starts, so listing costs one request
 * per 100 tracks.
 *
 * Tags: artists as YouTube Music writes them ("Daft Punk & Julian Casablancas"),
 * album, album artist, track number and total (albums), year, and 1200 px art.
 * A single song is also looked up once in the iTunes Search API (../metadata.js)
 * for its genre, and for track number, album artist and full date when iTunes
 * has the same album. Lists carry Resolution.collection { name, artist,
 * coverUrl, kind } for "Download all" folders, ZIP names and mix tags.
 */
import { innertube, fetchPlayer, resolveVideo, parseListItem, songVariants, bestThumbnail, matchScore } from '../youtube.js';
import { userError } from '../net.js';
import { enrichSong } from '../metadata.js';

const HOST = 'music.youtube.com';
const SITE = 'YouTube Music';
const MAX_TRACKS = 500;
const MAX_PAGES = 8;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{2,80}$/;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function runsText(runs) {
  return (Array.isArray(runs) ? runs : []).map((r) => (r && r.text) || '').join('');
}

function textOf(value) {
  return value ? runsText(value.runs) || String(value.simpleText || '') : '';
}

function browseIdOf(run) {
  const endpoint = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
  return (endpoint && endpoint.browseId) || '';
}

function pageTypeOf(run) {
  const endpoint = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
  const config = endpoint && endpoint.browseEndpointContextSupportedConfigs;
  return (config && config.browseEndpointContextMusicConfig && config.browseEndpointContextMusicConfig.pageType) || '';
}

/** Runs split on YouTube Music's " • " separators. */
function segments(runs) {
  const out = [[]];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run && String(run.text).trim() === '•') out.push([]);
    else out[out.length - 1].push(run);
  }
  return out.filter((s) => s.length);
}

/** The first object stored under `key` anywhere in `node` (depth-first). */
function findKey(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findKey(child, key, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (node[key]) return node[key];
  for (const k of Object.keys(node)) {
    const hit = findKey(node[k], key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Album art at another size. Google image URLs take their size after the last "=". */
function artAt(url, size) {
  const text = String(url || '');
  if (!/^https:\/\/[a-z0-9.-]+\.(googleusercontent|ggpht)\.com\//i.test(text)) return '';
  return /=[^/=]*$/.test(text) ? text.replace(/=[^/=]*$/, `=w${size}-h${size}-l90-rj`) : `${text}=w${size}-h${size}-l90-rj`;
}

function yearOf(text) {
  const m = /\b(1[89]\d\d|20\d\d)\b/.exec(String(text || ''));
  return m ? m[1] : '';
}

function withoutEmpty(tags) {
  const out = {};
  for (const [key, value] of Object.entries(tags)) if (value !== '' && value != null && value !== 0) out[key] = value;
  return out;
}

function notFound(what) {
  return userError('not-found', `YouTube Music can’t show this ${what}. It may be private, deleted, or not available in your country.`);
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

/** Title, artist, album, year and square art for a song, from the "next" endpoint. */
function songInfoFromNext(data, videoId) {
  const panels = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (node.playlistPanelVideoRenderer) {
      panels.push(node.playlistPanelVideoRenderer);
      return;
    }
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };
  walk(data && data.contents, 0);
  const panel = panels.find((p) => p.videoId === videoId) || panels.find((p) => p.selected);
  if (!panel) return null;

  const parts = segments(panel.longBylineText && panel.longBylineText.runs);
  const artist = parts.length ? runsText(parts[0]).trim() : '';
  const albumRun = parts.slice(1).flat().find((r) => browseIdOf(r).startsWith('MPREb_'));
  const year = parts.slice(1).map((s) => runsText(s).trim()).find((t) => /^\d{4}$/.test(t)) || '';
  const thumb = bestThumbnail(panel.thumbnail && panel.thumbnail.thumbnails);
  const config = panel.navigationEndpoint && panel.navigationEndpoint.watchEndpoint && panel.navigationEndpoint.watchEndpoint.watchEndpointMusicSupportedConfigs;
  return {
    title: textOf(panel.title).trim(),
    artist: artist.replace(/ - Topic$/, ''),
    album: albumRun ? String(albumRun.text || '').trim() : '',
    year,
    art: artAt(thumb, 1200),
    cover: artAt(thumb, 1200) || thumb,
    thumbnail: artAt(thumb, 240) || thumb,
    durationSec: durationOf(textOf(panel.lengthText)),
    videoType: (config && config.watchEndpointMusicConfig && config.watchEndpointMusicConfig.musicVideoType) || '',
  };
}

function durationOf(text) {
  const parts = String(text || '').trim().split(':').map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/**
 * Album pages list a song's music video where it has one ("Title (Official
 * Video)"). Opened from an album (list=OLAK5uy_…), the album's own audio track
 * is the song people mean. Returns its video id, or ''.
 */
async function albumTrackFor(info, listId) {
  const data = await innertube(HOST, 'browse', { browseId: `VL${listId}` }).catch(() => null);
  const shelf = data && data.contents ? findKey(data.contents, 'musicPlaylistShelfRenderer') : null;
  if (!shelf) return '';
  const wanted = { title: info.title, artists: info.artist ? [info.artist] : [], durationMs: info.durationSec * 1000 };
  let best = null;
  for (const row of rowsOf(shelf.contents)) {
    if (row.unavailable || row.videoType !== 'MUSIC_VIDEO_TYPE_ATV') continue;
    const score = matchScore(wanted, row);
    if (!best || score > best.score) best = { score, videoId: row.videoId };
  }
  return best && best.score >= 0.62 ? best.videoId : '';
}

async function resolveSong(videoId, listId = '') {
  fetchPlayer(videoId).catch(() => {}); // starts in parallel; resolveVideo reuses it
  const next = await innertube(HOST, 'next', { videoId }).catch(() => null);
  const info = next ? songInfoFromNext(next, videoId) : null;
  if (info && info.videoType && info.videoType !== 'MUSIC_VIDEO_TYPE_ATV' && /^OLAK5uy_/.test(listId)) {
    const audioId = await albumTrackFor(info, listId);
    if (audioId && audioId !== videoId) return resolveSong(audioId);
  }
  const found = info ? withoutEmpty({ title: info.title, artist: info.artist, album: info.album, date: info.year, coverUrl: info.cover }) : null;
  const tags = found ? await enrichSong(found, { durationMs: info.durationSec * 1000 }) : null;
  const resolution = await resolveVideo(videoId, { music: true, tags });
  if (!info) return resolution;

  const item = resolution.items[0];
  // Name files after the artist YouTube Music shows ("Daft Punk"), not the uploading channel ("DaftPunkVEVO").
  const variants = item.variants.map((v) => (v.kind === 'audio' && info.artist && info.title ? { ...v, filename: filenameFor(info.artist, info.title) } : v));
  if (info.art) {
    const other = variants.findIndex((v) => v.group === 'Other');
    const base = variants.find((v) => v.kind === 'audio');
    variants.splice(other < 0 ? variants.length : other, 0, {
      kind: 'image',
      group: 'Other',
      label: 'Album art',
      detail: '1200 × 1200 · JPG',
      url: info.art,
      ext: 'jpg',
      filename: `${(base && base.filename) || info.title || videoId} cover`,
    });
  }
  return {
    ...resolution,
    items: [{ ...item, label: info.artist ? `by ${info.artist}` : item.label, thumbnail: info.thumbnail || item.thumbnail, variants }],
  };
}

// ---------------------------------------------------------------------------
// Lists (albums, playlists, artists)
// ---------------------------------------------------------------------------

/** A list row as plain data, with its album (any column) and index. */
function parseRow(renderer, position) {
  if (renderer.musicItemRendererDisplayPolicy === 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT') return null; // not playable
  const item = parseListItem(renderer);
  if (!item) return null;
  let album = item.album;
  let albumId = '';
  for (const column of renderer.flexColumns || []) {
    const runs = ((column.musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs || [];
    const run = runs.find((r) => browseIdOf(r).startsWith('MPREb_'));
    if (run) {
      album = album || String(run.text || '');
      albumId = browseIdOf(run);
      break;
    }
  }
  const index = Number(runsText(renderer.index && renderer.index.runs)) || 0;
  const watch = findKey(renderer.flexColumns, 'watchEndpoint');
  return { ...item, artist: artistTextOf(renderer, item.artists), album, albumId, index: index || position, playlistId: (watch && watch.playlistId) || '' };
}

/**
 * A row's artists the way YouTube Music writes them ("Daft Punk & Julian
 * Casablancas"): the byline part that links to an artist. Falls back to the
 * artist names joined with ", ".
 */
function artistTextOf(renderer, artists) {
  const joined = artists.join(', ');
  for (const column of (renderer.flexColumns || []).slice(1)) {
    const runs = ((column.musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs || [];
    for (const part of segments(runs)) {
      if (!part.some((r) => /^MUSIC_PAGE_TYPE_(ARTIST|USER_CHANNEL)$/.test(pageTypeOf(r)))) continue;
      const text = runsText(part).replace(/\s+/g, ' ').trim();
      return text && text.length <= 300 && artists.every((a) => text.includes(a)) ? text : joined;
    }
  }
  return joined;
}

function rowsOf(contents, offset = 0) {
  const rows = [];
  let position = offset;
  for (const entry of Array.isArray(contents) ? contents : []) {
    if (!entry || !entry.musicResponsiveListItemRenderer) continue;
    position++;
    const row = parseRow(entry.musicResponsiveListItemRenderer, position);
    rows.push(row || { unavailable: true, index: position });
  }
  return rows;
}

function continuationOf(contents) {
  const list = Array.isArray(contents) ? contents : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i] && list[i].continuationItemRenderer;
    const token = c && c.continuationEndpoint && c.continuationEndpoint.continuationCommand && c.continuationEndpoint.continuationCommand.token;
    if (token) return token;
  }
  return '';
}

function label(position, title, artist) {
  return `${position}. ${title}${artist ? ` · ${artist}` : ''}`;
}

function filenameFor(artist, title) {
  return artist ? `${artist} - ${title}` : title;
}

function normalTitle(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

async function resolveAlbum(browseId, audioRows = null) {
  const data = await innertube(HOST, 'browse', { browseId });
  const header = data && data.contents ? findKey(data.contents, 'musicResponsiveHeaderRenderer') || findKey(data.contents, 'musicDetailHeaderRenderer') : null;
  const secondary = data && data.contents && data.contents.twoColumnBrowseResultsRenderer && data.contents.twoColumnBrowseResultsRenderer.secondaryContents;
  const shelf = findKey(secondary || (data && data.contents), 'musicShelfRenderer');
  if (!header || !shelf) throw notFound('album');

  const albumTitle = textOf(header.title).trim();
  const kind = runsText((segments(header.subtitle && header.subtitle.runs)[0]) || []).trim(); // Album, EP, Single
  const albumArtist = textOf(header.straplineTextOne).trim() || runsText((segments(header.subtitle && header.subtitle.runs)[1]) || []).trim();
  const year = yearOf(textOf(header.subtitle));
  const thumbs = findKey(header.thumbnail, 'thumbnails');
  const artSource = bestThumbnail(thumbs);
  const art = artAt(artSource, 1200) || artSource;
  const smallArt = artAt(artSource, 240) || artSource;

  const rows = rowsOf(shelf.contents);
  const tracksTotal = rows.length;

  // Album pages list the music video where a song has one. The album's own
  // playlist (OLAK5uy_…) has the plain audio tracks, which is what people want.
  let audio = audioRows;
  const audioPlaylist = (rows.find((r) => r.playlistId) || {}).playlistId || '';
  if (!audio && /^OLAK5uy_/.test(audioPlaylist) && rows.some((r) => r.videoType && r.videoType !== 'MUSIC_VIDEO_TYPE_ATV')) {
    const list = await innertube(HOST, 'browse', { browseId: `VL${audioPlaylist}` }).catch(() => null);
    const listShelf = list && list.contents ? findKey(list.contents, 'musicPlaylistShelfRenderer') : null;
    audio = listShelf ? rowsOf(listShelf.contents) : null;
  }
  const byTitle = new Map();
  for (const row of audio || []) {
    if (row.unavailable) continue;
    const key = normalTitle(row.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(row);
  }

  const items = [];
  rows.forEach((row, i) => {
    if (row.unavailable) return;
    const sameSpot = audio && audio.length === rows.length && audio[i] && !audio[i].unavailable && normalTitle(audio[i].title) === normalTitle(row.title) ? audio[i] : null;
    const pool = byTitle.get(normalTitle(row.title));
    const match = sameSpot || (pool && pool.length ? pool[0] : null);
    if (match && pool) pool.splice(pool.indexOf(match), 1);
    const videoId = (match && match.videoId) || row.videoId;
    const artist = row.artist || albumArtist;
    const trackNumber = row.index || i + 1;
    items.push({
      label: label(trackNumber, row.title, artist),
      thumbnail: smallArt || row.thumbnail,
      variants: songVariants({
        videoId,
        tags: withoutEmpty({ title: row.title, artist, album: albumTitle, albumArtist, trackNumber, tracksTotal, date: year, coverUrl: art }),
        filename: filenameFor(artist, row.title),
      }),
    });
  });
  if (!items.length) throw userError('empty', 'None of the songs on this album can be played on YouTube Music right now.');

  const skipped = rows.length - items.length;
  return {
    site: SITE,
    title: [albumTitle, albumArtist].filter(Boolean).join(' · ') || kind || 'Album',
    ...(skipped ? { notice: `${skipped} of ${rows.length} songs aren’t available on YouTube Music and were left out.` } : {}),
    focus: 0,
    items,
    collection: withoutEmpty({ name: albumTitle || kind || 'Album', artist: albumArtist, coverUrl: art, kind: 'album' }),
  };
}

/**
 * @param options.title       heading to use instead of the playlist's own (artist top songs)
 * @param options.asAlbum     an OLAK5uy_ playlist whose tracks share one album is shown as that album
 * @param options.collection  Resolution.collection fields to use instead of the playlist's (artist top songs)
 */
async function resolvePlaylist(listId, { title = '', asAlbum = true, collection = null } = {}) {
  if (!LIST_ID.test(listId)) throw userError('bad-link', 'That YouTube Music link looks incomplete.');
  if (/^(LM|LL|WL|SE)$/.test(listId)) {
    throw userError('private', 'Your own library (Liked music, Episodes for later) is private, so it can’t be downloaded as a list. Make a public or unlisted playlist from it instead.');
  }

  const data = await innertube(HOST, 'browse', { browseId: `VL${listId}` });
  const shelf = data && data.contents ? findKey(data.contents, 'musicPlaylistShelfRenderer') || findKey(data.contents, 'musicShelfRenderer') : null;
  if (!shelf) {
    // Curated playlists (RDCLAK5uy_…) browse fine; mixes and radios (RDAMVM…, RDEM…) don't.
    if (/^RD/.test(listId)) {
      throw userError('mix', 'YouTube Music mixes and radios are made for each listener, so they can’t be downloaded as a list. Open a song from it and download that instead.');
    }
    throw notFound('playlist');
  }

  let rows = rowsOf(shelf.contents);
  const albumIds = new Set(rows.filter((r) => !r.unavailable).map((r) => r.albumId));
  if (asAlbum && /^OLAK5uy_/.test(listId) && albumIds.size === 1) {
    const [albumId] = albumIds;
    if (albumId) return resolveAlbum(albumId, rows);
  }

  const header = findKey(data.contents, 'musicResponsiveHeaderRenderer') || findKey(data.contents, 'musicEditablePlaylistDetailHeaderRenderer') || findKey(data.contents, 'musicDetailHeaderRenderer');
  const microformat = data.microformat && data.microformat.microformatDataRenderer;
  const listTitle = (header && textOf(header.title).trim()) || (microformat && String(microformat.title || '')) || 'Playlist';
  const facepile = header && header.facepile && header.facepile.avatarStackViewModel;
  const owner = (facepile && facepile.text && String(facepile.text.content || '')) || (header && textOf(header.straplineTextOne).trim()) || '';
  const headerArt = header ? bestThumbnail(findKey(header.thumbnail, 'thumbnails')) : '';
  const countText = header ? textOf(header.secondSubtitle) : '';
  const declared = Number((/([\d,.]+)\s+(?:tracks|songs|videos|episodes)/i.exec(countText) || [])[1]?.replace(/[,.]/g, '')) || 0;

  let token = continuationOf(shelf.contents);
  for (let page = 0; token && rows.length < MAX_TRACKS && page < MAX_PAGES; page++) {
    const more = await innertube(HOST, 'browse', { continuation: token });
    const added = ((more && more.onResponseReceivedActions) || []).flatMap((a) => (a.appendContinuationItemsAction && a.appendContinuationItemsAction.continuationItems) || []);
    const next = rowsOf(added, rows.length);
    if (!next.length) break;
    rows = rows.concat(next);
    token = continuationOf(added);
  }
  const capped = rows.length > MAX_TRACKS || (!!token && rows.length >= MAX_TRACKS);
  rows = rows.slice(0, MAX_TRACKS);

  const items = [];
  rows.forEach((row, i) => {
    if (row.unavailable) return;
    const artist = row.artist;
    const coverUrl = artAt(row.thumbnail, 1200) || row.thumbnail;
    items.push({
      label: label(i + 1, row.title, artist),
      thumbnail: artAt(row.thumbnail, 120) || row.thumbnail,
      variants: songVariants({
        videoId: row.videoId,
        tags: withoutEmpty({ title: row.title, artist, album: row.album, coverUrl }),
        filename: filenameFor(artist, row.title),
      }),
    });
  });
  if (!items.length) throw userError('empty', 'This playlist is empty, or none of its songs can be played on YouTube Music.');

  const notices = [];
  if (capped) notices.push(`This playlist has ${declared > MAX_TRACKS ? declared : `more than ${MAX_TRACKS}`} songs. The first ${MAX_TRACKS} are listed.`);
  const skipped = rows.length - items.length;
  if (skipped) notices.push(`${skipped} unavailable ${skipped === 1 ? 'song was' : 'songs were'} left out.`);
  return {
    site: SITE,
    title: title || [listTitle, owner].filter(Boolean).join(' · '),
    ...(notices.length ? { notice: notices.join(' ') } : {}),
    focus: 0,
    items,
    collection: withoutEmpty({ name: listTitle, artist: owner, coverUrl: artAt(headerArt, 1200) || headerArt, kind: 'playlist', ...(collection || {}) }),
  };
}

async function resolveArtist(channelId) {
  const data = await innertube(HOST, 'browse', { browseId: channelId });
  const header = data && data.header ? Object.values(data.header)[0] : null;
  const name = header ? textOf(header.title).trim() : '';
  const shelf = data && data.contents ? findKey(data.contents, 'musicShelfRenderer') : null;
  if (!shelf) throw notFound('artist');
  const heading = `${name ? `${name} · ` : ''}Top songs`;

  // "Top songs" links to a playlist with all of them; the shelf only shows five.
  const seeAll = browseIdOf(((shelf.title && shelf.title.runs) || [])[0]) || (findKey(shelf.bottomEndpoint, 'browseEndpoint') || {}).browseId || '';
  // No coverUrl: the artist header is a wide banner, so a mix uses its first song's cover instead.
  const collection = withoutEmpty({ name: heading, artist: name, kind: 'artist' });
  if (/^VL/.test(seeAll)) {
    try {
      return await resolvePlaylist(seeAll.slice(2), { title: heading, asAlbum: false, collection: { ...collection, coverUrl: '' } });
    } catch {
      /* fall back to the shelf */
    }
  }
  const items = rowsOf(shelf.contents)
    .filter((row) => !row.unavailable)
    .map((row, i) => {
      const artist = row.artist || name;
      return {
        label: label(i + 1, row.title, artist),
        thumbnail: artAt(row.thumbnail, 120) || row.thumbnail,
        variants: songVariants({
          videoId: row.videoId,
          tags: withoutEmpty({ title: row.title, artist, album: row.album, coverUrl: artAt(row.thumbnail, 1200) || row.thumbnail }),
          filename: filenameFor(artist, row.title),
        }),
      };
    });
  if (!items.length) throw notFound('artist');
  return { site: SITE, title: heading, focus: 0, items, collection };
}

/** An artist's @handle link: ask YouTube Music which channel it is. */
async function resolveHandle(handle) {
  const data = await innertube(HOST, 'navigation/resolve_url', { url: `https://${HOST}/${handle}` });
  const browseId = String(((data && data.endpoint && data.endpoint.browseEndpoint) || {}).browseId || '');
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(browseId)) throw notFound('artist');
  return resolveArtist(browseId);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** What a music.youtube.com link points at, or null. */
export function parseMusicLink(url) {
  if (!url || url.hostname !== HOST) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/watch') {
    const v = url.searchParams.get('v') || '';
    const list = url.searchParams.get('list') || '';
    return VIDEO_ID.test(v) ? { kind: 'song', id: v, list: LIST_ID.test(list) ? list : '' } : null;
  }
  if (path === '/playlist') {
    const list = url.searchParams.get('list') || '';
    return LIST_ID.test(list) ? { kind: 'playlist', id: list } : null;
  }
  let m = /^\/browse\/(MPREb_[A-Za-z0-9_-]+)$/.exec(path);
  if (m) return { kind: 'album', id: m[1] };
  m = /^\/browse\/VL([A-Za-z0-9_-]+)$/.exec(path);
  if (m) return { kind: 'playlist', id: m[1] };
  m = /^\/(?:channel|browse)\/(UC[A-Za-z0-9_-]{22})$/.exec(path);
  if (m) return { kind: 'artist', id: m[1] };
  m = /^\/(@[\p{L}\p{N}._-]{1,100})$/u.exec(decodeURIComponentSafe(path));
  if (m) return { kind: 'handle', id: m[1] };
  return null;
}

export default {
  id: 'youtube-music',
  matches: (url) => !!parseMusicLink(url),
  resolve(url) {
    const link = parseMusicLink(url);
    if (!link) return Promise.resolve(null);
    if (link.kind === 'song') return resolveSong(link.id, link.list);
    if (link.kind === 'album') return resolveAlbum(link.id);
    if (link.kind === 'playlist') return resolvePlaylist(link.id);
    if (link.kind === 'handle') return resolveHandle(link.id);
    return resolveArtist(link.id);
  },
};
