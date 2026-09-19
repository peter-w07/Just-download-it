/*
 * Just download it: background service worker.
 *
 * Responsibilities:
 *  - the right-click menu ("Just download media", "Just download web page"),
 *    forwarded to the content script in the right frame (injecting it first
 *    into tabs that were open before install/update)
 *  - the toolbar popup: resolving pasted links (directly for sites with public
 *    APIs, otherwise in a muted background tab) and reporting progress to it
 *  - songs from Spotify / Apple Music / YouTube Music: looked up on YouTube
 *    Music when the download starts ("song" jobs), also for the offscreen
 *    document's ZIPs and mixes (jdi:resolve-song), a couple at a time
 *  - downloads: plain files go straight to chrome.downloads; files that need
 *    processing (combining video + audio, MP3, a ZIP, one mix of many songs)
 *    become jobs in the offscreen document, which reports progress and hands
 *    back a blob: URL when done (in Firefox the same job runner lives in this
 *    event page instead: see offscreen-host.js)
 *  - file names: songs are named from their tags ("Artist - Title"); a whole
 *    album or playlist of songs is numbered and saved in its own folder
 *    (see nameFile and the song settings)
 *  - reporting progress, completion and failure back to the page
 *  - opening the settings page (right-click menu, jdi:open-settings)
 *
 * State that must survive the worker being stopped lives in
 * chrome.storage.session: `job:<id>` for running jobs, `dl:<downloadId>` for
 * downloads in flight. All listeners are registered at the top level.
 *
 * Firefox runs this same module as an event page (see scripts/build-firefox.mjs).
 * The differences are feature checks, not browser checks: no offscreen API (jobs
 * run in this page), no downloads.onDeterminingFilename (names passed to
 * downloads.download are kept as they are, and files a page made are sent here
 * as bytes), and host access the user may not have granted yet.
 */
import '../shared/util.js';
import { ensureOriginRules, resolveLink } from './resolvers.js';
import { songAudio } from './youtube.js';
import { enrichSong } from './metadata.js';
import { handleCaptureMessage } from './capture.js';
import { closeOffscreen, ensureOffscreen, isOffscreenSender, onOffscreenReport, toOffscreen } from './offscreen-host.js';

const { util } = globalThis.JDI;

const MENU_ID = 'jdi';
const MENU_PAGE = 'jdi-page';
const MENU_PAGE_PNG = 'jdi-page-png';
const MENU_PAGE_GIF = 'jdi-page-gif';
const MENU_SEPARATOR = 'jdi-separator';
const MENU_SETTINGS = 'jdi-settings';
// "page" and "frame" matter: Instagram covers photos with a transparent <div>
// and YouTube's player swallows right-clicks, so Chrome often reports a plain
// page click rather than an image or video.
const MENU_CONTEXTS = ['page', 'frame', 'link', 'image', 'video', 'audio'];
const PAGE_CONTEXTS = [...MENU_CONTEXTS, 'selection'];
const MAX_FILES_PER_REQUEST = 100;
// Songs only (a whole album or playlist): they're looked up and converted a
// couple at a time anyway, and playlists can be long.
const MAX_SONG_FILES_PER_REQUEST = 500;
const MAX_ZIP_ENTRIES = 300;
const MAX_MIX_ENTRIES = 200;
const POPUP_URL = chrome.runtime.getURL('popup/popup.html');
// The extension's website. Its "Paste a link" page can ask for a link to be
// opened in the popup (content/site-bridge.js); the popup picks it up from here.
const SITE_HOST = 'justdownloadit.peterwild.pw';
const POPUP_PENDING_KEY = 'popupPending';
// The extension's own origin: chrome-extension://<id> or moz-extension://<uuid>.
const OWN_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
// Chrome only. Where it's missing (Firefox), downloads.download keeps the names it's given.
const NAMES_ON_DETERMINE = !!(chrome.downloads && chrome.downloads.onDeterminingFilename);

// Header rules for the extension's own API requests (see net.js).
ensureOriginRules();

// ---------------------------------------------------------------------------
// Install / menus
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await createMenus();
  await injectIntoOpenTabs();
});

// Menus persist across restarts; recreate them in case they were lost.
chrome.runtime.onStartup.addListener(() => {
  createMenus();
});

// onInstalled and onStartup can both fire as the worker starts. Two rebuilds
// running at once would each clear the menu and then add the same ids twice
// ("Cannot create item with duplicate id"), so rebuilds run one after another.
let menusBuilt = Promise.resolve();
function createMenus() {
  menusBuilt = menusBuilt.then(buildMenus, buildMenus);
  return menusBuilt;
}

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  const add = (item) =>
    new Promise((resolve) => {
      chrome.contextMenus.create(item, () => {
        void chrome.runtime.lastError; // an id that already exists is fine
        resolve();
      });
    });
  // Chrome groups an extension's items under its name when there is more than one.
  await add({ id: MENU_ID, title: 'Just download media', contexts: MENU_CONTEXTS });
  await add({ id: MENU_PAGE, title: 'Just download web page', contexts: PAGE_CONTEXTS });
  await add({ id: MENU_PAGE_PNG, parentId: MENU_PAGE, title: 'As an image (PNG)…', contexts: PAGE_CONTEXTS });
  await add({ id: MENU_PAGE_GIF, parentId: MENU_PAGE, title: 'As a GIF (record while you scroll)…', contexts: PAGE_CONTEXTS });
  await add({ id: MENU_SEPARATOR, type: 'separator', contexts: PAGE_CONTEXTS });
  await add({ id: MENU_SETTINGS, title: 'Settings…', contexts: PAGE_CONTEXTS });
}

/** The extension's settings page (content scripts can't open it themselves). */
async function openSettings() {
  await chrome.runtime.openOptionsPage();
  return { ok: true };
}

/** The content script files the manifest would inject into this URL. */
function contentScriptFilesFor(url) {
  for (const entry of chrome.runtime.getManifest().content_scripts || []) {
    // Page-world hooks only help from the first page load; skip them here.
    if (entry.world === 'MAIN') continue;
    const included = (entry.matches || []).some((p) => util.matchesPattern(p, url));
    const excluded = (entry.exclude_matches || []).some((p) => util.matchesPattern(p, url));
    if (included && !excluded) return entry.js || [];
  }
  return [];
}

/**
 * Tabs that were open before install/update have no (live) content script, nor
 * do tabs opened before host access was granted. Firefox injects the
 * manifest's scripts into open tabs at install by itself, so tabs whose
 * content script already answers are left alone.
 */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      const files = contentScriptFilesFor(tab.url || '');
      if (!files.length) return;
      const pong = await chrome.tabs.sendMessage(tab.id, { type: 'jdi:ping' }, { frameId: 0 }).catch(() => null);
      if (pong && pong.ok) return;
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, files })
        .catch(() => {}); // discarded tabs, the Web Store, error pages...
    }),
  );
}

// Host access granted later (Firefox can install without it; Chrome's site
// access can be widened): open pages get the content scripts right away.
chrome.permissions.onAdded.addListener((added) => {
  if (added && Array.isArray(added.origins) && added.origins.length) injectIntoOpenTabs();
});

// ---------------------------------------------------------------------------
// Menu click -> content script
// ---------------------------------------------------------------------------

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SETTINGS) {
    openSettings().catch(() => {});
    return;
  }
  if (!tab || tab.id == null || tab.id < 0) return;
  if (info.menuItemId === MENU_ID) invokeInTab(tab, info);
  else if (info.menuItemId === MENU_PAGE_PNG) startCapture(tab, 'png');
  else if (info.menuItemId === MENU_PAGE_GIF) startCapture(tab, 'gif');
});

