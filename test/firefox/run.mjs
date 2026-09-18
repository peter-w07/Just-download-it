// Firefox checks: builds dist/firefox, loads it into a real Firefox and uses
// it against the real sites (needs internet), like test/live does for Chrome.
//
//   npm run test:firefox
//   HEADFUL=1 npm run test:firefox          (watch it)
//   FIREFOX=C:\path\to\firefox.exe ...       (default: the newest Firefox in
//                                             Puppeteer's cache; install one with
//                                             npx @puppeteer/browsers install firefox@stable)
//
// How it drives Firefox: Puppeteer over WebDriver BiDi, with the extension
// installed as a temporary add-on. BiDi can't open extension pages itself, so
// the test copy of the build gets one extra background script (test-hook.js)
// that opens popup/popup.html in a tab on install. That tab is the test's
// handle on the extension: it runs extension APIs, reaches the event page with
// runtime.getBackgroundPage(), and calls helpers (content-helpers.js) in a
// site's content scripts with scripting.executeScript (Firefox shares one
// sandbox per page between them; extension pages can't eval, so they go by name).
// Firefox prints console messages and script errors to stdout (the
// devtools.console.stdout.* prefs), which is how errors from the extension are caught.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getInstalledBrowsers } from '@puppeteer/browsers';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import puppeteer from 'puppeteer';
import { buildFirefox, GECKO_ID } from '../../scripts/build-firefox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
// Short paths: Windows still trips over long ones, and the files have long names.
const WORK = join(tmpdir(), 'jdi-ff');
const EXT = join(WORK, 'ext');
const DOWNLOADS = join(WORK, 'dl');
const UUID = '5f0c9d7e-2b1a-4c3d-8e6f-a1b2c3d4e5f6';
const EXT_ORIGIN = `moz-extension://${UUID}`;
// Shorter than Firefox's 30 s, so a job that doesn't keep the event page awake fails here.
const IDLE_TIMEOUT_MS = 15000;

const YOUTUBE_VIDEO = 'jNQXAC9IVRw'; // "Me at the zoo", 19 s
const SPOTIFY_TRACKS = ['https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b'];

// ----------------------------------------------------------------------------
// Build and launch
// ----------------------------------------------------------------------------

const { manifest } = buildFirefox();
rmSync(WORK, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });
cpSync(join(root, 'dist', 'firefox'), EXT, { recursive: true });
manifest.background.scripts.push('test-hook.js');
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(
  join(EXT, 'test-hook.js'),
  "chrome.runtime.onInstalled.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') }));\n",
);
cpSync(join(here, 'content-helpers.js'), join(EXT, 'test-content-helpers.js'));
// Count how often the content script core runs in a page (it must be once).
const core = join(EXT, 'content', 'core.js');
writeFileSync(core, `globalThis.__jdiCoreRuns = (globalThis.__jdiCoreRuns || 0) + 1;
${readFileSync(core, 'utf8')}`);

async function firefoxPath() {
  if (process.env.FIREFOX) return process.env.FIREFOX;
  const cacheDir = join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'puppeteer');
  const installed = (await getInstalledBrowsers({ cacheDir })).filter((b) => b.browser === 'firefox');
  installed.sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }));
  if (!installed.length) throw new Error('No Firefox found. Run: npx @puppeteer/browsers install firefox@stable (or set FIREFOX)');
  return installed[0].executablePath;
}

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: await firefoxPath(),
  headless: !process.env.HEADFUL,
  // Lets BiDi run code in extension pages (moz-extension:).
  args: ['-remote-allow-system-access'],
  defaultViewport: { width: 1400, height: 1000 },
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [GECKO_ID]: UUID }),
    'extensions.background.idle.timeout': IDLE_TIMEOUT_MS,
    // permissions.request() answers without a prompt (the "Allow access" button).
    'extensions.webextOptionalPermissionPrompts': false,
    'devtools.console.stdout.chrome': true,
    'devtools.console.stdout.content': true,
    'browser.download.dir': DOWNLOADS,
    'browser.download.folderList': 2,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.alwaysOpenPanel': false,
    'browser.download.manager.addToRecentDocs': false,
    'media.autoplay.default': 5,
  },
});

