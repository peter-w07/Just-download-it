/*
 * Just download it: shared helpers.
 *
 * This file is loaded three ways: as a classic content script, imported by the
 * module service worker, and imported by the Node unit tests. So it is written
 * as a plain IIFE that hangs everything off globalThis.JDI and uses no
 * import/export statements.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});

  const DEFAULT_SETTINGS = Object.freeze({
    // Folder inside the browser's download directory. Empty string = no folder.
    folder: 'Just Download It',
    // Put each site's downloads in its own subfolder (Just Download It/Instagram/...).
    perSiteFolders: true,
    // Ask where to save every file (Chrome's Save As dialog).
    saveAs: false,
    // Instagram: ask Instagram's web API for every available quality, using the
    // session you're already logged in with. Off = only what is visible on the page.
    instagramApi: true,
    // Skip the quality picker and save the best version straight away.
    skipPicker: false,
    // Add Download buttons to supported sites (next to YouTube's Like button,
    // in Instagram's post action row).
    pageButtons: true,

    // Songs (Spotify, Apple Music, YouTube Music)
    // File names: 'artist-title' (Artist - Title), 'title-artist' (Title - Artist) or 'title'.
    songFilename: 'artist-title',
    // 'mp3' or 'm4a': listed first ("Best") and used by Download all, ZIP.
    audioFormat: 'mp3',
    // MP3 bitrate in kbps: 128, 192, 256 or 320.
    mp3Bitrate: 256,
    // Write title, artist, album, track number and cover art into song files.
    embedTags: true,
    // "01 - " in front of each song when saving a whole album or playlist.
    numberTracks: true,
    // Save a whole album or playlist into a folder named after it.
    collectionFolders: true,

    // One mix from a whole playlist or album
    // 'mp3' or 'm4a'.
    mixFormat: 'mp3',
    // Seconds each song fades into the next (0 = no fade, up to 12).
    mixCrossfade: 6,
    // Even out the loudness between songs.
    mixNormalize: true,
  });

  // The host permissions everything depends on (content scripts, lookups, downloads).
  // Firefox may install the extension without them; the popup and settings ask for them.
  const SITE_ACCESS = { origins: ['<all_urls>'] };

  // The browser's name, for messages ("Chrome doesn't let extensions…"). Only for wording.
  const BROWSER_NAME = /\bFirefox\//.test(String(globalThis.navigator && navigator.userAgent)) ? 'Firefox' : 'Chrome';

  const SONG_FILENAME_PATTERNS = ['artist-title', 'title-artist', 'title'];
  const MP3_BITRATES = [128, 192, 256, 320];

  /** Settings from storage with every value checked (bad or missing values fall back to the defaults). */
  function cleanSettings(stored) {
    const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof DEFAULT_SETTINGS[key] === 'boolean') s[key] = !!s[key];
    }
    if (typeof s.folder !== 'string') s.folder = DEFAULT_SETTINGS.folder;
    if (!SONG_FILENAME_PATTERNS.includes(s.songFilename)) s.songFilename = DEFAULT_SETTINGS.songFilename;
    if (s.audioFormat !== 'mp3' && s.audioFormat !== 'm4a') s.audioFormat = DEFAULT_SETTINGS.audioFormat;
    if (s.mixFormat !== 'mp3' && s.mixFormat !== 'm4a') s.mixFormat = DEFAULT_SETTINGS.mixFormat;
    s.mp3Bitrate = MP3_BITRATES.includes(Number(s.mp3Bitrate)) ? Number(s.mp3Bitrate) : DEFAULT_SETTINGS.mp3Bitrate;
    const fade = Number(s.mixCrossfade);
    s.mixCrossfade = Number.isFinite(fade) ? Math.min(12, Math.max(0, Math.round(fade))) : DEFAULT_SETTINGS.mixCrossfade;
    return s;
  }

  // ---------------------------------------------------------------------------
  // Filenames
  // ---------------------------------------------------------------------------
  //
  // Mirrors Chromium's net::IsSafePortablePathComponent. A name that fails it
  // makes chrome.downloads.download reject the whole download with
  // "Invalid filename", so we clean names up front.

  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|clock\$)$/i;
  const WINDOWS_MAGIC_NAMES = new Set(['desktop.ini', 'thumbs.db', 'conin$', 'conout$']);
  const SHELL_EXTENSION = /\.(local|lnk|scf|url)$|\.\{[^{}]*\}$/i;
  const BACKSLASH = String.fromCharCode(92);
  // Illegal anywhere. Chrome also swaps "%" for "_" on its own, and "~" can form
  // a Windows 8.3 short name, which Chrome rejects.
  const REPLACE_WITH_UNDERSCORE = `<>:"/|?*%${BACKSLASH}`;

  function cleanChar(ch) {
    const c = ch.codePointAt(0);
    // Unicode noncharacters.
    if ((c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe) return '';
    // Control and format characters: joiners inside emoji sequences, bidi
    // overrides that can disguise an extension, tag characters...
    if (/\p{Cc}|\p{Cf}/u.test(ch)) return /\s/.test(ch) ? ' ' : '';
    if (REPLACE_WITH_UNDERSCORE.includes(ch)) return '_';
    if (ch === '~') return '-';
    return ch;
  }

  /**
   * Make one path segment (a folder name or a filename without extension) safe
   * for chrome.downloads on Windows, macOS and Linux.
   */
  function sanitizeSegment(name, maxLength = 100) {
    let s = String(name == null ? '' : name);
    if (typeof s.toWellFormed === 'function') s = s.toWellFormed(); // drop lone surrogates
    const trimEdges = (text) => text.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    s = trimEdges(
      Array.from(s.normalize('NFC'), cleanChar)
        .join('')
        .replace(/\s+/g, ' '),
    );

    if (Array.from(s).length > maxLength) {
      // Cut on a code point boundary so we never leave half a surrogate pair.
      s = trimEdges(Array.from(s).slice(0, maxLength).join(''));
    }
    if (!s) return '';
    if (WINDOWS_RESERVED.test(s.split('.')[0]) || WINDOWS_MAGIC_NAMES.has(s.toLowerCase())) s = `_${s}`;
    if (SHELL_EXTENSION.test(s)) s = `${s}_`;
    return s;
  }

  const KNOWN_EXTENSIONS = new Set([
    'jpg', 'png', 'gif', 'webp', 'avif', 'heic', 'bmp', 'svg',
    'mp4', 'm4v', 'mov', 'webm', 'mkv',
    'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac',
    'zip', 'txt',
  ]);

  function normalizeExt(ext) {
    if (!ext) return '';
    let e = String(ext).toLowerCase().replace(/^\./, '');
    if (e === 'jpeg' || e === 'jpe' || e === 'jfif') e = 'jpg';
    return KNOWN_EXTENSIONS.has(e) ? e : '';
  }

  function extFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'data:') {
        const m = /^data:([^;,]+)/i.exec(url);
        return m ? extFromMime(m[1]) : '';
      }
      const last = decodeURIComponent(u.pathname.split('/').pop() || '');
      const m = /\.([a-z0-9]{2,5})$/i.exec(last);
      return m ? normalizeExt(m[1]) : '';
    } catch {
      return '';
    }
  }

  const MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic',
    'image/bmp': 'bmp', 'image/svg+xml': 'svg',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/webm': 'webm', 'audio/flac': 'flac',
    'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'text/plain': 'txt',
  };

  function extFromMime(mime) {
    if (!mime) return '';
    return MIME_TO_EXT[String(mime).split(';')[0].trim().toLowerCase()] || '';
  }

  /** The last path segment of a URL without its extension, for use as a filename. */
  function basenameFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'data:') return '';
      const last = decodeURIComponent(u.pathname.split('/').pop() || '');
      return last.replace(/\.[a-z0-9]{2,5}$/i, '');
    } catch {
      return '';
    }
  }

  /**
   * Build the relative path handed to chrome.downloads.download().
   * Returns '' when there is nothing usable, which means "let Chrome pick".
   */
  /**
   * Relative path for chrome.downloads: folder/site/subfolder/base.ext
   * (empty parts are skipped). subfolder is e.g. an album or playlist name.
   */
  function buildDownloadPath({ folder = '', site = '', subfolder = '', base = '', ext = '' } = {}) {
    const e = normalizeExt(ext);
    const name = sanitizeSegment(base, 120);
    if (!name || !e) return '';
    const parts = [sanitizeSegment(folder, 60), sanitizeSegment(site, 40), sanitizeSegment(subfolder, 80)].filter(Boolean);
    parts.push(`${name}.${e}`);
    return parts.join('/');
  }

  // ---------------------------------------------------------------------------
  // Songs
  // ---------------------------------------------------------------------------

  /**
   * A song's file name (no extension) from its tags, following the songFilename
   * setting. Falls back to `fallback` when the tags have no title.
   */
  function songBaseName(tags, pattern, fallback = '') {
    const title = tags && typeof tags.title === 'string' ? tags.title.trim() : '';
    const artist = tags && typeof tags.artist === 'string' ? tags.artist.trim() : '';
    if (!title) return String(fallback || '');
    if (pattern === 'title' || !artist) return title;
    if (pattern === 'title-artist') return `${title} - ${artist}`;
    return `${artist} - ${title}`;
  }

  /** "01 - " for position 1 of 12, "001 - " for position 1 of 150. '' without a position. */
  function trackPrefix(position, total) {
    const n = Math.floor(Number(position));
    if (!(n > 0)) return '';
    const width = Math.max(2, String(Math.max(n, Math.floor(Number(total)) || 0)).length);
    return `${String(n).padStart(width, '0')} - `;
  }

  /**
   * Put the preferred song format ('mp3' or 'm4a') first in every item that
   * offers both as song jobs, so "Best" and Download all use it.
   */
  function preferAudioFormat(resolution, format) {
    if (!resolution || !Array.isArray(resolution.items) || (format !== 'mp3' && format !== 'm4a')) return resolution;
    const isSong = (v) => v && v.job && v.job.type === 'song';
    const items = resolution.items.map((item) => {
      const variants = Array.isArray(item.variants) ? item.variants : [];
      const songs = variants.filter(isSong);
      if (songs.length < 2) return item;
      const preferred = songs.filter((v) => v.job.format === format);
      if (!preferred.length || variants.indexOf(preferred[0]) === variants.indexOf(songs[0])) return item;
      const rest = variants.filter((v) => !preferred.includes(v));
      const at = variants.indexOf(songs[0]);
      const next = rest.slice();
      next.splice(Math.min(at, next.length), 0, ...preferred);
      return { ...item, variants: next };
    });
    return { ...resolution, items };
  }

  // ---------------------------------------------------------------------------
  // URLs
  // ---------------------------------------------------------------------------

  /**
   * Does `url` match a manifest match pattern like "https://*.example.com/*"?
   * Supports the forms this extension's manifest uses.
   */
  function matchesPattern(pattern, url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (pattern === '<all_urls>') return /^(https?|file|ftp):$/.test(u.protocol);
    const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!m) return false;
    const [, scheme, host, path] = m;
    if (scheme === '*' ? !/^https?:$/.test(u.protocol) : u.protocol !== `${scheme}:`) return false;
    if (host !== '*') {
      if (host.startsWith('*.')) {
        const base = host.slice(2);
        if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
      } else if (u.hostname !== host) {
        return false;
      }
    }
    const pathRe = new RegExp(`^${path.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, (c) => String.fromCharCode(92) + c)).join('.*')}$`);
    return pathRe.test(u.pathname + u.search);
  }

  /**
   * True for http(s) URLs on the public internet. Used before the extension
   * itself (not the page) sends a request to a page-chosen URL, so a hostile
   * page can't aim it at a router or other local services.
   */
  function isPublicHttpUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host.includes('.') && !host.includes(':')) return false; // "localhost", "router"
    if (/\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) return false;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])];
      if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
        return false;
      }
      if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    }
    if (host.includes(':')) {
      if (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // srcset
  // ---------------------------------------------------------------------------

  /**
   * Parse an <img srcset> / <source srcset> value following the HTML spec's
   * tokenizer, so URLs that contain commas (common with image CDNs) survive.
   * Returns [{ url, width?, density? }].
   */
  function parseSrcset(srcset, baseUrl) {
    const out = [];
    const input = String(srcset || '');
    let pos = 0;
    const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

    while (pos < input.length) {
      while (pos < input.length && (isSpace(input[pos]) || input[pos] === ',')) pos++;
      if (pos >= input.length) break;

      let start = pos;
      while (pos < input.length && !isSpace(input[pos])) pos++;
      let url = input.slice(start, pos);
      let descriptors = '';

      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        start = pos;
        let inParens = false;
        while (pos < input.length) {
          const c = input[pos];
          if (c === '(') inParens = true;
          else if (c === ')') inParens = false;
          else if (c === ',' && !inParens) break;
          pos++;
        }
        descriptors = input.slice(start, pos).trim();
        pos++; // skip the comma
      }
      if (!url) continue;

      const entry = { url };
      try {
        entry.url = new URL(url, baseUrl).href;
      } catch {
        continue;
      }
      for (const d of descriptors.split(/\s+/).filter(Boolean)) {
        const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(d);
        if (!m) continue;
        if (m[2].toLowerCase() === 'w') entry.width = Math.round(Number(m[1]));
        else entry.density = Number(m[1]);
      }
      out.push(entry);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function formatDate(unixSeconds) {
    const d = new Date(Number(unixSeconds) * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------------------
  // Download all: separate files, one ZIP, or one mix
  // ---------------------------------------------------------------------------

  const MIXABLE_EXT = /^(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/;

  /** { name, total } for a "Download all" of this resolution (the album or playlist). */
  function collectionOf(resolution) {
    const c = (resolution && resolution.collection) || {};
    const name = String(c.name || (resolution && (resolution.title || resolution.site)) || 'Download').trim();
    return { name, total: resolution && Array.isArray(resolution.items) ? resolution.items.length : 0 };
  }

  /** Can every item's first choice be decoded into one continuous mix? */
  function canMix(resolution) {
    const items = resolution && Array.isArray(resolution.items) ? resolution.items : [];
    if (items.length < 2) return false;
    return items.every((item) => {
      const v = item.variants && item.variants[0];
      if (!v || v.kind !== 'audio') return false;
      if (v.job) return v.job.type === 'song' || ((v.job.type === 'mp3' || v.job.type === 'mux') && !!v.job.audio && !v.job.video);
      return MIXABLE_EXT.test(normalizeExt(v.ext) || extFromUrl(v.url));
    });
  }

  /**
   * Every item's first choice as a single download: a ZIP of the files, or one
   * mix of the songs (see canMix). Returns a variant for the download request.
   * @param mode      'zip' | 'mix'
   * @param settings  for the mix format
   */
  function bundleVariant(resolution, mode, settings = DEFAULT_SETTINGS) {
    const items = (resolution && Array.isArray(resolution.items) ? resolution.items : []).filter((item) => item.variants && item.variants[0]);
    const { name } = collectionOf(resolution);
    const picked = items.map((item, i) => {
      const v = item.variants[0];
      const tags = (v.job && v.job.tags) || {};
      return { item, v, tags, position: i + 1 };
    });
    const first = picked[0] ? picked[0].v : { url: 'https://invalid.invalid/' };
    if (mode === 'zip') {
      return {
        kind: 'file',
        label: 'ZIP',
        url: first.url,
        ext: 'zip',
        filename: name,
        job: { type: 'zip', entries: picked.map(({ v, position }) => ({ url: v.url, filename: v.filename, ext: v.ext, job: v.job, position })) },
      };
    }
    const c = (resolution && resolution.collection) || {};
    const coverUrl = c.coverUrl || (picked.find((p) => p.tags.coverUrl) || { tags: {} }).tags.coverUrl || '';
    const format = settings && settings.mixFormat === 'm4a' ? 'm4a' : 'mp3';
    return {
      kind: 'audio',
      label: 'Mix',
      url: first.url,
      ext: format,
      filename: `${name} (mix)`,
      job: {
        type: 'mix',
        tags: { title: `${name} (mix)`, album: name, artist: c.artist || 'Various Artists', ...(coverUrl ? { coverUrl } : {}) },
        entries: picked.map(({ item, v, tags }) => ({
          url: v.url,
          job: v.job,
          title: tags.title || String(item.label || '').replace(/^\d+\.\s*/, ''),
          artist: tags.artist || '',
        })),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Download progress text
  // ---------------------------------------------------------------------------

  /**
   * What to tell the user about a batch of downloads (page toasts, the toolbar popup).
   * @param state { started, refused, done, failed, error, note?, progress: Map | object (jobId -> 0..1) }
   *              note: extra text for a successful finish (e.g. "2 songs couldn’t be found.")
   * @returns { text, kind: 'info' | 'success' | 'error', final, percent }
   */
  function batchStatus(state) {
    const progress = state.progress instanceof Map ? Array.from(state.progress.values()) : Object.values(state.progress || {});
    const settled = state.done + state.failed;
    if (settled >= state.started) {
      const failed = state.failed + state.refused;
      if (!failed) {
        const saved = state.done === 1 ? 'Saved to your Downloads.' : `Saved ${state.done} files to your Downloads.`;
        return { text: state.note ? `${saved} ${state.note}` : saved, kind: 'success', final: true, percent: 100 };
      }
      if (!state.done) return { text: state.error || 'Download failed.', kind: 'error', final: true, percent: 100 };
      return { text: `Saved ${state.done}. ${failed} failed: ${state.error || 'unknown error'}`, kind: 'error', final: true, percent: 100 };
    }
    if (progress.length && progress.some((p) => p < 1)) {
      const average = progress.reduce((a, b) => a + b, 0) / progress.length;
      const percent = Math.max(0, Math.min(99, Math.round(average * 100)));
      const noun = state.started === 1 ? 'your file' : `${state.started} files`;
      return { text: `Preparing ${noun}… ${percent}%`, kind: 'info', final: false, percent };
    }
    if (state.started === 1) return { text: 'Downloading…', kind: 'info', final: false, percent: 99 };
    return {
      text: settled ? `Saved ${state.done} of ${state.started}…` : `Downloading ${state.started} files…`,
      kind: 'info',
      final: false,
      percent: Math.round((settled / state.started) * 100),
    };
  }

  // ---------------------------------------------------------------------------
  // Handler registry (content scripts)
  // ---------------------------------------------------------------------------
  //
  // A handler is { id, name, priority, matches(location) -> bool,
  //                resolve(ctx) -> Promise<Resolution | null> }.
  // Higher priority runs first; the first non-empty Resolution wins.
  // Optional: snapshot(ctx) records what a right-click landed on; pageSnapshot()
  // returns the snapshot for "the main thing on this page" (used when a link is
  // pasted into the toolbar popup and the page is opened in a background tab).
  // pageGeneric (boolean or (location) => boolean) says whether the generic
  // handler may scan the whole page on that site when pageSnapshot finds nothing.
  //
  // Resolution = {
  //   site: 'Instagram',            // shown in the picker and used as the subfolder
  //   title: '@user',               // picker heading
  //   notice?: 'string',            // shown above the options (e.g. "rate limited")
  //   focus: 0,                     // index of the item the user right-clicked
  //   items: [{
  //     label: 'Photo 2 of 5',
  //     thumbnail?: url,
  //     variants: [{                // sorted best first
  //       label: 'Original', detail: '3273 × 4096',
  //       url, ext, filename,       // filename has no extension
  //       kind: 'image' | 'video' | 'audio',
  //       group?: 'Audio only',     // section heading in the picker
  //       width?, height?, bitrate?, size?,
  //       job?: { type: 'mux' | 'mp3' | 'hls' | 'song', … },  // processed on this computer
  //       via?: 'page',             // fetched by the page itself (CDNs that need its cookies)
  //     }],
  //   }],
  // }
  //
  // Later sites that need processing (mux, transcode, screenshot) will add a
  // `job` to a variant instead of a plain `url`; the service worker will hand
  // those to an offscreen document.

  JDI.handlers = JDI.handlers || [];

  function registerHandler(handler) {
    const i = JDI.handlers.findIndex((h) => h.id === handler.id);
    if (i >= 0) JDI.handlers[i] = handler;
    else JDI.handlers.push(handler);
  }

  function handlersFor(loc) {
    return JDI.handlers
      .filter((h) => {
        try {
          return h.matches(loc);
        } catch {
          return false;
        }
      })
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  JDI.util = {
    DEFAULT_SETTINGS,
    SITE_ACCESS,
    BROWSER_NAME,
    cleanSettings,
    songBaseName,
    trackPrefix,
    preferAudioFormat,
    collectionOf,
    canMix,
    bundleVariant,
    sanitizeSegment,
    normalizeExt,
    extFromUrl,
    extFromMime,
    basenameFromUrl,
    buildDownloadPath,
    matchesPattern,
    isPublicHttpUrl,
    parseSrcset,
    formatBytes,
    formatDate,
    batchStatus,
    registerHandler,
    handlersFor,
  };
})();