/** "Just download web page": the element picker / recorder in content/capture.js. */
async function startCapture(tab, mode) {
  const message = { type: 'jdi:capture-start', mode: mode === 'gif' ? 'gif' : 'png' };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
    if (res && res.ok) return { ok: true };
  } catch {
    // No content script yet. Inject one below.
  }
  try {
    const files = contentScriptFilesFor(tab.url || '');
    if (!files.length) throw new Error('not injectable');
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files });
    const res = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
    if (res && res.ok) return { ok: true };
    throw new Error('no capture');
  } catch {
    // Pages extensions can't script (Chrome Web Store, chrome://, PDFs): save what's on screen.
    if (message.mode === 'png') {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const settings = await getSettings();
        await saveUrl(dataUrl, { site: 'Captures', settings, base: tab.title || 'page', ext: 'png' });
        return { ok: true };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, error: `${util.BROWSER_NAME} doesn’t let extensions capture this page.` };
  }
}

// Handy from the service worker's DevTools console, and used by the e2e tests
// (automation can't click a native context menu).
globalThis.JDI.background = {
  invokeInTab: (tab, info) => invokeInTab(tab, { menuItemId: MENU_ID, ...info }),
  resolveLink: (url) => resolveLink(url),
  resolveForPopup: (url) => resolveForPopup(url),
  popupDownload: (message) => popupDownload(message),
  startCapture: (tab, mode) => startCapture(tab, mode),
  // What the offscreen document would be sent for a job (validated, named, settings applied).
  checkJob: (job, settings) => {
    const clean = checkJob(job);
    const s = util.cleanSettings(settings);
    return clean.type === 'zip' || clean.type === 'mix' ? bundleForOffscreen(clean, s) : withOutputSettings(clean, s);
  },
};

async function invokeInTab(tab, info) {
  const frameId = info.frameId || 0;
  const settings = await getSettings();
  const message = {
    type: 'jdi:invoke',
    mode: settings.skipPicker ? 'best' : 'choose',
    info: {
      srcUrl: info.srcUrl || '',
      linkUrl: info.linkUrl || '',
      pageUrl: info.pageUrl || '',
      frameUrl: info.frameUrl || '',
      mediaType: info.mediaType || '',
    },
  };

  try {
    await chrome.tabs.sendMessage(tab.id, message, { frameId });
    return;
  } catch {
    // No content script in that frame yet. Inject one below.
  }

  try {
    const files = contentScriptFilesFor(info.frameUrl || info.pageUrl || tab.url || '');
    if (!files.length) throw new Error('not injectable');
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files });
    await chrome.tabs.sendMessage(tab.id, { ...message, lateInjection: true }, { frameId });
  } catch {
    // Pages extensions can't touch (Chrome Web Store, chrome://, PDF viewer).
    // If Chrome told us the image/video URL, save it as-is.
    if (/^https?:/i.test(info.srcUrl || '')) {
      startDownload(
        { url: info.srcUrl, filename: util.basenameFromUrl(info.srcUrl) || 'download', ext: util.extFromUrl(info.srcUrl) },
        { site: '', settings },
      ).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function isPopup(sender) {
  // Also true when popup.html is opened in a tab (handy for testing); only this extension's pages have this URL.
  return typeof sender.url === 'string' && sender.url.startsWith(POPUP_URL);
}

function reply(promise, sendResponse) {
  promise.then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.userMessage) || (err && err.message) || err) }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message) return false;

  // Page capture (content/capture.js, background/capture.js).
  if (sender.tab && /^jdi:(capture|record)-/.test(String(message.type))) {
    const handled = handleCaptureMessage(message, sender, sendResponse, { ensureOffscreen, toOffscreen, withOffscreenLock, getSettings, saveUrl, util });
    if (handled !== undefined) return handled;
  }

  // From the toolbar popup.
  if (isPopup(sender)) {
    if (message.type === 'jdi:resolve-link') return reply(resolveForPopup(message.url, message.tabId), sendResponse);
    if (message.type === 'jdi:popup-download') return reply(popupDownload(message), sendResponse);
    if (message.type === 'jdi:popup-capture') return reply(captureActiveTab(message.mode), sendResponse);
    if (message.type === 'jdi:popup-open') return reply(popupOpened(), sendResponse);
    if (message.type === 'jdi:open-settings') return reply(openSettings(), sendResponse);
    if (message.type === 'jdi:popup-forget-tab') {
      closeLinkTab(Number(message.tabId), { onlyIdle: true });
      return false;
    }
    return false;
  }

  // From content scripts.
  if (message.type === 'jdi:download' && sender.tab) {
    return reply(handleDownloadRequest(message, sender), sendResponse);
  }
  if (message.type === 'jdi:resolve-link' && sender.tab) {
    return reply(
      resolveLink(message.url).then((res) => (res.needsTab ? { ok: false, needsTab: true } : res)),
      sendResponse,
    );
  }
  if (message.type === 'jdi:relay-status' && sender.tab) {
    onRelayStatus(message, sender);
    return false;
  }
  if (message.type === 'jdi:probe' && sender.tab) {
    probeSizes(message.urls).then((sizes) => sendResponse({ sizes }), () => sendResponse({ sizes: {} }));
    return true;
  }
  if (message.type === 'jdi:fetch-json' && sender.tab) {
    fetchAllowedJson(message.url, message.as).then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (message.type === 'jdi:expect-download' && sender.tab) {
    expectPageDownload(message, sender).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'jdi:page-bytes' && sender.tab) {
    return reply(savePageBytes(message, sender), sendResponse);
  }
  if (message.type === 'jdi:open-settings' && sender.tab) {
    return reply(openSettings(), sendResponse);
  }
  if (message.type === 'jdi:site-open-link' && sender.tab && isOwnSite(sender)) {
    return reply(openLinkFromSite(message.url, sender.tab), sendResponse);
  }

  // From the offscreen document (it has no tab).
  if (isOffscreenSender(sender)) {
    if (message.type === 'jdi:resolve-song') return reply(resolveSongForOffscreen(message), sendResponse);
    onOffscreenMessage(message);
  }
  return false;
});

/**
 * Reports and requests from the job runner: runtime messages from the
 * offscreen document (Chrome), or direct calls when it runs in this page (Firefox).
 */
function onOffscreenMessage(message) {
  if (message.type === 'jdi:job-progress') onJobProgress(message);
  else if (message.type === 'jdi:job-done') onJobDone(message);
  else if (message.type === 'jdi:job-failed') onJobFailed(message);
  else if (message.type === 'jdi:resolve-song') return resolveSongForOffscreen(message);
  return undefined;
}
onOffscreenReport(onOffscreenMessage);

// ---------------------------------------------------------------------------
// Download requests
// ---------------------------------------------------------------------------

async function handleDownloadRequest(message, sender) {
  const files = limitFiles(message.files);
  const site = typeof message.site === 'string' ? message.site.slice(0, 40) : '';
  const batch = typeof message.batch === 'string' ? message.batch.slice(0, 64) : '';
  const origin = { tabId: sender.tab.id, frameId: sender.frameId || 0, batch };
  return startFiles(files, { site, origin, collection: cleanCollection(message.collection) });
}

/** The files of one request, capped (song-only requests may be longer). */
function limitFiles(list) {
  const files = Array.isArray(list) ? list.slice(0, MAX_SONG_FILES_PER_REQUEST) : [];
  return files.length > MAX_FILES_PER_REQUEST && !files.every(isSongFile) ? files.slice(0, MAX_FILES_PER_REQUEST) : files;
}

/**
 * Start each file (plain download or job). `origin` says where progress goes (a tab, or the popup).
 * @param collection  { name, total } when the files are a whole album or playlist ("Download all");
 *                    each file then has a 1-based `position`
 */
async function startFiles(files, { site, origin, collection = null }) {
  const settings = await getSettings();
  // Numbers and a folder only for a list of songs: an Instagram carousel keeps its names.
  const songCollection = !!collection && files.length > 0 && files.every(isSongFile);
  const results = [];
  // One at a time: with "Ask where to save" on, parallel requests would stack
  // Save As dialogs on top of each other.
  for (const file of files) {
    try {
      if (file && file.job) {
        const jobId = await startJob(file, { site, origin, settings, collection, songCollection });
        results.push({ ok: true, jobId });
      } else {
        const { id, filename } = await startDownload(file, { site, settings });
        await chrome.storage.session.set({ [`dl:${id}`]: { ...origin, filename } });
        checkAlreadyFinished(id);
        results.push({ ok: true, id, filename });
      }
    } catch (err) {
      results.push({ ok: false, error: friendlyError(err) });
    }
  }
  return { ok: results.some((r) => r.ok), results };
}

