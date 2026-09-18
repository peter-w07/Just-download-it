/*
 * Just download it: YouTube and YouTube Music, called from the service worker.
 *
 * Used for pasted links, for YouTube Music, and to find songs from Spotify and
 * Apple Music on YouTube Music (their own audio is DRM-protected; YouTube
 * Music's isn't). Requests never send cookies. See net.js for why Origin is
 * rewritten.
 *
 * Exports:
 *   ORIGIN_RULES                      header rules for net.installOriginRules
 *   innertube(host, endpoint, body)   raw InnerTube call (WEB_REMIX client)
 *   fetchPlayer(videoId)              player response with plain stream URLs
 *   resolveVideo(videoId, options)    picker resolution for a video (audio-first for music)
 *   searchMusic(query, kind)          YouTube Music search results ('songs' | 'videos')
 *   matchTrack(track)                 best YouTube Music match for a song from elsewhere
 *   songVariants(song)                MP3/M4A picker variants for a song ('song' jobs)
 *   songAudio(job)                    at download time: the stream to use for a 'song' job
 *   bestThumbnail(thumbnails)         largest thumbnail URL
 */
import '../shared/util.js';
import '../content/handlers/youtube.js';
import { timedFetch, userError } from './net.js';

const { youtube } = globalThis.JDI;

export const ORIGIN_RULES = [
  { domains: ['music.youtube.com'], origin: 'https://music.youtube.com' },
  { domains: ['www.youtube.com'], origin: 'https://www.youtube.com' },
];

const WEB_REMIX = {
  headerId: '67',
  version: '1.20250101.01.00',
  context: { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00' },
};

const PLAYER_TTL_MS = 30 * 60 * 1000;
const VISITOR_TTL_MS = 6 * 60 * 60 * 1000;

// Search filters (the "params" YouTube Music's own filter chips send).
const SEARCH_PARAMS = {
  songs: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
  videos: 'EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D',
};

// ---------------------------------------------------------------------------
// InnerTube
// ---------------------------------------------------------------------------

let visitorPromise = null;

/** A visitor id makes YouTube treat these requests like a normal logged-out session. */
function visitorData() {
  if (!visitorPromise) {
    visitorPromise = (async () => {
      const stored = await chrome.storage.session.get('ytVisitor').catch(() => ({}));
      const hit = stored.ytVisitor;
      if (hit && hit.value && Date.now() - hit.time < VISITOR_TTL_MS) return hit.value;
      const res = await timedFetch('https://music.youtube.com/youtubei/v1/visitor_id?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': WEB_REMIX.headerId, 'X-YouTube-Client-Version': WEB_REMIX.version },
        body: JSON.stringify({ context: { client: { ...WEB_REMIX.context, hl: 'en' } } }),
      });
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      const value = (data && data.responseContext && data.responseContext.visitorData) || '';
      if (value) await chrome.storage.session.set({ ytVisitor: { value, time: Date.now() } }).catch(() => {});
      return value;
    })().catch(() => '');
    // Retry later if it failed.
    visitorPromise.then((v) => {
      if (!v) visitorPromise = null;
    });
  }
  return visitorPromise;
}

/**
 * POST to InnerTube.
 * @param host      'music.youtube.com' | 'www.youtube.com'
 * @param endpoint  'search' | 'browse' | 'next' | 'player' | …
 * @param body      request body without `context`
 * @param client    { headerId, version, context } (default WEB_REMIX)
 */