// Firefox's console, as it prints it: keep what came from this extension.
const extensionLog = [];
for (const stream of [browser.process().stdout, browser.process().stderr]) {
  if (!stream) continue;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (line.includes(EXT_ORIGIN) || line.includes('[Just download it]')) extensionLog.push(line.slice(0, 600));
    }
  });
}
const extensionErrors = () => extensionLog.filter((l) => /JavaScript error|console\.(error|warn)|Error/i.test(l));

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 250, message = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message}. Last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

// A page that's already open when the extension is installed (Firefox injects
// the content scripts into it; the extension must not add a second copy).
const [preinstalled] = await browser.pages();
await preinstalled.goto('https://example.org/', { waitUntil: 'domcontentloaded' });

await browser.installExtension(EXT);
/** The popup page, open in a tab: the test's handle on the extension. */
const ext = await waitFor(
  async () => {
    for (const page of await browser.pages()) {
      const href = await page.evaluate(() => location.href).catch(() => '');
      if (href.startsWith(`${EXT_ORIGIN}/popup/popup.html`)) return page;
    }
    return null;
  },
  { message: 'the extension to open its test tab' },
);

/** Run `fn` in the extension tab (with chrome.* APIs). */
const inExt = (fn, ...args) => ext.evaluate(fn, ...args);

/**
 * Grant host permissions the way Firefox does when the user allows them, by
 * running privileged code in the browser window (BiDi's chrome scope, which
 * -remote-allow-system-access enables). Returns false if this Firefox won't.
 */
async function grantLikeTheUser(origins) {
  try {
    const tree = await browser.connection.send('browsingContext.getTree', { 'moz:scope': 'chrome' });
    const context = tree.result.contexts[0].context;
    const expression = `(async () => {
      const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
      const policy = WebExtensionPolicy.getByID(${JSON.stringify(GECKO_ID)});
      await ExtensionPermissions.add(policy.id, { permissions: [], origins: ${JSON.stringify(origins)} }, policy.extension);
      return true;
    })()`;
    const res = await browser.connection.send('script.evaluate', { expression, target: { context }, awaitPromise: true });
    return res.result.type === 'success';
  } catch (err) {
    console.log(`      (couldn't grant from the browser window: ${String(err.message).split(/\r?\n/)[0]})`);
    return false;
  }
}

/** A page of the extension opened by `open` (run in the extension tab), found by its path. */
async function extensionPage(path, open) {
  const known = new Set(await browser.pages());
  await inExt(open);
  return waitFor(
    async () => {
      for (const page of await browser.pages()) {
        if (known.has(page)) continue;
        const href = await page.evaluate(() => location.href).catch(() => '');
        if (href.startsWith(`${EXT_ORIGIN}/${path}`)) return page;
      }
      return null;
    },
    { message: path },
  );
}

/** Call helper `name` (content-helpers.js) in the content scripts of the tab whose URL starts with `prefix`. */
async function inTab(prefix, name, ...args) {
  return inExt(
    async (prefix, name, args) => {
      const tabs = (await chrome.tabs.query({})).filter((t) => (t.url || '').startsWith(prefix));
      if (!tabs.length) throw new Error(`no tab at ${prefix}`);
      const target = { tabId: tabs[0].id };
      // A leading slash: Firefox resolves these paths from the calling page, Chrome from the root.
      await chrome.scripting.executeScript({ target, files: ['/test-content-helpers.js'] });
      const [res] = await chrome.scripting.executeScript({ target, func: (name, args) => globalThis.JDI_TEST[name](...args), args: [name, args] });
      return res && res.result;
    },
    prefix,
    name,
    args,
  );
}