function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('That link is not a valid URL.');
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  if (url.protocol === 'data:' && /^data:(image|video|audio)\//i.test(url.href)) return url.href;
  if (url.protocol === 'blob:') {
    throw new Error("This video is streamed in pieces, so it can't be saved directly on this site yet.");
  }
  throw new Error(`Can't download ${url.protocol} links.`);
}

async function startDownload(file, { site, settings }) {
  const url = checkUrl(file && file.url);
  const ext = util.normalizeExt(file.ext) || util.extFromUrl(url) || (await sniffExtension(url));
  return saveUrl(url, { site, settings, base: file.filename, ext });
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
//
// A song (a 'song' job, or an MP3/M4A job with song tags) is named from its
// tags, following the songFilename setting, even when tags aren't written into
// the file. When every file of a request is a song from one album or playlist
// ("Download all"), they're numbered ("01 - ") and saved in a folder named after
// it, if the numberTracks / collectionFolders settings are on. Everything else
// keeps the name its resolver gave it. ZIPs and mixes are named after the
// collection (see startJob).

function isSongJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.type === 'song') return true;
  return (job.type === 'mp3' || job.type === 'mux') && !!job.tags && typeof job.tags.title === 'string' && !!job.tags.title.trim();
}

function isSongFile(file) {
  return !!file && isSongJob(file.job);
}

/** { name, total } of a "Download all" request, or null. */
function cleanCollection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = Math.floor(Number(raw.total));
  return { name: String(raw.name || '').trim().slice(0, 200), total: total > 0 && total < 100000 ? total : 0 };
}

/** A 1-based position in a collection, or 0. */
function cleanPosition(raw) {
  const n = Math.floor(Number(raw));
  return n > 0 && n < 100000 ? n : 0;
}

/**
 * A file's name (without extension) and collection folder.
 * @param file.filename  the resolver's name, used unless it's a song with a title
 * @param file.tags      song tags ({ title, artist, … })
 * @param file.song      is it a song?
 * @param file.position  1-based position in the collection
 * @param songCollection true when every file of the request is a song of `collection`
 */
function nameFile({ filename, tags, song, position }, { settings, collection, songCollection }) {
  const fallback = String(filename || '');
  let base = song ? util.songBaseName(tags, settings.songFilename, fallback) : fallback;
  let subfolder = '';
  if (songCollection && collection) {
    if (settings.numberTracks && base.trim()) base = util.trackPrefix(cleanPosition(position), collection.total) + base;
    if (settings.collectionFolders) subfolder = collection.name;
  }
  return { base, subfolder };
}

/**
 * Save a URL into the downloads folder: folder/site/subfolder/base.ext.
 * @param subfolder  e.g. an album or playlist name ('' for none)
 * @param path       the whole relative path, when it's already built
 */
async function saveUrl(url, { site, settings, subfolder = '', base, ext, path }) {
  const filename =
    path !== undefined
      ? path
      : util.buildDownloadPath({
          folder: settings.folder,
          site: settings.perSiteFolders ? site : '',
          subfolder,
          base,
          ext,
        });
  const options = { url, conflictAction: 'uniquify' };
  if (settings.saveAs) options.saveAs = true;
  if (filename) options.filename = filename;

  const forget = filename && NAMES_ON_DETERMINE ? rememberName(url, filename) : () => {};
  try {
    return { id: await download(options), filename };
  } catch (err) {
    forget();
    // Chrome rejects some names we can't predict (length limits on unusual
    // file systems, etc.). Retry once and let Chrome choose the name.
    if (options.filename && /filename/i.test(String(err && err.message))) {
      delete options.filename;
      return { id: await download(options), filename: '' };
    }
    throw err;
  }
}

/**
 * downloads.download. Firefox refuses data: URLs there, so where one is
 * refused and this page can make blob: URLs (Firefox's event page can; Chrome's
 * service worker never needs to), it's saved from a blob: URL instead.
 */
async function download(options) {
  try {
    return await chrome.downloads.download(options);
  } catch (err) {
    if (!/^data:/i.test(options.url) || typeof URL.createObjectURL !== 'function') throw err;
    const blob = await (await fetch(options.url)).blob();
    const url = URL.createObjectURL(blob);
    let id;
    try {
      id = await chrome.downloads.download({ ...options, url });
    } catch (err2) {
      URL.revokeObjectURL(url);
      throw err2;
    }
    holdBlobUrl(id, url);
    return id;
  }
}

// Because this extension listens to onDeterminingFilename (for page downloads,
// below), Chrome no longer applies the `filename` passed to downloads.download:
// the listener has to hand it back. Names are remembered by URL until then.
// (Firefox has no onDeterminingFilename and keeps the name it was given.)
const ownNames = new Map(); // url -> [{ filename, time }]
const OWN_NAME_TTL_MS = 5 * 60 * 1000;

function rememberName(url, filename) {
  const entry = { filename, time: Date.now() };
  if (!ownNames.has(url)) ownNames.set(url, []);
  ownNames.get(url).push(entry);
  for (const [key, list] of ownNames) {
    const fresh = list.filter((e) => Date.now() - e.time < OWN_NAME_TTL_MS);
    if (fresh.length) ownNames.set(key, fresh);
    else ownNames.delete(key);
  }
  return () => {
    const list = ownNames.get(url) || [];
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) ownNames.delete(url);
  };
}

function takeOwnName(url) {
  const list = ownNames.get(url);
  if (!list || !list.length) return '';
  const { filename } = list.shift();
  if (!list.length) ownNames.delete(url);
  return filename;
}

/**
 * Work out the file type of a URL without an extension: Content-Type from a
 * HEAD, then the file's first bytes. Without it Chrome would ignore our folder.
 */
async function sniffExtension(url) {
  if (!util.isPublicHttpUrl(url)) return '';
  const head = await timedFetch(url, { method: 'HEAD' });
  const fromType = head && head.ok ? util.extFromMime(head.headers.get('content-type')) : '';
  if (fromType) return fromType;
  const res = await timedFetch(url, { headers: { Range: 'bytes=0-31' } });
  if (!res || !res.ok) return '';
  const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0))).slice(0, 32);
  return extFromMagic(bytes) || util.extFromMime(res.headers.get('content-type'));
}

function extFromMagic(b) {
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (/^(heic|heix|mif1)/.test(brand)) return 'heic';
    if (brand === 'M4A ') return 'm4a';
    if (brand === 'qt  ') return 'mov';
    return 'mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  return '';
}

/** HEAD each URL for its size so the picker can show it. Never sends cookies. */
async function probeSizes(urls) {
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && util.isPublicHttpUrl(u)).slice(0, 8);
  const sizes = {};
  await Promise.all(
    list.map(async (url) => {
      const res = await timedFetch(url, { method: 'HEAD' });
      const length = res && res.ok ? Number(res.headers.get('content-length')) : 0;
      if (length > 0) sizes[url] = length;
    }),
  );
  return sizes;
}