export async function innertube(host, endpoint, body, client = WEB_REMIX) {
  const visitor = await visitorData();
  const res = await timedFetch(`https://${host}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': client.headerId,
      'X-YouTube-Client-Version': client.version,
      ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}),
    },
    body: JSON.stringify({ context: { client: { ...client.context, hl: 'en', ...(visitor ? { visitorData: visitor } : {}) } }, ...body }),
  });
  if (!res) throw userError('network', 'Couldn’t reach YouTube. Check your connection and try again.');
  if (res.status === 403 || res.status === 429) {
    throw userError('rate-limited', 'YouTube is limiting requests from this computer right now. Wait a few minutes and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw userError('failed', `YouTube didn’t answer (HTTP ${res.status}). Try again.`);
  return data;
}

const playerCache = new Map();

/**
  * The player response for a video, checked to contain usable streams.
  * @param options.fresh  ask YouTube again instead of reusing the cached answer
  *                       (stream links are tied to time and place, and a link
  *                       that has gone stale answers 403)
  */
export function fetchPlayer(videoId, { fresh = false } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId))) return Promise.reject(userError('bad-id', 'That isn’t a YouTube video link.'));
  if (fresh) playerCache.delete(videoId);
  const hit = playerCache.get(videoId);
  if (hit && Date.now() - hit.time < PLAYER_TTL_MS) return hit.promise;
  const promise = (async () => {
    let lastError = null;
    for (const client of youtube.CLIENTS) {
      try {
        const data = await innertube('www.youtube.com', 'player', {
          videoId,
          playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
          contentCheckOk: true,
          racyCheckOk: true,
        }, client);
        youtube.buildResolution(data, videoId); // throws a userMessage error if unusable
        return data;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || userError('failed', 'YouTube didn’t answer. Try again.');
  })();
  playerCache.set(videoId, { time: Date.now(), promise });
  promise.catch(() => playerCache.delete(videoId));
  return promise;
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

/**
 * Picker resolution for one YouTube video.
 * @param options.music  audio first, site "YouTube Music", tags on the audio files
 * @param options.tags   { title, artist, album, coverUrl, … } for the audio files
 */
export async function resolveVideo(videoId, { music = false, tags = null } = {}) {
  const player = await fetchPlayer(videoId);
  const resolution = youtube.buildResolution(player, videoId);
  if (!music) return resolution;

  const details = player.videoDetails || {};
  const songTags = { title: String(details.title || ''), artist: String(details.author || '').replace(/ - Topic$/, ''), ...(tags || {}) };
  const artist = songTags.artist;
  const item = resolution.items[0];
  const audio = item.variants.filter((v) => v.kind === 'audio').map((v) => ({ ...v, group: undefined, job: { ...v.job, tags: songTags } }));
  // Official audio tracks ("Art tracks") are a still image, so their video qualities aren't worth offering.
  const stillImage = String(details.musicVideoType || '') === 'MUSIC_VIDEO_TYPE_ATV';
  const video = stillImage ? [] : item.variants.filter((v) => v.kind === 'video').map((v) => ({ ...v, group: 'Music video' }));
  const other = item.variants.filter((v) => v.kind !== 'audio' && v.kind !== 'video');
  const base = `${artist ? `${artist} - ` : ''}${songTags.title || videoId}`;
  for (const v of [...audio, ...video]) v.filename = v.kind === 'video' ? `${base} ${v.label}` : base;
  return {
    ...resolution,
    site: 'YouTube Music',
    title: songTags.title || resolution.title,
    items: [{ ...item, label: artist ? `by ${artist}` : item.label, variants: [...audio, ...video, ...other] }],
  };
}

export function bestThumbnail(thumbnails) {
  const list = (Array.isArray(thumbnails) ? thumbnails : []).filter((t) => t && /^https:/i.test(String(t.url || '')));
  const best = list.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best ? best.url : '';
}

// ---------------------------------------------------------------------------
// YouTube Music search and matching
// ---------------------------------------------------------------------------

function runsText(runs) {
  return (Array.isArray(runs) ? runs : []).map((r) => (r && r.text) || '').join('');
}

function durationSeconds(text) {
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(String(text || '').trim());
  if (!m) return 0;
  return m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

function pageTypeOf(run) {
  const endpoint = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
  const config = endpoint && endpoint.browseEndpointContextSupportedConfigs;
  return (config && config.browseEndpointContextMusicConfig && config.browseEndpointContextMusicConfig.pageType) || '';
}

/** One row of a YouTube Music list (search results, playlists, albums) as plain data. */
export function parseListItem(renderer) {
  if (!renderer) return null;
  const columns = (renderer.flexColumns || []).map((c) => (c.musicResponsiveListItemFlexColumnRenderer || {}).text || {});
  const titleRuns = (columns[0] && columns[0].runs) || [];
  const infoRuns = (columns[1] && columns[1].runs) || [];
  const watch = titleRuns[0] && titleRuns[0].navigationEndpoint && titleRuns[0].navigationEndpoint.watchEndpoint;
  const videoId = (renderer.playlistItemData && renderer.playlistItemData.videoId) || (watch && watch.videoId) || '';
  if (!videoId) return null;
  const config = watch && watch.watchEndpointMusicSupportedConfigs && watch.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig;

  const artists = infoRuns.filter((r) => pageTypeOf(r) === 'MUSIC_PAGE_TYPE_ARTIST' || pageTypeOf(r) === 'MUSIC_PAGE_TYPE_USER_CHANNEL').map((r) => r.text);
  // Search results put the album in the second column, playlists in the third.
  const albumRun = columns.flatMap((c) => c.runs || []).find((r) => pageTypeOf(r) === 'MUSIC_PAGE_TYPE_ALBUM');
  const segments = runsText(infoRuns).split(' • ');
  if (!artists.length && segments[0] && !durationSeconds(segments[0])) artists.push(segments[0]);
  let duration = durationSeconds(segments[segments.length - 1]);
  if (!duration) {
    const fixed = (renderer.fixedColumns || []).map((c) => runsText(((c.musicResponsiveListItemFixedColumnRenderer || {}).text || {}).runs));
    duration = durationSeconds(fixed[0]);
  }
  const thumbs = renderer.thumbnail && renderer.thumbnail.musicThumbnailRenderer && renderer.thumbnail.musicThumbnailRenderer.thumbnail;
  return {
    videoId,
    title: runsText(titleRuns),
    artists,
    album: albumRun ? albumRun.text : '',
    durationSec: duration,
    videoType: (config && config.musicVideoType) || '',
    thumbnail: bestThumbnail(thumbs && thumbs.thumbnails),
  };
}

/** Every musicResponsiveListItemRenderer in a response, parsed. */
export function collectListItems(data) {
  const out = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 60) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (node.musicResponsiveListItemRenderer) {
      const item = parseListItem(node.musicResponsiveListItemRenderer);
      if (item) out.push(item);
      return;
    }
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };
  walk(data, 0);
  return out;
}

export async function searchMusic(query, kind = 'songs') {
  const data = await innertube('music.youtube.com', 'search', { query: String(query).slice(0, 200), params: SEARCH_PARAMS[kind] || SEARCH_PARAMS.songs });
  const seen = new Set();
  return collectListItems(data).filter((item) => !seen.has(item.videoId) && seen.add(item.videoId));
}

const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');
const VERSION_WORDS = ['live', 'remix', 'cover', 'karaoke', 'instrumental', 'acoustic', 'sped', 'slowed', 'nightcore', 'reverb', '8d', 'demo', 'edit', 'extended', 'mix', 'version', 'lyrics', 'lyric', 'clean', 'explicit', 'mono', 'remaster', 'remastered'];
const HARMLESS_VERSION_WORDS = new Set(['lyrics', 'lyric', 'clean', 'explicit', 'mono', 'remaster', 'remastered', 'version', 'edit', 'mix']);

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Title without "(feat. …)", "- 2011 Remaster" and similar decorations. */
function coreTitle(title) {
  return normalize(
    String(title || '')
      .replace(/[([](?:feat|ft|with|prod)\.?\s[^)\]]*[)\]]/gi, ' ')
      .replace(/\s-\s.*(?:remaster|version|edit|mix|live|mono|stereo).*$/i, ' '),
  );
}

function tokens(text) {
  return new Set(normalize(text).split(' ').filter(Boolean));
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.max(a.size, b.size);
}

/** 0..1: how likely `candidate` is the same recording as `track`. */
export function matchScore(track, candidate) {
  const wantTitle = coreTitle(track.title);
  const gotTitle = coreTitle(candidate.title);
  let title = overlap(new Set(wantTitle.split(' ').filter(Boolean)), new Set(gotTitle.split(' ').filter(Boolean)));
  if (wantTitle && wantTitle === gotTitle) title = 1;

  const wantArtists = (track.artists || []).map(normalize).filter(Boolean);
  const gotArtists = normalize((candidate.artists || []).join(' '));
  let artist = 0.4; // unknown
  if (wantArtists.length) {
    if (gotArtists && gotArtists.includes(wantArtists[0])) artist = 1;
    else if (wantArtists.some((a) => gotArtists.includes(a))) artist = 0.75;
    else if (normalize(candidate.title).includes(wantArtists[0])) artist = 0.6;
    else artist = 0;
  }

  const want = Number(track.durationMs) > 0 ? Number(track.durationMs) / 1000 : 0;
  const got = Number(candidate.durationSec) || 0;
  let duration = 0.5;
  if (want && got) {
    const d = Math.abs(want - got);
    duration = d <= 2 ? 1 : d <= 5 ? 0.85 : d <= 10 ? 0.6 : d <= 20 ? 0.25 : 0;
  }

  // "Live", "Remix", "Sped up"… in the result but not in the original.
  const original = tokens(track.title);
  const extra = VERSION_WORDS.filter((w) => !HARMLESS_VERSION_WORDS.has(w) && tokens(candidate.title).has(w) && !original.has(w)).length;

  let score = 0.45 * title + 0.3 * artist + 0.25 * duration - 0.25 * Math.min(extra, 2);
  if (candidate.videoType === 'MUSIC_VIDEO_TYPE_ATV') score += 0.05; // the official audio track
  return Math.max(0, Math.min(1, score));
}

const MATCH_THRESHOLD = 0.62;
const matchCache = new Map();

/**
 * Find a song on YouTube Music.
 * @param track { title, artists: string[], album?, durationMs? }
 * @returns { videoId, title, artists, album, durationSec, thumbnail, score } or null
 */
export function matchTrack(track) {
  const key = JSON.stringify([track.title, track.artists, track.durationMs]);
  if (matchCache.has(key)) return matchCache.get(key);
  const promise = (async () => {
    const artists = (track.artists || []).filter(Boolean);
    const query = `${artists.slice(0, 2).join(' ')} ${String(track.title || '').replace(/\s-\s.*remaster.*$/i, '')}`.trim();
    let best = null;
    for (const kind of ['songs', 'videos']) {
      const results = await searchMusic(query, kind);
      for (const candidate of results.slice(0, 10)) {
        const score = matchScore(track, candidate);
        if (!best || score > best.score) best = { ...candidate, score };
      }
      if (best && best.score >= 0.8) break;
    }
    return best && best.score >= MATCH_THRESHOLD ? best : null;
  })();
  matchCache.set(key, promise);
  promise.catch(() => matchCache.delete(key));
  if (matchCache.size > 500) matchCache.delete(matchCache.keys().next().value);
  return promise;
}

// ---------------------------------------------------------------------------
// Songs (downloaded through 'song' jobs)
// ---------------------------------------------------------------------------

function formatDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (!s) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * MP3 and M4A picker variants for a song. The stream is looked up when the
 * download starts, so a whole album can be listed without one request per track.
 *
 * @param song.videoId   YouTube video id, if already known (matched or from YouTube Music)
 * @param song.match     { title, artists, album, durationMs } to find it at download time instead
 * @param song.tags      { title, artist, album, albumArtist, trackNumber, tracksTotal, date, genre, coverUrl }
 * @param song.filename  file name without extension
 * @param song.matched   the match result, shown in the tooltip ("Audio found on YouTube Music: Title · Artist · 3:33")
 *
 * The details describe the file, so a song from Spotify reads as that song;
 * where the audio really comes from is in the `hint` (the row's tooltip).
 */
export function songVariants({ videoId = '', match = null, tags = {}, filename, matched = null }) {
  const hint = matched
    ? `Audio found on YouTube Music: ${[matched.title, (matched.artists || []).join(', '), formatDuration(matched.durationSec)].filter(Boolean).join(' · ')}`
    : videoId
      ? 'Audio from YouTube Music'
      : 'Audio is found on YouTube Music when you download';
  const url = videoId ? `https://music.youtube.com/watch?v=${videoId}` : 'https://music.youtube.com/';
  const job = (format) => ({ type: 'song', format, ...(videoId ? { videoId } : { match }), tags });
  return [
    { kind: 'audio', label: 'MP3', detail: 'Full song · MP3 with tags and cover', hint, url, ext: 'mp3', filename, job: job('mp3') },
    { kind: 'audio', label: 'M4A', detail: 'Full song · M4A (AAC) with tags and cover', hint, url, ext: 'm4a', filename, job: job('m4a') },
  ];
}

/**
 * At download time: which stream a 'song' job should use.
 * `job.fresh` skips the cached player response, for a second try after a
 * stream link went stale.
 * @returns { audio: url, codec }
 */
export async function songAudio(job) {
  let videoId = job.videoId;
  let thumbnail = '';
  if (!videoId) {
    const found = await matchTrack(job.match || {});
    if (!found) throw userError('no-match', `Couldn’t find “${(job.match && job.match.title) || 'this song'}” on YouTube Music.`);
    videoId = found.videoId;
    // Square album art at a useful size (…=w120-h120-l90-rj → …=w1200-h1200-l90-rj).
    thumbnail = String(found.thumbnail || '').replace(/=w\d+-h\d+/, '=w1200-h1200');
  }
  const player = await fetchPlayer(videoId, { fresh: !!job.fresh });
  const formats = [...((player.streamingData && player.streamingData.adaptiveFormats) || [])].filter(youtube.usableFormat);
  const audios = formats.filter((f) => /^audio\//.test(f.mimeType));
  const pick = job.format === 'mp3' ? youtube.pickAudio(audios, 'opus') || youtube.pickAudio(audios) : youtube.pickAudio(audios, 'mp4a') || youtube.pickAudio(audios);
  if (!pick) throw userError('no-audio', 'YouTube Music didn’t offer the audio for this song just now. Try again in a little while.');
  return { audio: pick.url, codec: youtube.codecOf(pick.mimeType), videoId, thumbnail };
}
