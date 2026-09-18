/*
 * Just download it: resolve a link without a page (the toolbar popup, and
 * content scripts on sites whose data comes from public APIs).
 *
 * Each resolver module's default export:
 *   {
 *     id: 'spotify',
 *     matches(url: URL): boolean,
 *     resolve(url: URL): Promise<Resolution | null>,   // throws Errors with a userMessage
 *     originRules?: [{ domains: string[], origin: string, referer?: string }],
 *   }
 * Resolution is the same shape the page picker shows (see content/picker.js).
 *
 * Links no resolver handles (Instagram, TikTok, any web page…) are opened in a
 * background tab by the service worker and resolved there by the site handler.
 */
import youtubeMusic from './resolvers/youtube-music.js';
import youtube from './resolvers/youtube.js';
import spotify from './resolvers/spotify.js';
import appleMusic from './resolvers/apple-music.js';
import medal from './resolvers/medal.js';
import direct from './resolvers/direct.js';
import { ORIGIN_RULES as YOUTUBE_RULES } from './youtube.js';
import { installOriginRules } from './net.js';

export const RESOLVERS = [youtubeMusic, youtube, spotify, appleMusic, medal, direct];

let rulesReady = null;
export function ensureOriginRules() {
  if (!rulesReady) {
    const rules = [...YOUTUBE_RULES, ...RESOLVERS.flatMap((r) => (Array.isArray(r.originRules) ? r.originRules : []))];
    rulesReady = installOriginRules(rules).catch((err) => {
      rulesReady = null;
      console.warn('[Just download it] header rules', err);
    });
  }
  return rulesReady;
}

/** Turn what the user pasted into a URL, or null. */
export function parseLink(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  // Spotify's "Copy URI": spotify:track:ID, spotify:album:ID, spotify:playlist:ID…
  const uri = /^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]+)$/i.exec(text);
  if (uri) text = `https://open.spotify.com/${uri[1].toLowerCase()}/${uri[2]}`;
  // Pasted text sometimes carries a title before the link ("Song - Artist https://…").
  const embedded = /https?:\/\/\S+/i.exec(text);
  if (embedded) text = embedded[0];
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

export function resolverFor(url) {
  return RESOLVERS.find((r) => {
    try {
      return r.matches(url);
    } catch {
      return false;
    }
  }) || null;
}

/**
 * @returns { ok: true, resolution } | { ok: false, error } | { ok: false, needsTab: true }
 */
export async function resolveLink(raw) {
  const url = parseLink(raw);
  if (!url) return { ok: false, error: 'That doesn’t look like a link.' };
  const resolver = resolverFor(url);
  if (!resolver) return { ok: false, needsTab: true, url: url.href };
  await ensureOriginRules();
  try {
    const resolution = await resolver.resolve(url);
    if (!resolution) return resolver.id === 'direct' ? { ok: false, needsTab: true, url: url.href } : { ok: false, error: 'Couldn’t find anything to download at that link.' };
    return { ok: true, resolution };
  } catch (err) {
    if (!err || !err.userMessage) console.warn('[Just download it] resolve', resolver.id, err);
    return { ok: false, error: (err && err.userMessage) || 'Something went wrong while reading that link. Try again.' };
  }
}