async function timedFetch(url, init, ms = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, credentials: 'omit', signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * JSON from a public endpoint the page itself isn't allowed to read (CORS).
 * Only allowlisted endpoints, never with cookies.
 */
const JSON_ENDPOINTS = [/^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?/];
const TEXT_ENDPOINTS = [/^https:\/\/usher\.ttvnw\.net\/vod\//];

async function fetchAllowedJson(url, as) {
  const allowed = as === 'text' ? TEXT_ENDPOINTS : JSON_ENDPOINTS;
  if (typeof url !== 'string' || !allowed.some((re) => re.test(url))) return { ok: false, error: 'Not allowed.' };
  const res = await timedFetch(url, { headers: { Accept: as === 'text' ? '*/*' : 'application/json' } }, 15000);
  if (!res) return { ok: false, error: 'Network problem.' };
  if (as === 'text') {
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  }
  const data = await res.json().catch(() => null);
  return { ok: res.ok && !!data, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Downloads made by the page (sites whose CDN needs the page's cookies/referrer)
// ---------------------------------------------------------------------------
//
// The content script fetches the file itself and clicks a download link with a
// placeholder name. We recognise that name here and put the file in the usual
// folder, then track it like any other download.
//
// Without onDeterminingFilename (Firefox) a page's download can't be renamed, so
// jdi:expect-download answers { ok, bytes: true } and the content script sends
// the file itself instead (jdi:page-bytes with a Blob; Firefox messages are
// structured clones). It's saved from a blob: URL of this page under its real name.

const expectedPageDownloads = new Map(); // placeholder name -> { path, tabId, frameId, batch, time }

async function expectPageDownload(message, sender) {
  const settings = await getSettings();
  const name = String(message.name || '');
  if (!/^jdi-[\w-]+\.[a-z0-9]{2,5}$/.test(name)) return { ok: false };
  // Same naming rules as other files. A page download is one file of its
  // request, so it's only treated as a song of a collection if it says so (song tags).
  const tags = cleanTags(message.tags);
  const song = !!(tags && tags.title);
  const collection = cleanCollection(message.collection);
  const { base, subfolder } = nameFile(
    { filename: String(message.base || ''), tags, song, position: message.position },
    { settings, collection, songCollection: song && !!collection },
  );
  const path = util.buildDownloadPath({
    folder: settings.folder,
    site: settings.perSiteFolders ? String(message.site || '') : '',
    subfolder,
    base,
    ext: message.ext,
  });
  expectedPageDownloads.set(name, {
    path,
    tabId: sender.tab.id,
    frameId: sender.frameId || 0,
    batch: typeof message.batch === 'string' ? message.batch.slice(0, 64) : '',
    time: Date.now(),
  });
  for (const [key, value] of expectedPageDownloads) if (Date.now() - value.time > 120000) expectedPageDownloads.delete(key);
  return NAMES_ON_DETERMINE ? { ok: true } : { ok: true, bytes: true };
}

// blob: URLs this page made for downloads (files pages sent, data: URLs):
// downloadId -> url, revoked once saved (finishDownload), or after a while.
const blobUrls = new Map();
const BLOB_URL_MAX_MS = 10 * 60 * 1000;

function holdBlobUrl(id, url) {
  blobUrls.set(id, url);
  setTimeout(() => releaseBlobUrl(id), BLOB_URL_MAX_MS);
}

function releaseBlobUrl(id) {
  const url = blobUrls.get(id);
  if (!url) return;
  blobUrls.delete(id);
  URL.revokeObjectURL(url);
}

/** { name, blob } from a content script: the file of a page download it announced. */
async function savePageBytes(message, sender) {
  const name = String(message.name || '');
  const expected = expectedPageDownloads.get(name);
  if (!expected || expected.tabId !== sender.tab.id) return { ok: false, error: 'Download failed. Try again.' };
  const blob = message.blob;
  if (!(blob instanceof Blob) || !blob.size) return { ok: false, error: 'The file was empty.' };
  expectedPageDownloads.delete(name);
  const settings = await getSettings();
  const url = URL.createObjectURL(blob);
  let saved;
  try {
    saved = await saveUrl(url, { settings, path: expected.path });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  const { id, filename } = saved;
  holdBlobUrl(id, url);
  await chrome.storage.session.set({ [`dl:${id}`]: { tabId: expected.tabId, frameId: expected.frameId, batch: expected.batch, filename, page: true } });
  checkAlreadyFinished(id);
  return { ok: true, id };
}

if (NAMES_ON_DETERMINE) chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) {
    const own = takeOwnName(item.url) || (item.finalUrl && item.finalUrl !== item.url ? takeOwnName(item.finalUrl) : '');
    if (own) {
      suggest({ filename: own, conflictAction: 'uniquify' });
      return;
    }
  }
  const name = String(item.filename || '').split(/[\\/]/).pop();
  const expected = name && expectedPageDownloads.get(name);
  if (!expected || !/^blob:https?:/i.test(String(item.finalUrl || item.url || ''))) {
    suggest(); // not ours: leave every other download alone
    return;
  }
  expectedPageDownloads.delete(name);
  if (expected.path) suggest({ filename: expected.path, conflictAction: 'uniquify' });
  else suggest();
  chrome.storage.session
    .set({ [`dl:${item.id}`]: { tabId: expected.tabId, frameId: expected.frameId, batch: expected.batch, filename: expected.path, page: true } })
    .then(() => checkAlreadyFinished(item.id));
});

function friendlyError(err) {
  if (err && err.userMessage) return String(err.userMessage);
  const msg = String((err && err.message) || err || 'Unknown error');
  if (/invalid url/i.test(msg)) return 'That link is not a valid URL.';
  if (/Receiving end does not exist|message port closed/i.test(msg)) return "Couldn't start the download. Try again.";
  return msg;
}

// ---------------------------------------------------------------------------
// Jobs (offscreen document, or this page in Firefox: see offscreen-host.js)
// ---------------------------------------------------------------------------

// Starting a job and closing an idle offscreen document must never interleave,
// or a document could be closed right after it accepted a new job.
let offscreenLock = Promise.resolve();
function withOffscreenLock(fn) {
  const run = offscreenLock.then(fn, fn);
  offscreenLock = run.catch(() => {});
  return run;
}

const TAG_TEXT = ['title', 'artist', 'album', 'albumArtist', 'genre', 'comment'];
const TAG_NUMBERS = ['trackNumber', 'tracksTotal', 'discNumber', 'discsTotal'];

/** Song tags written into MP3/M4A files, limited to plain values. */
function cleanTags(tags) {
  if (!tags || typeof tags !== 'object') return undefined;
  const clean = {};
  for (const key of TAG_TEXT) if (typeof tags[key] === 'string' && tags[key].trim()) clean[key] = tags[key].trim().slice(0, 300);
  for (const key of TAG_NUMBERS) {
    const n = Math.floor(Number(tags[key]));
    if (n > 0 && n < 10000) clean[key] = n;
  }
  if (typeof tags.date === 'string' && tags.date.length <= 40 && !Number.isNaN(new Date(tags.date).getTime())) clean.date = tags.date;
  if (typeof tags.coverUrl === 'string' && tags.coverUrl.length <= 2000 && /^https:/i.test(tags.coverUrl) && util.isPublicHttpUrl(tags.coverUrl)) {
    clean.coverUrl = tags.coverUrl;
  }
  return Object.keys(clean).length ? clean : undefined;
}

/** A URL the extension itself fetches for a ZIP or mix: public http(s), or a data: image/video/audio. */
function checkFetchUrl(raw) {
  const href = checkUrl(raw);
  if (/^https?:/i.test(href) && !util.isPublicHttpUrl(href)) throw new Error('Unsupported media URL.');
  return href;
}

/**
 * Validate a job from a page or the popup and keep only known fields.
 * @param nested  inside a ZIP or mix: those can't be nested
 *
 * ZIP: { type: 'zip', entries: [{ url, filename, ext, job?, position }] }
 * Mix: { type: 'mix', tags, entries: [{ url, job?, title, artist }] }
 * Entries that fail the checks are left out (`skipped`), and lists longer
 * than a ZIP or mix may hold are cut (`capped`); bundleNote tells the user.
 */
function checkJob(job, { nested = false } = {}) {
  const type = job && job.type;
  if (!nested && (type === 'zip' || type === 'mix')) return checkBundle(job);
  if (type !== 'mux' && type !== 'mp3' && type !== 'hls' && type !== 'song') throw new Error("This kind of download isn't supported yet.");
  const clean = { type };
  if (type === 'song') {
    const videoId = /^[A-Za-z0-9_-]{11}$/.test(String(job.videoId || '')) ? job.videoId : '';
    const m = job.match && typeof job.match === 'object' ? job.match : null;
    const match = m
      ? {
          title: String(m.title || '').slice(0, 300),
          artists: (Array.isArray(m.artists) ? m.artists : []).slice(0, 10).map((a) => String(a).slice(0, 200)),
          album: String(m.album || '').slice(0, 300),
          durationMs: Math.max(0, Number(m.durationMs) || 0),
        }
      : null;
    if (!videoId && !(match && match.title)) throw new Error('Nothing to download.');
    return { type, format: job.format === 'm4a' ? 'm4a' : 'mp3', videoId, match, tags: cleanTags(job.tags) };
  }
  const tags = cleanTags(job.tags);
  if (tags) clean.tags = tags;
  if (type === 'hls') {
    const href = checkUrl(job.url);
    if (!/^https:/i.test(href)) throw new Error('Unsupported media URL.');
    return { type, url: href, audioOnly: !!job.audioOnly };
  }
  for (const key of ['video', 'audio']) {
    if (!job[key]) continue;
    const href = checkUrl(job[key]);
    if (!/^https:/i.test(href)) throw new Error('Unsupported media URL.');
    clean[key] = href;
  }
  if (type === 'mux' && !clean.video && !clean.audio) throw new Error('Nothing to combine.');
  if (type === 'mp3' && !clean.audio) throw new Error('No audio to convert.');
  return clean;
}

function checkBundle(job) {
  const zip = job.type === 'zip';
  const max = zip ? MAX_ZIP_ENTRIES : MAX_MIX_ENTRIES;
  const all = Array.isArray(job.entries) ? job.entries : [];
  const list = all.slice(0, max);
  const entries = [];
  let firstError = null;
  list.forEach((raw, i) => {
    const e = raw && typeof raw === 'object' ? raw : {};
    try {
      entries.push(zip ? checkZipEntry(e, i) : checkMixEntry(e));
    } catch (err) {
      firstError = firstError || err;
    }
  });
  if (!entries.length) throw firstError || new Error('Nothing to download.');
  const clean = { type: job.type, entries, skipped: list.length - entries.length, capped: all.length > max };
  if (!zip) {
    const tags = cleanTags(job.tags);
    if (tags) clean.tags = tags;
  }
  return clean;
}

function checkZipEntry(e, index) {
  const entry = {
    filename: String(e.filename || '').slice(0, 300),
    ext: util.normalizeExt(e.ext),
    position: cleanPosition(e.position) || index + 1,
  };
  if (e.job) entry.job = checkJob(e.job, { nested: true });
  else entry.url = checkFetchUrl(e.url);
  return entry;
}

/** A song is looked up; an MP3/M4A job gives its audio track; anything else is decoded from its URL. */
function checkMixEntry(e) {
  const entry = { title: String(e.title || '').slice(0, 300), artist: String(e.artist || '').slice(0, 300) };
  const type = e.job && e.job.type;
  if (type === 'song') {
    entry.job = checkJob(e.job, { nested: true });
  } else if ((type === 'mp3' || type === 'mux') && e.job.audio) {
    entry.job = checkJob({ type, audio: e.job.audio, tags: e.job.tags }, { nested: true });
  } else {
    entry.url = checkFetchUrl(e.url);
  }
  return entry;
}

/** The file type a job produces. */
function jobExt(job, settings) {
  switch (job.type) {
    case 'song':
      return job.format === 'm4a' ? 'm4a' : 'mp3';
    case 'mp3':
      return 'mp3';
    case 'hls':
      return job.audioOnly ? 'm4a' : 'mp4';
    case 'zip':
      return 'zip';
    case 'mix':
      return settings.mixFormat;
    default:
      return job.video ? 'mp4' : 'm4a';
  }
}

/** The settings that change what the converter writes: tags (embedTags) and the MP3 bitrate. */
function withOutputSettings(job, settings) {
  const out = { ...job };
  if (!settings.embedTags) delete out.tags;
  const mp3 = out.type === 'mp3' || ((out.type === 'song' || out.type === 'mix') && out.format === 'mp3');
  if (mp3) out.bitrate = settings.mp3Bitrate;
  else delete out.bitrate;
  return out;
}

function withoutTags(job) {
  const { tags, ...rest } = job;
  return rest;
}

/**
 * A checked ZIP or mix as the offscreen document gets it:
 *   { type: 'zip', entries: [{ name, url? , job? }] }  names are final and unique
 *   { type: 'mix', format, crossfade, normalize, bitrate?, tags?, entries: [{ url?, job?, title, artist }] }
 * Song sub-jobs stay unresolved (the offscreen document asks with jdi:resolve-song).
 */
function bundleForOffscreen(job, settings) {
  if (job.type === 'zip') {
    const songs = job.entries.every((e) => isSongJob(e.job));
    const total = job.entries.length;
    const used = new Set();
    const entries = job.entries.map((e) => {
      const song = isSongJob(e.job);
      const fallback = e.filename || (e.url ? util.basenameFromUrl(e.url) : '');
      let { base } = nameFile({ filename: fallback, tags: e.job && e.job.tags, song, position: e.position }, { settings, collection: null, songCollection: false });
      if (songs && settings.numberTracks && base.trim()) base = util.trackPrefix(e.position, total) + base;
      base = util.sanitizeSegment(base, 120) || `File ${e.position}`;
      const ext = e.job ? jobExt(e.job, settings) : e.ext || util.extFromUrl(e.url);
      const nameWith = (suffix) => `${base}${suffix}${ext ? `.${ext}` : ''}`;
      let name = nameWith('');
      for (let n = 2; used.has(name.toLowerCase()); n++) name = nameWith(` (${n})`);
      used.add(name.toLowerCase());
      return e.job ? { name, job: withOutputSettings(e.job, settings) } : { name, url: e.url };
    });
    return { type: 'zip', entries };
  }
  const mix = {
    type: 'mix',
    format: settings.mixFormat,
    crossfade: settings.mixCrossfade,
    normalize: settings.mixNormalize,
    // A mix only uses each song's audio, so the songs' own tags are left out
    // (they'd only cost iTunes lookups; the mix has its own tags and tracklist).
    entries: job.entries.map((e) => ({ ...(e.job ? { job: withoutTags(withOutputSettings(e.job, settings)) } : { url: e.url }), title: e.title, artist: e.artist })),
  };
  if (job.tags) mix.tags = job.tags;
  return withOutputSettings(mix, settings);
}

/** What the user is told about entries a ZIP or mix left out before it started. */
function bundleNote(job) {
  const zip = job.type === 'zip';
  const notes = [];
  if (job.capped) notes.push(zip ? `Only the first ${MAX_ZIP_ENTRIES} files fit in one ZIP.` : `Only the first ${MAX_MIX_ENTRIES} songs fit in one mix.`);
  if (job.skipped) {
    const noun = zip ? (job.skipped === 1 ? 'file' : 'files') : job.skipped === 1 ? 'song' : 'songs';
    notes.push(`${job.skipped} ${noun} couldn’t be added and ${job.skipped === 1 ? 'was' : 'were'} left out.`);
  }
  return notes.join(' ');
}

/** Extra text for a finished download ("2 songs couldn’t be found…"), joined without repeats. */
function joinNotes(...notes) {
  const parts = [];
  for (const note of notes) {
    const text = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(' ').slice(0, 600);
}

/**
 * @param settings        read once per request
 * @param collection      { name, total } for "Download all", or null
 * @param songCollection  every file of the request is a song (numbering, folder)
 */
async function startJob(file, { site, origin, settings, collection = null, songCollection = false }) {
  const checked = checkJob(file.job);
  const jobId = crypto.randomUUID();
  const ext = jobExt(checked, settings);
  let record;
  let job;
  if (checked.type === 'zip' || checked.type === 'mix') {
    // Saved in the site folder, named after the album or playlist.
    const name = (collection && collection.name) || '';
    const fallback = String(file.filename || '').slice(0, 200);
    const base = checked.type === 'zip' ? name || fallback || 'Download' : name ? `${name} (mix)` : fallback || 'Mix';
    const note = bundleNote(checked);
    record = { ...origin, site, base, ext, ...(note ? { note } : {}), startedAt: Date.now() };
    job = bundleForOffscreen(checked, settings);
  } else {
    const { base, subfolder } = nameFile(
      { filename: file.filename, tags: checked.tags, song: isSongJob(checked), position: file.position },
      { settings, collection, songCollection },
    );
    record = { ...origin, site, base, ...(subfolder ? { subfolder } : {}), ext, startedAt: Date.now() };
    job = withOutputSettings(checked, settings);
  }

  if (job.type === 'song') {
    // The job is kept on the record so a stale stream link can be looked up again.
    await chrome.storage.session.set({ [`job:${jobId}`]: { ...record, song: job } });
    prepareSong(jobId, job, settings).catch((err) => onJobFailed({ jobId, error: friendlyError(err) }));
    return jobId;
  }
  return withOffscreenLock(async () => {
    await chrome.storage.session.set({ [`job:${jobId}`]: record });
    try {
      await ensureOffscreen();
      const ack = await toOffscreen({ type: 'jdi:job-start', jobId, job });
      if (!ack || !ack.ok) throw new Error("Couldn't start the converter. Try again.");
    } catch (err) {
      await chrome.storage.session.remove(`job:${jobId}`);
      throw err;
    }
    return jobId;
  });
}

// Songs: find the stream on YouTube Music just before converting, a couple at a
// time and a little apart, so a whole album doesn't hit YouTube all at once.
// Song jobs and the songs of ZIPs and mixes (jdi:resolve-song) share this limit.
const songLookups = [];
let songLookupsRunning = 0;
const SONG_PREP_CONCURRENCY = 2;
const SONG_PREP_GAP_MS = 350;

/** Run `fn` (a lookup) when a slot is free. */
function withSongLookup(fn) {
  return new Promise((resolve, reject) => {
    songLookups.push({ fn, resolve, reject });
    pumpSongLookups();
  });
}

function pumpSongLookups() {
  while (songLookupsRunning < SONG_PREP_CONCURRENCY && songLookups.length) {
    const { fn, resolve, reject } = songLookups.shift();
    songLookupsRunning++;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() =>
        setTimeout(() => {
          songLookupsRunning--;
          pumpSongLookups();
        }, SONG_PREP_GAP_MS),
      );
  }
}

/**
 * Find a song's audio (in a lookup slot) and turn it into the job that converts it.
 * Returns null without looking anything up if `stillWanted()` says the job is gone.
 */
async function lookUpSong(job, settings, stillWanted) {
  const looked = await withSongLookup(async () => {
    if (!(await stillWanted())) return null;
    await ensureOriginRules();
    const [found, fuller] = await Promise.all([songAudio(job), withAlbumTags(job.tags, job.match)]);
    return { found, fuller };
  });
  if (!looked) return null;
  const { found, fuller } = looked;
  // No cover from the source site: use the album art YouTube Music shows for the match.
  const tags =
    fuller && !fuller.coverUrl && /^https:\/\/[\w.-]+\.googleusercontent\.com\//.test(found.thumbnail) ? { ...fuller, coverUrl: found.thumbnail } : fuller;
  const converted = { type: job.format === 'mp3' ? 'mp3' : 'mux', audio: found.audio, ...(tags ? { tags } : {}) };
  return withOutputSettings(converted, settings);
}

/**
 * Songs listed without their album (a Spotify playlist or an artist's top
 * tracks) get album, track number and genre from iTunes when the match is
 * confident. Never fails: the tags come back as they were otherwise. Tags that
 * aren't written into the file (embedTags off) are never looked up.
 */
async function withAlbumTags(tags, match) {
  if (!tags || !tags.title || tags.album || !match || !(Number(match.durationMs) > 0)) return tags;
  const fuller = await enrichSong(tags, { durationMs: match.durationMs }).catch(() => tags);
  return cleanTags(fuller) || tags;
}

/** Look up a song job (in order, in a lookup slot), then hand it to the offscreen document. */
async function prepareSong(jobId, job, settings) {
  const converted = await lookUpSong(job, settings, async () => {
    if (!(await takeJob(jobId, { remove: false }))) return false; // gone (worker restarted, canceled)
    onJobProgress({ jobId, progress: 0.01 });
    return true;
  });
  if (!converted) return;
  await withOffscreenLock(async () => {
    if (!(await takeJob(jobId, { remove: false }))) return;
    await ensureOffscreen();
    const ack = await toOffscreen({ type: 'jdi:job-start', jobId, job: converted });
    if (!ack || !ack.ok) throw new Error("Couldn't start the converter. Try again.");
  });
}

/**
 * The offscreen document asks for one song of a ZIP or mix it's making.
 * @returns { ok: true, job: { type: 'mp3' | 'mux', audio, tags?, bitrate? } } | { ok: false, error }
 */
async function resolveSongForOffscreen(message) {
  const jobId = String(message.jobId || '');
  try {
    const job = checkJob(message.job, { nested: true });
    if (job.type !== 'song') throw new Error('Nothing to download.');
    const settings = await getSettings();
    // A second try after a stale stream link: look the song up again from scratch.
    const wanted = message.refresh ? { ...job, fresh: true } : job;
    const converted = await lookUpSong(wanted, settings, async () => !!(jobId && (await takeJob(jobId, { remove: false }))));
    if (!converted) return { ok: false, error: 'Canceled.' };
    return { ok: true, job: converted };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

async function takeJob(jobId, { remove }) {
  const key = `job:${jobId}`;
  const stored = await chrome.storage.session.get(key);
  if (remove) await chrome.storage.session.remove(key);
  return stored[key] || null;
}

async function onJobProgress({ jobId, progress }) {
  const record = await takeJob(jobId, { remove: false });
  if (!record) return;
  notifyTab(record, { type: 'jdi:job-progress', batch: record.batch, jobId, progress: Number(progress) || 0 });
}

/** @param note  optional text for the user, e.g. "2 songs couldn’t be found and were left out." */
async function onJobDone({ jobId, url, note }) {
  // Keep the job record until the download record exists, so the offscreen
  // document (which owns the blob) is never seen as idle in between.
  const record = await takeJob(jobId, { remove: false });
  if (!record) {
    releaseJob(jobId);
    return;
  }
  try {
    if (!String(url).startsWith(`blob:${OWN_ORIGIN}/`)) throw new Error('The converter returned an invalid file.');
    const settings = await getSettings();
    const { id, filename } = await saveUrl(url, { site: record.site, settings, subfolder: record.subfolder || '', base: record.base, ext: record.ext });
    const fullNote = joinNotes(record.note, note);
    await chrome.storage.session.set({
      [`dl:${id}`]: { tabId: record.tabId, frameId: record.frameId, popup: record.popup, batch: record.batch, filename, jobId, ...(fullNote ? { note: fullNote } : {}) },
    });
    await chrome.storage.session.remove(`job:${jobId}`);
    checkAlreadyFinished(id);
  } catch (err) {
    await chrome.storage.session.remove(`job:${jobId}`);
    releaseJob(jobId);
    notifyTab(record, { type: 'jdi:download-finished', batch: record.batch, ok: false, error: friendlyError(err) });
  }
}

/** A stream link tied to time and place that has gone stale answers 403. */
function isStaleLink(error) {
  return /\b403\b|forbidden|expired|refused the download/i.test(String(error || ''));
}

async function onJobFailed({ jobId, error }) {
  const record = await takeJob(jobId, { remove: true });
  closeOffscreenIfIdle();
  if (!record) return;
  if (record.song && !record.retried && isStaleLink(error)) {
    const settings = await getSettings();
    await chrome.storage.session.set({ [`job:${jobId}`]: { ...record, retried: true } });
    prepareSong(jobId, { ...record.song, fresh: true }, settings).catch((err) => onJobFailed({ jobId, error: friendlyError(err) }));
    return;
  }
  notifyTab(record, {
    type: 'jdi:download-finished',
    batch: record.batch,
    ok: false,
    error: String(error || 'Something went wrong while preparing the file.').slice(0, 300),
  });
}

async function releaseJob(jobId) {
  await toOffscreen({ type: 'jdi:job-release', jobId }).catch(() => {});
  closeOffscreenIfIdle();
}

/** Close the offscreen document once no job or job download needs it. */
function closeOffscreenIfIdle() {
  return withOffscreenLock(async () => {
    const all = await chrome.storage.session.get(null).catch(() => ({}));
    const staleBefore = Date.now() - 6 * 60 * 60 * 1000; // left behind by a crashed worker
    const busy = Object.entries(all).some(
      ([key, value]) => (key.startsWith('job:') && !(value && value.startedAt < staleBefore)) || (key.startsWith('dl:') && value && value.jobId),
    );
    if (busy) return;
    await closeOffscreen();
  });
}

// ---------------------------------------------------------------------------
// Report finished / failed downloads back to the page
// ---------------------------------------------------------------------------

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state && delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  releaseBlobUrl(delta.id);
  finishDownload(delta.id, state);
});

/** A download may finish before its record was stored; check once after storing. */
async function checkAlreadyFinished(id) {
  const [item] = await chrome.downloads.search({ id }).catch(() => []);
  if (item && (item.state === 'complete' || item.state === 'interrupted')) finishDownload(id, item.state);
}

async function finishDownload(id, state) {
  const key = `dl:${id}`;
  const stored = await chrome.storage.session.get(key);
  const record = stored[key];
  if (!record) return;
  await chrome.storage.session.remove(key);

  let error = '';
  if (state === 'interrupted') {
    const [item] = await chrome.downloads.search({ id }).catch(() => []);
    error = describeInterrupt(item && item.error);
  }
  if (record.jobId) releaseJob(record.jobId);
  releaseBlobUrl(id);
  const ok = state === 'complete';
  notifyTab(record, { type: 'jdi:download-finished', batch: record.batch, ok, error, ...(ok && record.note ? { note: record.note } : {}) });
}

function notifyTab(record, message) {
  if (record.popup) {
    onPopupEvent(message);
    return;
  }
  chrome.tabs.sendMessage(record.tabId, message, { frameId: record.frameId }).catch(() => {}); // tab gone
}

function describeInterrupt(code) {
  switch (code) {
    case 'USER_CANCELED':
      return 'Canceled.';
    case 'SERVER_FORBIDDEN':
    case 'SERVER_UNAUTHORIZED':
      return 'The site refused the download (the link may have expired). Reload the page and try again.';
    case 'SERVER_BAD_CONTENT':
    case 'SERVER_FAILED':
    case 'NETWORK_FAILED':
    case 'NETWORK_TIMEOUT':
    case 'NETWORK_DISCONNECTED':
      return 'Network problem while downloading. Try again.';
    case 'FILE_NO_SPACE':
      return 'Your disk is full.';
    case 'FILE_ACCESS_DENIED':
      return `${util.BROWSER_NAME} couldn't write to your downloads folder.`;
    case 'FILE_NAME_TOO_LONG':
      return 'The file name was too long for your downloads folder.';
    default:
      return code ? `Download failed (${code}).` : 'Download failed.';
  }
}

// ---------------------------------------------------------------------------
// Toolbar popup
// ---------------------------------------------------------------------------
//
// Links with a resolver (YouTube, YouTube Music, Spotify, Apple Music, Medal,
// direct files) are resolved here. Anything else is opened in a muted
// background tab and resolved by that site's content script, which also runs
// the downloads (some CDNs want the page's cookies) and relays progress.
// Link tabs close when their downloads finish, or when the popup closes if
// nothing was downloaded.

const LINK_TAB_TIMEOUT_MS = 45000;

// Without host permissions (Firefox may install the extension without them)
// no site can be read; the popup shows an "Allow access" button for this answer.
const NO_ACCESS = { ok: false, needsAccess: true, error: 'Just download it needs access to websites first. Click “Allow access” above.' };

async function hasSiteAccess() {
  return chrome.permissions.contains(util.SITE_ACCESS).catch(() => true);
}
const popupBatches = new Map(); // batch -> { started, refused, done, failed, error, progress }
const popupStatuses = new Map(); // batch -> { batch, text, kind, final, percent, time }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'jdi-popup' || !port.sender || !isPopup(port.sender)) return;
  port.onDisconnect.addListener(() => closeIdleLinkTabs());
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetLinkTab(tabId);
});

async function linkTabs() {
  const stored = await chrome.storage.session.get('linkTabs').catch(() => ({}));
  return stored.linkTabs || {};
}

async function updateLinkTabs(fn) {
  const tabs = await linkTabs();
  fn(tabs);
  await chrome.storage.session.set({ linkTabs: tabs }).catch(() => {});
  return tabs;
}

function forgetLinkTab(tabId) {
  return updateLinkTabs((tabs) => {
    delete tabs[tabId];
  });
}

async function closeLinkTab(tabId, { onlyIdle = false } = {}) {
  const tabs = await linkTabs();
  const entry = tabs[tabId];
  if (!entry || (onlyIdle && entry.busy)) return;
  await forgetLinkTab(tabId);
  if (!entry.borrowed) chrome.tabs.remove(tabId).catch(() => {}); // never close the user's own tab
}

async function closeIdleLinkTabs() {
  const tabs = await linkTabs();
  for (const [id, entry] of Object.entries(tabs)) if (!entry.busy) closeLinkTab(Number(id));
}

/**
 * @param tabId  set when the popup asks about the tab the user is on: that
 *               tab's content script resolves it (with the user's login).
 */
async function resolveForPopup(raw, tabId) {
  if (!(await hasSiteAccess())) return NO_ACCESS;
  const res = await resolveLink(raw);
  if (!res.needsTab) return res;
  if (Number.isInteger(tabId) && tabId >= 0) return resolveInOpenTab(tabId);
  return resolveInTab(res.url);
}

async function resolveInOpenTab(tabId) {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'jdi:resolve-page' }, { frameId: 0 });
  let res = await ask().catch(() => null);
  if (!res) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const files = tab ? contentScriptFilesFor(tab.url || '') : [];
    if (files.length) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files }).catch(() => {});
      res = await ask().catch(() => null);
    }
  }
  if (!res) return { ok: false, error: `${util.BROWSER_NAME} doesn’t let extensions read this page.` };
  if (!res.ok) return res;
  await updateLinkTabs((tabs) => {
    tabs[tabId] = { created: Date.now(), busy: false, borrowed: true };
  });
  return { ok: true, resolution: res.resolution, tabId };
}