async function openPage(url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

let lastDownloadId = 0;
/** Wait for `count` downloads started after the previous call to finish; oldest first. */
async function newDownloads(count, timeout = 60000) {
  const items = await waitFor(
    async () => {
      const all = await inExt(() => chrome.downloads.search({ orderBy: ['startTime'] }));
      const fresh = all.filter((d) => d.id > lastDownloadId);
      if (fresh.length < count || fresh.some((d) => d.state === 'in_progress')) return null;
      return fresh;
    },
    { timeout, interval: 500, message: `${count} download(s) to finish` },
  );
  lastDownloadId = Math.max(lastDownloadId, ...items.map((d) => d.id));
  return items;
}

/** Wait for a popup download batch to end; fails with its error text if it failed. */
async function batchDone(batch, timeout) {
  const status = await waitFor(
    async () => {
      const { popupStatuses = [] } = await inExt(() => chrome.storage.session.get('popupStatuses'));
      const entry = popupStatuses.find((s) => s.batch === batch);
      return entry && entry.final ? entry : null;
    },
    { timeout, interval: 500, message: `batch ${batch} to finish` },
  );
  assert.equal(status.kind, 'success', status.text);
  return status;
}

function relative(item) {
  return item.filename.slice(DOWNLOADS.length + 1).replaceAll('\\', '/');
}

async function probeMedia(path) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(readFileSync(path)) });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  return {
    format: (await input.getFormat()).name,
    video: video ? { codec: await video.getCodec(), height: await video.getDisplayHeight() } : null,
    audio: audio ? { codec: await audio.getCodec() } : null,
    duration: await input.computeDuration(),
  };
}

/** Entry names in a ZIP file, from its central directory (ZIP64 too). */
function zipNames(path) {
  const buf = readFileSync(path);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'a ZIP file');
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    const record = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    count = Number(buf.readBigUInt64LE(record + 32));
    offset = Number(buf.readBigUInt64LE(record + 48));
  }
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, 'central directory entry');
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** The popup (in the extension tab): rows it lists, and the download statuses under them. */
function popupState() {
  return {
    access: !document.getElementById('access').hidden,
    state: (document.querySelector('#result .state') || {}).textContent || '',
    title: (document.querySelector('#result .title') || {}).textContent || '',
    rows: Array.from(document.querySelectorAll('#result .row')).map((row) => ({
      label: row.querySelector('.label').textContent,
      detail: row.querySelector('.detail').textContent,
      state: ['busy', 'done', 'failed'].find((c) => row.classList.contains(c)) || '',
    })),
    statuses: Array.from(document.querySelectorAll('#downloads .status')).map((s) => s.textContent),
  };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test('extension loads: event page runs, header rules use its UUID, no errors', async () => {
  const state = await inExt(async () => {
    const bg = await chrome.runtime.getBackgroundPage();
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return {
      background: !!(bg && bg.JDI && bg.JDI.background),
      rules: rules.map((r) => r.condition.initiatorDomains),
      access: await chrome.permissions.contains({ origins: ['<all_urls>'] }),
    };
  });
  assert.ok(state.background, 'the background module ran to the end');
  assert.ok(state.rules.length >= 2, 'Origin rules installed');
  for (const domains of state.rules) assert.deepEqual(domains, [UUID]);
  assert.ok(state.access, 'host permissions granted at install');
  await waitFor(() => inTab('https://example.org/', 'ready'), { message: 'content scripts in the tab open before install' });
  await sleep(1000);
  assert.equal(await inTab('https://example.org/', 'coreRuns'), 1, 'one copy of the content scripts');
  assert.deepEqual(extensionErrors(), []);
});

test('right-click menu: "Just download media" on an image opens the picker', async () => {
  const page = await openPage('https://example.com/');
  await waitFor(() => inTab('https://example.com/', 'ready'), { message: 'the content script' });
  const { x, y, src } = await inTab('https://example.com/', 'addImage');
  await page.mouse.click(x, y, { button: 'right' });
  await page.keyboard.press('Escape'); // the browser's own menu, if it opened
  // What clicking the menu item does (automation can't click a native menu).
  await inExt(async (pageUrl, srcUrl) => {
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === pageUrl);
    const bg = await chrome.runtime.getBackgroundPage();
    await bg.JDI.background.invokeInTab(tab, { frameId: 0, pageUrl, srcUrl, mediaType: 'image' });
  }, 'https://example.com/', src);
  const state = await waitFor(
    async () => {
      const s = await inTab('https://example.com/', 'pickerState');
      return s && s.open && !s.loading ? s : null;
    },
    { message: 'the picker' },
  );
  assert.equal(state.error, '');
  assert.ok(state.rows.length >= 1, `rows: ${state.rows.join(', ')}`);
  await page.close();
});

