/*
 * Just download it: fuller song tags from the iTunes Search API.
 *
 * Some sources name a song but not its album. A Spotify track's embed page has
 * the title, artists, release date and cover, and nothing else. enrichSong()
 * looks the song up in Apple's public iTunes Search API
 * (itunes.apple.com/search, no key, no cookies) and fills in what is missing:
 * album, album artist, track and disc numbers, genre and date.
 *
 * Only a confident match is used. A result counts when it has
 *  - the same primary artist (accents, case and punctuation ignored),
 *  - the same title, ignoring "(feat. …)" and "- 2011 Remaster" decorations
 *    (so "Blinding Lights (Remix)" is a different song),
 *  - a duration within 3 seconds.
 * The same recording is usually on several releases (the album, the single, a
 * deluxe edition, a greatest-hits compilation). The pick prefers, in order:
 * the album the tags already name, no compilation ("Greatest Hits", "1967-1970"),
 * not a single or EP, no "Deluxe"/"Edition" decoration, a duration within 1 s,
 * then the oldest catalog entry (lowest collectionId: the original release).
 * If the tags already name a different album, only the genre (a property of
 * the song) is taken, so track numbers never come from another release.
 *
 * iTunes allows about 20 searches a minute. One shared limiter schedules them;
 * when no slot frees up within ~3 s, or Apple pushes back (403/429), the song
 * is skipped and its tags come back unchanged. Answers are cached in memory.
 */
import { timedFetch } from './net.js';

const SEARCH_URL = 'https://itunes.apple.com/search';
const RATE_LIMIT = 20; // searches per window
const RATE_WINDOW_MS = 60 * 1000;
const MAX_WAIT_MS = 3000;
const BACKOFF_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const DURATION_TOLERANCE_MS = 3000;
const CACHE_MAX = 300;

const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');
const FEATURING = /\s*[([](?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]/gi;
const REMASTER_BRACKET = /\s*[([][^)\]]*\bremaster(?:ed)?\b[^)\]]*[)\]]/gi;
const REMASTER_SUFFIX = /\s+-\s+[^-]*\bremaster(?:ed)?\b.*$/i;
const SINGLE_OR_EP = /\s-\s(?:Single|EP)$/i;
const COMPILATION = /\b(?:greatest hits|best of|the best|hits|highlights|essentials|collection|anthology|singles|now that'?s what|(?:19|20)\d\d\s*[-–]\s*(?:19|20)\d\d)\b/i;
const EDITION = /[([][^)\]]*\b(?:deluxe|expanded|edition|anniversary|bonus|special)\b[^)\]]*[)\]]/i;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Lowercase letters and digits only, accents removed, "&" read as "and". */
export function normalizeName(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** "The Weeknd, Daft Punk" and "The Weeknd & Daft Punk feat. X" -> "The Weeknd" */
export function primaryArtist(artist) {
  return String(artist || '').split(/\s*(?:,|&|\s(?:feat\.?|ft\.?|featuring)\s)\s*/i)[0].trim();
}

/** A title without "(feat. …)" and remaster decorations, as typed (for searching). */
export function plainTitle(title) {
  return String(title || '').replace(FEATURING, ' ').replace(REMASTER_BRACKET, ' ').replace(REMASTER_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}

/** "After Hours - Single" -> "After Hours" */
export function plainAlbum(name) {
  return String(name || '').replace(SINGLE_OR_EP, '').trim();
}

/** "2019-11-29T08:00:00Z" -> "2019-11-29", or ''. */
function isoDay(value) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  return m ? m[1] : '';
}

function positive(value) {
  const n = Math.floor(Number(value));
  return n > 0 ? n : 0;
}

/**
 * The best release of the wanted song among iTunes search results, or null
 * when none is a confident match.
 * @param want { title, artist, album?, durationMs }
 */
export function pickRelease(results, { title, artist, album = '', durationMs = 0 } = {}) {
  const wantTitle = normalizeName(plainTitle(title));
  const wantArtist = normalizeName(primaryArtist(artist));
  const wantArtistFull = normalizeName(artist);
  const wantAlbum = normalizeName(plainAlbum(album));
  const ms = Number(durationMs) || 0;
  if (!wantTitle || !wantArtist || !(ms > 0)) return null;

  const sameArtist = (name) => normalizeName(primaryArtist(name)) === wantArtist || (!!wantArtistFull && normalizeName(name) === wantArtistFull);
  const matches = (Array.isArray(results) ? results : []).filter(
    (r) =>
      r &&
      r.kind === 'song' &&
      normalizeName(plainTitle(r.trackName)) === wantTitle &&
      sameArtist(r.artistName) &&
      Number(r.trackTimeMillis) > 0 &&
      Math.abs(Number(r.trackTimeMillis) - ms) <= DURATION_TOLERANCE_MS,
  );
  if (!matches.length) return null;

  const rank = (r) => {
    const name = String(r.collectionName || '');
    return [
      wantAlbum && normalizeName(plainAlbum(name)) === wantAlbum ? 0 : 1,
      COMPILATION.test(name) || /^various artists$/i.test(String(r.collectionArtistName || '')) ? 1 : 0,
      SINGLE_OR_EP.test(name) ? 1 : 0,
      EDITION.test(name) ? 1 : 0,
      Math.abs(Number(r.trackTimeMillis) - ms) <= 1000 ? 0 : 1,
      Number(r.collectionId) || Number.MAX_SAFE_INTEGER,
    ];
  };
  const ranked = matches.map((r) => ({ r, key: rank(r) }));
  ranked.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return 0;
  });
  return ranked[0].r;
}