async function resolveInTab(url) {
  await closeIdleLinkTabs();
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch {
    return { ok: false, error: 'Couldn’t open that link.' };
  }
  await updateLinkTabs((tabs) => {
    tabs[tab.id] = { created: Date.now(), busy: false };
  });
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {});

  const started = Date.now();
  let loadedAt = 0;
  let last = null;
  while (Date.now() - started < LINK_TAB_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 700));
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) return { ok: false, error: 'The page was closed before it finished loading.' };
    if (current.status === 'complete' && !loadedAt) loadedAt = Date.now();
    if (!loadedAt && Date.now() - started < 8000) continue;
    last = await chrome.tabs.sendMessage(tab.id, { type: 'jdi:resolve-page' }, { frameId: 0 }).catch(() => null);
    if (last && last.ok) return { ok: true, resolution: last.resolution, tabId: tab.id };
    if (last && last.final) break;
    // Pages that fill in their content after loading get a few more tries.
    if (loadedAt && Date.now() - loadedAt > 7000) break;
  }
  closeLinkTab(tab.id);
  return { ok: false, error: (last && last.error) || 'Couldn’t find a photo, video or audio file at that link.' };
}

/**
 * @param message.variants    picked variants; with `collection`, each has a 1-based `position`
 * @param message.collection  { name, total } for "Download all" (and a ZIP or mix of it)
 * @param message.tabId       set when a link tab (or the user's tab) resolved the link: it downloads
 */