test('youtube.com: the Download button opens the quality picker', async () => {
  const page = await openPage(`https://www.youtube.com/watch?v=${YOUTUBE_VIDEO}`);
  await page.bringToFront();
  // YouTube keeps moving its action bar around for a while: wait until the button stays put.
  const { x, y } = await waitFor(
    async () => {
      const a = await inTab('https://www.youtube.com/', 'buttonPoint');
      await sleep(500);
      const b = await inTab('https://www.youtube.com/', 'buttonPoint');
      return a && b && a.x === b.x && a.y === b.y ? b : null;
    },
    { timeout: 30000, message: 'the Download button' },
  );
  await page.mouse.click(x, y);
  const state = await waitFor(
    async () => {
      const s = await inTab('https://www.youtube.com/', 'pickerState');
      return s && s.open && !s.loading ? s : null;
    },
    { timeout: 30000, message: 'the picker to list qualities' },
  );
  assert.equal(state.error, '');
  assert.match(state.title, /zoo/i);
  assert.ok(state.rows.includes('MP3'), `rows: ${state.rows.join(', ')}`);
  assert.ok(state.rows.some((r) => /^\d+p$/.test(r)), `rows: ${state.rows.join(', ')}`);
  await page.close();
});

test('popup: a YouTube link, saved as the smallest MP4 (combined here) and as an MP3 (encoded here)', async () => {
  await inExt((url) => {
    document.getElementById('link').value = url;
    document.getElementById('form').requestSubmit();
  }, `https://www.youtube.com/watch?v=${YOUTUBE_VIDEO}`);
  const listed = await waitFor(
    async () => {
      const s = await inExt(popupState);
      return s.rows.length ? s : null;
    },
    { timeout: 30000, message: 'the popup to list qualities' },
  );
  const labels = listed.rows.map((r) => r.label);
  const videos = labels.filter((l) => /^\d+p$/.test(l));
  assert.ok(videos.length && labels.includes('MP3'), `rows: ${labels.join(', ')}`);
  const smallest = videos[videos.length - 1];

  await inExt((label) => Array.from(document.querySelectorAll('#result .row')).find((r) => r.querySelector('.label').textContent === label).click(), smallest);
  const [mp4] = await newDownloads(1, 120000);
  assert.equal(mp4.state, 'complete', mp4.error);
  assert.equal(relative(mp4), `Just Download It/YouTube/Me at the zoo [${YOUTUBE_VIDEO}] ${smallest}.mp4`);
  const video = await probeMedia(mp4.filename);
  assert.ok(video.video && video.audio, `video and audio: ${JSON.stringify(video)}`);
  assert.ok(video.duration > 18 && video.duration < 20, `duration ${video.duration}`);

  await inExt(() => Array.from(document.querySelectorAll('#result .row')).find((r) => r.querySelector('.label').textContent === 'MP3').click());
  const [mp3] = await newDownloads(1, 120000);
  assert.equal(mp3.state, 'complete', mp3.error);
  assert.equal(relative(mp3), `Just Download It/YouTube/Me at the zoo [${YOUTUBE_VIDEO}].mp3`);
  const audio = await probeMedia(mp3.filename);
  assert.equal(audio.audio && audio.audio.codec, 'mp3');
  assert.ok(audio.duration > 18 && audio.duration < 20, `duration ${audio.duration}`);

  const s = await inExt(popupState);
  assert.ok(s.statuses.some((t) => /^Saved/.test(t)), `statuses: ${s.statuses.join(' / ')}`);
});