/**
 * `tags` with the gaps filled from an iTunes result. Never overwrites a value
 * that is already there, except a bare year ("2020") that the result's full
 * date agrees with.
 */
export function fillTags(tags, release) {
  const out = { ...tags };
  const r = release || {};
  const genre = String(r.primaryGenreName || '').trim();
  if (!out.genre && genre && genre !== 'Music') out.genre = genre;

  const releaseAlbum = plainAlbum(r.collectionName);
  if (!releaseAlbum) return out;
  if (out.album && normalizeName(plainAlbum(out.album)) !== normalizeName(releaseAlbum)) return out;

  if (!out.album) out.album = releaseAlbum;
  if (!out.albumArtist) {
    const albumArtist = String(r.collectionArtistName || r.artistName || '').trim();
    if (albumArtist) out.albumArtist = albumArtist;
  }
  const track = positive(r.trackNumber);
  if (!out.trackNumber && track) {
    out.trackNumber = track;
    const total = positive(r.trackCount);
    if (!out.tracksTotal && total >= track) out.tracksTotal = total;
  }
  const disc = positive(r.discNumber);
  const discs = positive(r.discCount);
  if (!out.discNumber && discs > 1 && disc && disc <= discs) {
    out.discNumber = disc;
    out.discsTotal = discs;
  }
  const day = isoDay(r.releaseDate);
  if (day && (!out.date || (/^\d{4}$/.test(String(out.date)) && day.startsWith(String(out.date))))) out.date = day;
  return out;
}

// ---------------------------------------------------------------------------
// Rate limit and search
// ---------------------------------------------------------------------------

const scheduled = []; // start times of searches in the last window (some may be just ahead)
let blockedUntil = 0;

/**
 * Wait for a search slot. Resolves false (without taking a slot) when the
 * wait would be longer than MAX_WAIT_MS or Apple recently pushed back.
 */
async function takeSlot() {
  const now = Date.now();
  if (now < blockedUntil) return false;
  while (scheduled.length && now - scheduled[0] >= RATE_WINDOW_MS) scheduled.shift();
  let start = Math.max(now, scheduled.length ? scheduled[scheduled.length - 1] : 0);
  if (scheduled.length >= RATE_LIMIT) start = Math.max(start, scheduled[scheduled.length - RATE_LIMIT] + RATE_WINDOW_MS);
  if (start - now > MAX_WAIT_MS) return false;
  scheduled.push(start);
  if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
  return true;
}

/** Only the fields pickRelease and fillTags read. */
function slim(r) {
  return {
    kind: r.kind,
    trackName: r.trackName,
    artistName: r.artistName,
    collectionName: r.collectionName,
    collectionArtistName: r.collectionArtistName,
    collectionId: r.collectionId,
    trackTimeMillis: r.trackTimeMillis,
    trackNumber: r.trackNumber,
    trackCount: r.trackCount,
    discNumber: r.discNumber,
    discCount: r.discCount,
    primaryGenreName: r.primaryGenreName,
    releaseDate: r.releaseDate,
  };
}

const searchCache = new Map();

/** Search results for a term, or null when skipped or failed (not cached). */
function search(term, country) {
  const key = `${country}|${term.toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit) return hit;
  const promise = (async () => {
    if (!(await takeSlot())) return null;
    const params = new URLSearchParams({ term, entity: 'song', limit: '25' });
    if (country) params.set('country', country);
    const res = await timedFetch(`${SEARCH_URL}?${params}`, { headers: { Accept: 'application/json' } }, FETCH_TIMEOUT_MS);
    if (!res) return null;
    if (res.status === 403 || res.status === 429) {
      blockedUntil = Date.now() + BACKOFF_MS;
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return Array.isArray(data && data.results) ? data.results.filter((r) => r && r.kind === 'song').map(slim) : null;
  })().catch(() => null);
  searchCache.set(key, promise);
  promise.then((results) => {
    if (!results) searchCache.delete(key);
  });
  if (searchCache.size > CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  return promise;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Song tags with album, album artist, track/disc numbers, genre and date
 * filled in from iTunes where a confident match exists. Never throws: on any
 * problem (no match, offline, rate-limited) the tags come back unchanged.
 *
 * @param tags     { title, artist, album?, … } as the source site gives them
 * @param options  durationMs: the song's length (required for a match)
 *                 country: iTunes store country code (default US)
 */
export async function enrichSong(tags, { durationMs = 0, country = '' } = {}) {
  try {
    if (!tags || typeof tags !== 'object') return tags;
    const title = String(tags.title || '').trim();
    const artist = String(tags.artist || '').trim();
    if (!title || !artist || !(Number(durationMs) > 0)) return tags;
    const code = /^[a-z]{2}$/i.test(String(country || '')) ? String(country).toUpperCase() : '';
    const results = await search(`${primaryArtist(artist)} ${plainTitle(title)}`.slice(0, 200), code);
    const release = results ? pickRelease(results, { title, artist, album: tags.album, durationMs }) : null;
    return release ? fillTags(tags, release) : tags;
  } catch {
    return tags;
  }
}