async function popupDownload(message) {
  if (!(await hasSiteAccess())) return NO_ACCESS;
  const batch = typeof message.batch === 'string' && message.batch ? message.batch.slice(0, 64) : `p${Date.now().toString(36)}`;
  const site = typeof message.site === 'string' ? message.site.slice(0, 40) : '';
  const variants = limitFiles(message.variants);
  const collection = cleanCollection(message.collection);
  if (!variants.length) return { ok: false, error: 'Nothing to download.' };

  const tabId = Number(message.tabId);
  if (message.tabId != null && Number.isInteger(tabId)) {
    const tabs = await linkTabs();
    if (!tabs[tabId]) return { ok: false, error: 'That page was closed. Paste the link again.' };
    await updateLinkTabs((all) => {
      if (all[tabId]) all[tabId].busy = true;
    });
    const res = await chrome.tabs
      .sendMessage(tabId, { type: 'jdi:download-variants', site, variants, batch, ...(collection ? { collection } : {}) }, { frameId: 0 })
      .catch(() => ({ ok: false, error: 'That page was closed. Paste the link again.' }));
    if (!res || !res.ok) {
      emitPopupStatus(batch, { text: (res && res.error) || 'Download failed.', kind: 'error', final: true, percent: 100 });
      closeLinkTab(tabId);
      return { ok: false, error: (res && res.error) || 'Download failed.', batch };
    }
    return { ok: true, batch };
  }

  const files = variants.map((v) => ({ url: v.url, filename: v.filename, ext: v.ext, job: v.job, position: v.position }));
  const { results } = await startFiles(files, { site, origin: { popup: true, batch }, collection });
  const started = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);
  const state = {
    started: started.length,
    refused: refused.length,
    done: 0,
    failed: 0,
    error: refused[0] ? refused[0].error : '',
    progress: Object.fromEntries(started.filter((r) => r.jobId).map((r) => [r.jobId, 0])),
  };
  if (!started.length) {
    emitPopupStatus(batch, { text: state.error || 'Download failed.', kind: 'error', final: true, percent: 100 });
    return { ok: false, error: state.error || 'Download failed.', batch };
  }
  popupBatches.set(batch, state);
  // Events that arrived while the files were starting.
  for (const message of earlyPopupEvents.get(batch) || []) applyPopupEvent(state, message);
  earlyPopupEvents.delete(batch);
  emitPopupStatus(batch, util.batchStatus(state));
  if (state.done + state.failed >= state.started) popupBatches.delete(batch);
  return { ok: true, batch };
}