test('popup: two Spotify songs in one ZIP', async () => {
  const resolutions = [];
  for (const url of SPOTIFY_TRACKS) {
    const res = await inExt((url) => chrome.runtime.sendMessage({ type: 'jdi:resolve-link', url }), url);
    assert.ok(res && res.ok, `resolved ${url}: ${JSON.stringify(res && res.error)}`);
    resolutions.push(res.resolution);
  }
  const started = await inExt(async (resolutions) => {
    const { util } = globalThis.JDI;
    const settings = util.cleanSettings(await chrome.storage.sync.get(util.DEFAULT_SETTINGS));
    const both = { site: 'Spotify', title: 'Two songs', collection: { name: 'Two songs' }, items: resolutions.map((r) => r.items[0]), focus: 0 };
    const zip = util.bundleVariant(both, 'zip', settings);
    return chrome.runtime.sendMessage({ type: 'jdi:popup-download', site: 'Spotify', variants: [zip], batch: 'ff-zip', collection: util.collectionOf(both) });
  }, resolutions);
  assert.ok(started && started.ok, JSON.stringify(started));
  await batchDone('ff-zip', 300000);
  const [zip] = await newDownloads(1);
  assert.equal(zip.state, 'complete', zip.error);
  assert.equal(relative(zip), 'Just Download It/Spotify/Two songs.zip');
  const names = zipNames(zip.filename);
  assert.equal(names.length, 2, `entries: ${names.join(', ')}`);
  for (const name of names) assert.match(name, /^0[12] - .+\.mp3$/);
});

test('popup: two Spotify songs mixed into one MP3 (decoded with Web Audio, encoded here)', async () => {
  const resolutions = [];
  for (const url of SPOTIFY_TRACKS) {
    const res = await inExt((url) => chrome.runtime.sendMessage({ type: 'jdi:resolve-link', url }), url);
    assert.ok(res && res.ok, `resolved ${url}: ${JSON.stringify(res && res.error)}`);
    resolutions.push(res.resolution);
  }
  const started = await inExt(async (resolutions) => {
    const { util } = globalThis.JDI;
    const settings = util.cleanSettings(await chrome.storage.sync.get(util.DEFAULT_SETTINGS));
    const both = { site: 'Spotify', title: 'Two songs', collection: { name: 'Two songs' }, items: resolutions.map((r) => r.items[0]), focus: 0 };
    const mix = util.bundleVariant(both, 'mix', settings);
    return chrome.runtime.sendMessage({ type: 'jdi:popup-download', site: 'Spotify', variants: [mix], batch: 'ff-mix', collection: util.collectionOf(both) });
  }, resolutions);
  assert.ok(started && started.ok, JSON.stringify(started));
  await batchDone('ff-mix', 600000);
  const [mix] = await newDownloads(1);
  assert.equal(mix.state, 'complete', mix.error);
  assert.equal(relative(mix), 'Just Download It/Spotify/Two songs (mix).mp3');
  const audio = await probeMedia(mix.filename);
  assert.equal(audio.audio && audio.audio.codec, 'mp3');
  // Two songs of 3:20-3:35, less the crossfade and trimmed silence.
  assert.ok(audio.duration > 380 && audio.duration < 440, `duration ${audio.duration}`);
});

test('page files (screenshots, TikTok) and inline images: saved under their real name', async () => {
  const page = await openPage('https://example.com/');
  await waitFor(() => inTab('https://example.com/', 'ready'), { message: 'the content script' });
  const res = await inTab('https://example.com/', 'savePng', 'Example page');
  assert.ok(res && res.ok, JSON.stringify(res));
  const [png] = await newDownloads(1);
  assert.equal(png.state, 'complete', png.error);
  assert.equal(relative(png), 'Just Download It/Captures/Example page.png');
  assert.equal(readFileSync(png.filename).subarray(1, 4).toString(), 'PNG');

  // Inline (data:) images: Firefox's downloads API refuses data: URLs.
  const res2 = await inTab('https://example.com/', 'saveDataUrl', 'Inline pixel');
  assert.ok(res2 && res2.ok, JSON.stringify(res2));
  const [pixel] = await newDownloads(1);
  assert.equal(pixel.state, 'complete', pixel.error);
  assert.equal(relative(pixel), 'Just Download It/Example/Inline pixel.png');
  await page.close();
});