const earlyPopupEvents = new Map();

function applyPopupEvent(state, message) {
  if (message.type === 'jdi:job-progress') {
    if (message.jobId in state.progress) state.progress[message.jobId] = Math.max(state.progress[message.jobId], Number(message.progress) || 0);
  } else if (message.type === 'jdi:download-finished') {
    if (message.ok) {
      state.done++;
      const note = joinNotes(state.note, message.note);
      if (note) state.note = note;
    } else {
      state.failed++;
      state.error = state.error || message.error || '';
    }
  }
}

function onPopupEvent(message) {
  const state = popupBatches.get(message.batch);
  if (!state) {
    if (!earlyPopupEvents.has(message.batch)) earlyPopupEvents.set(message.batch, []);
    earlyPopupEvents.get(message.batch).push(message);
    if (earlyPopupEvents.size > 50) earlyPopupEvents.delete(earlyPopupEvents.keys().next().value);
    return;
  }
  applyPopupEvent(state, message);
  const status = util.batchStatus(state);
  if (status.final) popupBatches.delete(message.batch);
  emitPopupStatus(message.batch, status);
}

async function onRelayStatus(message, sender) {
  const tabs = await linkTabs();
  if (!tabs[sender.tab.id]) return; // only tabs opened for the popup relay
  const batch = String(message.batch || '').slice(0, 64);
  emitPopupStatus(batch, {
    text: String(message.text || '').slice(0, 300),
    kind: ['info', 'success', 'error'].includes(message.kind) ? message.kind : 'info',
    final: !!message.final,
    percent: Math.max(0, Math.min(100, Number(message.percent) || 0)),
  });
  if (message.final) setTimeout(() => closeLinkTab(sender.tab.id), 1500);
}

function emitPopupStatus(batch, status) {
  const entry = { batch, text: status.text, kind: status.kind, final: !!status.final, percent: status.percent || 0, time: Date.now() };
  popupStatuses.set(batch, entry);
  while (popupStatuses.size > 6) popupStatuses.delete(popupStatuses.keys().next().value);
  chrome.storage.session.set({ popupStatuses: Array.from(popupStatuses.values()) }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'jdi:popup-status', ...entry }).catch(() => {}); // popup closed
  updateBadge();
}

let badgeTimer = 0;
function updateBadge() {
  const all = Array.from(popupStatuses.values());
  const active = all.filter((s) => !s.final);
  clearTimeout(badgeTimer);
  if (active.length) {
    const percent = Math.round(active.reduce((a, s) => a + s.percent, 0) / active.length);
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' }).catch(() => {});
    chrome.action.setBadgeText({ text: `${Math.min(99, percent)}%` }).catch(() => {});
    return;
  }
  const latest = all.sort((a, b) => b.time - a.time)[0];
  if (latest && Date.now() - latest.time < 10000) {
    chrome.action.setBadgeBackgroundColor({ color: latest.kind === 'error' ? '#dc2626' : '#16a34a' }).catch(() => {});
    chrome.action.setBadgeText({ text: latest.kind === 'error' ? '!' : 'OK' }).catch(() => {});
    badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 8000);
  } else {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

async function popupOpened() {
  if (!popupStatuses.size) {
    const stored = await chrome.storage.session.get('popupStatuses').catch(() => ({}));
    for (const entry of stored.popupStatuses || []) popupStatuses.set(entry.batch, entry);
  }
  const statuses = Array.from(popupStatuses.values());
  if (!statuses.some((s) => !s.final)) chrome.action.setBadgeText({ text: '' }).catch(() => {});
  return { ok: true, statuses };
}

function isOwnSite(sender) {
  if (sender.frameId !== 0) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'https:' && url.hostname === SITE_HOST;
  } catch {
    return false;
  }
}

/**
 * The website's "Paste a link" page (or a link typed after its address) asks
 * for a link: open the popup with it, where the person picks what to save.
 * Opening the toolbar popup needs Chrome 127+ and a focused window, and Firefox
 * only allows it straight from a click, so otherwise the popup opens in a small
 * window of its own (a tab on Firefox for Android).
 */
async function openLinkFromSite(url, tab) {
  const link = String(url || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(link) || link.length > 4096) return { ok: false, error: 'That doesn’t look like a web link.' };
  await chrome.storage.session.set({ [POPUP_PENDING_KEY]: { url: link, time: Date.now() } });
  try {
    await chrome.action.openPopup({ windowId: tab.windowId });
    return { ok: true, opened: 'popup' };
  } catch {
    /* not allowed here: fall back to a window */
  }
  // Firefox for Android has no windows: a tab it is.
  if (chrome.windows && chrome.windows.create) {
    await chrome.windows.create({ url: `${POPUP_URL}?window=1`, type: 'popup', width: 420, height: 640, focused: true });
    return { ok: true, opened: 'window' };
  }
  await chrome.tabs.create({ url: `${POPUP_URL}?window=1`, active: true });
  return { ok: true, opened: 'tab' };
}

async function captureActiveTab(mode) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null || !/^https?:/i.test(tab.url || '')) {
    return { ok: false, error: 'Open a web page first, then try again.' };
  }
  return startCapture(tab, mode);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.sync.get(util.DEFAULT_SETTINGS).catch(() => ({}));
  return util.cleanSettings(stored);
}