test('jobs keep the event page awake; it sleeps again when idle', async () => {
  // The ZIP above took longer than the idle timeout, so the page stayed up for it.
  await sleep(IDLE_TIMEOUT_MS + 5000);
  const marker = await inExt(async () => {
    const bg = await chrome.runtime.getBackgroundPage();
    const was = bg.__jdiTestMarker;
    bg.__jdiTestMarker = 1;
    return was;
  });
  assert.equal(marker, undefined, 'a fresh page after the idle timeout');
  await sleep(IDLE_TIMEOUT_MS + 5000);
  const again = await inExt(async () => (await chrome.runtime.getBackgroundPage()).__jdiTestMarker);
  assert.equal(again, undefined, 'idle again: the page slept');
});

test('access: without host permissions, the popup and settings offer "Allow access"', async () => {
  await inExt(() => chrome.permissions.remove({ origins: ['<all_urls>', 'http://*/*', 'https://*/*'] }));
  assert.equal(await inExt(() => chrome.permissions.contains({ origins: ['<all_urls>'] })), false);

  // A popup opened now, and the settings page, both offer the button.
  const popup = await extensionPage('popup/popup.html', () => chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') }));
  await waitFor(() => popup.evaluate(() => !document.getElementById('access').hidden), { message: 'the popup to show Allow access' });
  const refused = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'jdi:resolve-link', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }));
  assert.equal(refused.needsAccess, true);
  const optionsPage = await extensionPage('options/options.html', () => chrome.runtime.openOptionsPage());
  await waitFor(() => optionsPage.evaluate(() => !document.getElementById('access').hidden), { message: 'settings to show Allow access' });

  // The button asks for exactly this. Granting it takes a real click: Firefox
  // only answers permissions.request during user input, and BiDi can't send
  // input to extension pages. So the test checks what the click asks for.
  const asked = await popup.evaluate(() => {
    const calls = [];
    const request = chrome.permissions.request;
    try {
      chrome.permissions.request = (perms) => {
        calls.push(perms);
        return request.call(chrome.permissions, perms).catch(() => false);
      };
    } catch {
      return null; // not replaceable here
    }
    document.getElementById('grant-access').click();
    chrome.permissions.request = request;
    return calls;
  });
  assert.deepEqual(asked, [{ origins: ['<all_urls>'] }]);

  // Granted (as the click would): both pages drop the button, and a page that
  // was already open gets the content scripts.
  const early = await openPage('https://example.com/');
  if (await grantLikeTheUser(['<all_urls>', 'http://*/*', 'https://*/*'])) {
    await waitFor(() => inExt(() => chrome.permissions.contains({ origins: ['<all_urls>'] })), { message: 'access to be granted' });
    await waitFor(() => popup.evaluate(() => document.getElementById('access').hidden), { message: 'the popup to hide Allow access' });
    await waitFor(() => optionsPage.evaluate(() => document.getElementById('access').hidden), { message: 'settings to hide Allow access' });
    await waitFor(() => inTab('https://example.com/', 'ready'), { message: 'content scripts in a page opened before access was granted' });
  }
  await early.close();
  await popup.close();
  await optionsPage.close();
});

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------

let failed = 0;
const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
try {
  for (const { name, fn } of tests) {
    if (only && !only.test(name)) continue;
    const started = Date.now();
    try {
      await fn();
      console.log(`ok    ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  const errors = extensionErrors();
  if (errors.length) {
    failed++;
    console.log(`FAIL  errors from the extension:\n      ${errors.join('\n      ')}`);
  }
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : `\nall ${only ? 'selected ' : ''}Firefox checks passed`);
process.exit(failed ? 1 : 0);
