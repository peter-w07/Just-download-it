// End-to-end tests: loads the real unpacked extension into Chrome for Testing,
// serves fake Instagram / CDN / generic sites over local HTTPS, right-clicks
// things, and checks the picker and the files that land on disk.
//
//   npm run test:e2e            (headless)
//   HEADFUL=1 npm run test:e2e  (watch it)
//
// Needs ffmpeg and openssl on PATH (used once to generate fixtures).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import puppeteer from 'puppeteer';
import { prepare } from './setup.mjs';
import { CDN_HOST, CODES, GENERIC_HOST, GVS_HOST, HIGHLIGHT_ID, IG_HOST, PKS, SITE_HOST, YT_HOST, YTIMG_HOST, startServer } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const EXTENSION = join(root, 'extension');
const WORK = join(here, '.work');
const PROFILE = join(WORK, 'profile');
const DOWNLOADS = join(WORK, 'downloads');

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function waitFor(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message}. Last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

rmSync(PROFILE, { recursive: true, force: true });
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(join(PROFILE, 'Default'), { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });
// Downloads go to our folder without prompting.
writeFileSync(
  join(PROFILE, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: DOWNLOADS, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: DOWNLOADS },
  }),
);

console.log('Preparing fixtures (first run generates media with ffmpeg)…');
const fixtures = prepare(WORK);
const server = await startServer(fixtures);
const PORT = server.port;
const IG = `https://${IG_HOST}:${PORT}`;
const GENERIC = `https://${GENERIC_HOST}:${PORT}`;
const SITE = `https://${SITE_HOST}:${PORT}`;

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  enableExtensions: [EXTENSION],
  pipe: true,
  userDataDir: PROFILE,
  acceptInsecureCerts: true,
  defaultViewport: { width: 1280, height: 900 },
  args: [
    `--host-resolver-rules=${[IG_HOST, CDN_HOST, GENERIC_HOST, YT_HOST, GVS_HOST, YTIMG_HOST, SITE_HOST].map((h) => `MAP ${h} 127.0.0.1`).join(", ")}`,
    '--ignore-certificate-errors',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const swTarget = await browser.waitForTarget(
  (t) => t.type() === 'service_worker' && t.url().endsWith('/background/service-worker.js'),
  { timeout: 15000 },
);
const EXTENSION_ID = new URL(swTarget.url()).host;
let currentSwTarget = swTarget;
let sw = await swTarget.worker();

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/** Wait for a service worker target other than `old` (after a restart or reload). */
async function nextWorker(old) {
  const t = await browser.waitForTarget(
    (x) => x !== old && x.type() === 'service_worker' && x.url().includes(EXTENSION_ID),
    { timeout: 15000 },
  );
  currentSwTarget = t;
  sw = await t.worker();
  return sw;
}

async function worker() {
  // The service worker can be stopped and restarted; always talk to the live one.
  try {
    await withTimeout(sw.evaluate(() => 1), 3000);
  } catch {
    await nextWorker(currentSwTarget);
  }
  // Right after start-up the worker can run before its extension APIs are bound.
  await waitFor(() => withTimeout(sw.evaluate(() => !!(globalThis.chrome && chrome.runtime && chrome.downloads)), 3000), {
    message: 'extension APIs in the service worker',
  });
  return sw;
}

async function openPage(url) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(url, { waitUntil: 'load' });
  await page.bringToFront();
  page.jdiErrors = errors;
  return page;
}

async function realm(page) {
  return waitFor(
    async () => {
      for (const r of page.mainFrame().extensionRealms()) {
        const ext = await r.extension();
        if (ext && ext.id === EXTENSION_ID) return r;
      }
      return null;
    },
    { message: 'the content script to load' },
  );
}

async function center(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    node.scrollIntoView({ block: 'center' });
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector);
}

/** Right-click at the element's center, then do what clicking "Just download it" does. */
async function justDownloadIt(page, selector, info = {}) {
  await realm(page);
  const { x, y } = await center(page, selector);
  await page.mouse.click(x, y, { button: 'right' });
  const w = await worker();
  await w.evaluate(
    async (pageUrl, extra) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await globalThis.JDI.background.invokeInTab(tab, { frameId: 0, pageUrl, ...extra });
    },
    page.url(),
    info,
  );
  return { x, y };
}

async function pickerState(page) {
  const r = await realm(page);
  return r.evaluate(() => {
    const host = document.querySelector('jdi-root');
    if (!host) return { exists: false, open: false, toasts: [] };
    const shadow = chrome.dom.openOrClosedShadowRoot(host);
    const toasts = Array.from(shadow.querySelectorAll('.toast')).map((t) => ({
      kind: t.className.replace('toast', '').trim(),
      text: t.querySelector('.msg').textContent,
    }));
    const panel = shadow.querySelector('.panel');
    if (!panel) return { exists: true, open: false, toasts };
    const rows = Array.from(panel.querySelectorAll('.row'));
    return {
      exists: true,
      open: true,
      loading: !!panel.querySelector('.state .spinner'),
      error: (panel.querySelector('.state.error') || {}).textContent || '',
      title: panel.querySelector('.title').textContent,
      notice: (panel.querySelector('.notice') || {}).textContent || '',
      chips: Array.from(panel.querySelectorAll('.chip')).map((c) => c.getAttribute('aria-pressed') === 'true'),
      sections: Array.from(panel.querySelectorAll('.section')).map((n) => n.textContent),
      rows: rows.map((row) => ({
        label: row.querySelector('.label').textContent,
        detail: row.querySelector('.detail').textContent,
        best: !!row.querySelector('.badge'),
        state: ['busy', 'done', 'failed'].find((c) => row.classList.contains(c)) || '',
      })),
      all: (panel.querySelector('.all') || {}).textContent || '',
      tag: panel.tagName.toLowerCase(),
      modal: panel.matches(':modal'),
      panelRect: (() => {
        const r = panel.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      })(),
      firstRowCenter: rows[0]
        ? (() => {
            const r = rows[0].getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()
        : null,
      focusedRow: rows.indexOf(shadow.activeElement),
      inTopLayer: panel.matches(':popover-open'),
      radius: getComputedStyle(panel).borderTopLeftRadius,
      theme: shadow.querySelector('.layer').getAttribute('data-theme'),
    };
  });
}

async function waitForPicker(page) {
  return waitFor(
    async () => {
      const s = await pickerState(page);
      return s.open && !s.loading ? s : null;
    },
    { message: 'the picker to finish loading' },
  );
}

async function clickInPicker(page, selector, index = 0) {
  const r = await realm(page);
  await r.evaluate(
    (sel, i) => {
      const shadow = chrome.dom.openOrClosedShadowRoot(document.querySelector('jdi-root'));
      shadow.querySelectorAll(sel)[i].click();
    },
    selector,
    index,
  );
}

let lastDownloadId = 0;
/** Wait for `count` downloads started after the previous call to finish; returns them oldest first. */
async function newDownloads(count, timeout = 20000) {
  const items = await waitFor(
    async () => {
      const w = await worker();
      const all = await w.evaluate(() => chrome.downloads.search({ orderBy: ['startTime'] }));
      const fresh = all.filter((d) => d.id > lastDownloadId);
      if (fresh.length < count) return null;
      if (fresh.some((d) => d.state === 'in_progress')) return null;
      return fresh;
    },
    { timeout, message: `${count} download(s) to finish` },
  );
  lastDownloadId = Math.max(lastDownloadId, ...items.map((d) => d.id));
  return items;
}

function relative(item) {
  return item.filename.slice(DOWNLOADS.length + 1).replaceAll('\\', '/');
}

function mediaFile(name) {
  return readFileSync(join(fixtures.media, name));
}

async function probeMp4(path) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(readFileSync(path)) });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  return {
    video: video ? { codec: await video.getCodec(), width: await video.getDisplayWidth(), height: await video.getDisplayHeight() } : null,
    audio: audio ? { codec: await audio.getCodec() } : null,
    duration: await input.computeDuration(),
  };
}

async function setSettings(values) {
  const w = await worker();
  await w.evaluate((v) => chrome.storage.sync.set(v), values);
}

async function apiCalls(pathPrefix) {
  return server.requests.filter((r) => r.host === IG_HOST && r.path.startsWith(pathPrefix)).length;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test('extension loads: service worker, menu item, content script', async () => {
  const w = await worker();
  const manifest = await w.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.name, 'Just download it');
  const page = await openPage(`${IG}/`);
  const r = await realm(page);
  const loaded = await r.evaluate(() => ({
    core: !!globalThis.JDI.core,
    handlers: globalThis.JDI.handlers.map((h) => h.id).sort(),
  }));
  assert.deepEqual(loaded, { core: true, handlers: ['generic', 'instagram'] });
  await page.close();
});

test('instagram photo under an overlay: picker lists real sizes, Enter saves the original', async () => {
  const page = await openPage(`${IG}/`);
  await justDownloadIt(page, '#photo .media');
  const s = await waitForPicker(page);
  assert.equal(s.error, '');
  assert.equal(s.title, '@some.user');
  assert.equal(s.theme, 'dark', 'follows the page (black background)');
  assert.ok(s.inTopLayer, 'picker is a top-layer popover');
  // The picker takes each site's own menu radius (Instagram's popovers are 16px).
  assert.equal(s.radius, '16px', 'Instagram styles applied');
  assert.deepEqual(s.rows[0], { label: 'Original', detail: s.rows[0].detail, best: true, state: '' });
  assert.match(s.rows[0].detail, /^1440 × 1800 · JPG/);
  assert.equal(s.rows.length, 7, 'square crops dropped');
  assert.equal(s.chips.length, 0);
  assert.equal(s.focusedRow, 0, 'best option is focused');

  const calls = await apiCalls('/api/v1/media/');
  const apiRequest = server.requests.filter((r) => r.path.startsWith('/api/v1/media/')).pop();
  assert.equal(apiRequest.headers['x-ig-app-id'], '936619743392459');
  assert.equal(apiRequest.headers['x-requested-with'], 'XMLHttpRequest');
  assert.ok(apiRequest.headers.cookie === undefined || typeof apiRequest.headers.cookie === 'string');

  await page.keyboard.press('Enter');
  const [item] = await newDownloads(1);
  assert.equal(item.state, 'complete');
  assert.equal(relative(item), `Just Download It/Instagram/some.user_2026-09-15_${CODES.photo}.jpg`);
  assert.ok(readFileSync(item.filename).equals(mediaFile('photo.jpg')));

  await waitFor(async () => !(await pickerState(page)).open, { message: 'picker to close' });
  const toast = await waitFor(async () => (await pickerState(page)).toasts.find((t) => t.kind === 'success'), {
    message: 'success toast',
  });
  assert.match(toast.text, /Saved/);

  // Same post again: served from cache, no second API call.
  await justDownloadIt(page, '#photo .media');
  await waitForPicker(page);
  assert.equal(await apiCalls('/api/v1/media/'), calls);
  await page.keyboard.press('Escape');
  await waitFor(async () => !(await pickerState(page)).open, { message: 'Escape to close the picker' });
  assert.deepEqual(page.jdiErrors, []);
  await page.close();
});

test('carousel: focuses the visible slide and downloads all slides (video slide combined)', async () => {
  const page = await openPage(`${IG}/`);
  await justDownloadIt(page, '#carousel .viewport');
  const s = await waitForPicker(page);
  assert.equal(s.chips.length, 4);
  assert.deepEqual(s.chips, [false, false, false, true], 'the 4th slide is the one on screen');
  assert.equal(s.title, '@jack.example · Photo 4 of 4');
  assert.match(s.rows[0].detail, /^3273 × 4096/);
  assert.equal(s.all, 'Download all 4 · best quality');

  await clickInPicker(page, '.all');
  const items = await newDownloads(4, 40000);
  const names = items.map(relative).sort();
  const base = `Just Download It/Instagram/jack.example_2026-09-13_${CODES.carousel}`;
  assert.deepEqual(names, [`${base}_01.jpg`, `${base}_02.mp4`, `${base}_03.jpg`, `${base}_04.jpg`]);
  assert.ok(items.every((d) => d.state === 'complete'), JSON.stringify(items.map((d) => [d.state, d.error])));
  const byName = Object.fromEntries(items.map((d) => [relative(d), d.filename]));
  assert.ok(readFileSync(byName[`${base}_04.jpg`]).equals(mediaFile('slide2.jpg')));
  const probe = await probeMp4(byName[`${base}_02.mp4`]);
  assert.equal(probe.video.codec, 'vp9');
  assert.equal(probe.video.height, 1920);
  assert.equal(probe.audio.codec, 'aac');
  await page.close();
});

test('reel: 1080p video and its sound are combined on this computer into one MP4', async () => {
  const page = await openPage(`${IG}/`);
  await justDownloadIt(page, '#reel .media');
  const s = await waitForPicker(page);
  assert.equal(s.title, '@reel_maker');
  assert.deepEqual(
    s.rows.map((r) => r.label),
    ['1080p MP4', '720p MP4', 'Audio only', 'Cover image'],
  );
  assert.match(s.rows[0].detail, /^1080 × 1920 · VP9 · with sound/);
  assert.deepEqual(s.sections, ['Other']);

  await clickInPicker(page, '.row', 0);
  const [item] = await newDownloads(1, 30000);
  assert.equal(item.state, 'complete', item.error);
  assert.equal(relative(item), `Just Download It/Instagram/reel_maker_2026-09-14_${CODES.reel}.mp4`);
  const probe = await probeMp4(item.filename);
  assert.deepEqual(probe.video, { codec: 'vp9', width: 1080, height: 1920 });
  assert.equal(probe.audio.codec, 'aac');
  assert.ok(probe.duration > 1.8 && probe.duration < 2.3, `duration ${probe.duration}`);

  // The offscreen document is closed again once nothing needs it.
  const w = await worker();
  await waitFor(
    async () => (await w.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length === 0,
    { message: 'offscreen document to close' },
  );
  await page.close();
});

test('reel: audio only and the plain 720p MP4 download as-is', async () => {
  const page = await openPage(`${IG}/`);
  await justDownloadIt(page, '#reel .media');
  await waitForPicker(page);
  await clickInPicker(page, '.row', 2);
  const [audio] = await newDownloads(1, 20000);
  assert.equal(audio.state, 'complete', audio.error);
  assert.equal(relative(audio), `Just Download It/Instagram/reel_maker_2026-09-14_${CODES.reel}_audio.m4a`);
  assert.match(audio.mime, /^audio\//, 'saved as audio, so Chrome keeps the .m4a name');
  const probe = await probeMp4(audio.filename);
  assert.equal(probe.video, null);
  assert.equal(probe.audio.codec, 'aac');

  await justDownloadIt(page, '#reel .media');
  await waitForPicker(page);
  await clickInPicker(page, '.row', 1);
  const [mp4] = await newDownloads(1);
  assert.equal(relative(mp4), `Just Download It/Instagram/reel_maker_2026-09-14_${CODES.reel}_720p.mp4`);
  assert.ok(readFileSync(mp4.filename).equals(mediaFile('progressive-720.mp4')));
  await page.close();
});

test('rate limited: falls back to the page version, then pauses API calls', async () => {
  const page = await openPage(`${IG}/`);
  await justDownloadIt(page, '#ratelimited .media');
  const s = await waitForPicker(page);
  assert.match(s.notice, /limiting requests/);
  assert.equal(s.rows[0].label, 'As shown on the page (may be smaller)');

  const before = await apiCalls('/api/v1/media/');
  await page.keyboard.press('Escape');
  await justDownloadIt(page, '#photo .media');
  const paused = await waitForPicker(page);
  assert.match(paused.notice, /asked for a break/);
  assert.equal(await apiCalls('/api/v1/media/'), before, 'no request while paused');

  const r = await realm(page);
  await r.evaluate(() => chrome.storage.local.remove('instagramPausedUntil'));
  await page.close();
});

test('profile picture: finds the account and offers the HD versions', async () => {
  const page = await openPage(`${IG}/`);
  await justDownloadIt(page, '#avatar');
  const s = await waitForPicker(page);
  assert.equal(s.title, '@some.user');
  assert.deepEqual(
    s.rows.map((r) => r.label),
    ['Largest', '640 × 640', '320 × 320'],
  );
  assert.equal(await apiCalls('/web/search/topsearch/'), 1);
  await clickInPicker(page, '.row', 0);
  const [item] = await newDownloads(1);
  assert.equal(relative(item), 'Just Download It/Instagram/some.user_profile-picture.jpg');
  await page.close();
});

test('profile picture without a link around it (current feed markup, non-English alt text)', async () => {
  const page = await openPage(`${IG}/`);
  await justDownloadIt(page, '#avatar-nolink');
  const s = await waitForPicker(page);
  assert.equal(s.title, '@some.user');
  assert.equal(s.rows[0].label, 'Largest');
  await page.keyboard.press('Escape');
  await page.close();
});

test('post page (no <article>): shortcode comes from the address bar', async () => {
  const page = await openPage(`${IG}/p/${CODES.photo}/`);
  await justDownloadIt(page, '#post .media');
  const s = await waitForPicker(page);
  assert.equal(s.title, '@some.user');
  assert.equal(s.rows[0].label, 'Original');
  await page.keyboard.press('Escape');
  await page.close();
});

test('settings: skip the picker, custom folder, no site subfolder', async () => {
  await setSettings({ skipPicker: true, folder: 'My Saves', perSiteFolders: false });
  try {
    const page = await openPage(`${IG}/`);
    await justDownloadIt(page, '#photo .media');
    const [item] = await newDownloads(1);
    assert.equal(relative(item), `My Saves/some.user_2026-09-15_${CODES.photo}.jpg`);
    assert.equal((await pickerState(page)).open, false);
    await page.close();
  } finally {
    await setSettings({ skipPicker: false, folder: 'Just Download It', perSiteFolders: true });
  }
});

test('generic site: <picture> sources sorted largest first', async () => {
  const page = await openPage(`${GENERIC}/`);
  // No page background colour, so the picker follows the OS theme.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await justDownloadIt(page, '#picture img');
  const s = await waitForPicker(page);
  assert.equal(s.title, 'generic.test');
  assert.equal(s.theme, 'light');
  // At this window width Chrome shows the 1600w source, so the largest is also what's shown.
  assert.deepEqual(
    s.rows.map((r) => r.label),
    ['Largest', '1200px wide', '400px wide'],
  );
  assert.match(s.rows[0].detail, /^1600 × 1200 · JPG/);
  await page.keyboard.press('Enter');
  const [item] = await newDownloads(1);
  assert.equal(relative(item), 'Just Download It/generic.test/pic-1600.jpg');
  assert.ok(readFileSync(item.filename).equals(mediaFile('pic-1600.jpg')));
  await page.close();
});

test('generic site: image behind a transparent shield links to its full size', async () => {
  const page = await openPage(`${GENERIC}/`);
  await justDownloadIt(page, '#covered .cover');
  const s = await waitForPicker(page);
  assert.equal(s.rows[0].label, 'Full size (linked)');
  await page.keyboard.press('Escape');
  await page.close();
});

test('generic site: direct video file and poster', async () => {
  const page = await openPage(`${GENERIC}/`);
  await justDownloadIt(page, '#direct');
  const s = await waitForPicker(page);
  assert.equal(s.rows[0].label, 'Video');
  // A plain MP4 also offers its sound as an MP3 (core.js withMp3Option).
  assert.equal(s.rows[1].label, 'MP3');
  assert.equal(s.rows[2].label, 'Poster image');
  await clickInPicker(page, '.row', 0);
  const [item] = await newDownloads(1);
  assert.equal(relative(item), 'Just Download It/generic.test/clip.mp4');
  await page.close();
});

test('generic site: streamed (blob:) video explains itself', async () => {
  const page = await openPage(`${GENERIC}/`);
  await justDownloadIt(page, '#blob');
  const s = await waitFor(async () => {
    const st = await pickerState(page);
    return st.error ? st : null;
  }, { message: 'error state' });
  assert.match(s.error, /streams in small pieces/);
  await page.close();
});

test('generic site: nothing under the cursor offers the page preview image', async () => {
  const page = await openPage(`${GENERIC}/`);
  await justDownloadIt(page, '#text p');
  const s = await waitForPicker(page);
  assert.match(s.notice, /Nothing downloadable right under your cursor/);
  assert.equal(s.rows[0].label, 'Page preview image');
  await page.keyboard.press('Escape');
  await page.close();
});

test('strict page CSP: picker is still styled', async () => {
  const page = await openPage(`${GENERIC}/strict-csp`);
  await justDownloadIt(page, '#pic');
  const s = await waitForPicker(page);
  assert.equal(s.radius, '12px');
  assert.equal(s.rows[0].label, 'As shown on the page');
  await page.keyboard.press('Escape');
  await page.close();
});

test('story: item pk from the address bar, named after the story', async () => {
  const page = await openPage(`${IG}/stories/some.user/${PKS.story}/`);
  await justDownloadIt(page, '#story');
  const s = await waitForPicker(page);
  assert.equal(s.title, '@some.user');
  assert.equal(s.rows[0].label, 'Original');
  await page.keyboard.press('Enter');
  const [item] = await newDownloads(1);
  assert.equal(relative(item), `Just Download It/Instagram/some.user_2026-09-16_story_${PKS.story}.jpg`);
  await page.close();
});

test('highlight: the item on screen is found by its image, all items offered', async () => {
  const page = await openPage(`${IG}/stories/highlights/${HIGHLIGHT_ID}/`);
  await justDownloadIt(page, '#story');
  const s = await waitForPicker(page);
  assert.equal(s.title, '@some.user · highlight · Photo 2 of 2');
  assert.deepEqual(s.chips, [false, true]);
  assert.equal(s.all, 'Download all 2 · best quality');
  await page.keyboard.press('Escape');
  await page.close();
});

test('extension reload: open tabs keep working without a page refresh', async () => {
  const page = await openPage(`${IG}/`);
  await realm(page);
  const oldWorker = await worker();
  const oldTarget = currentSwTarget;
  await oldWorker.evaluate(() => {
    setTimeout(() => chrome.runtime.reload(), 50);
  });
  const fresh = await nextWorker(oldTarget);
  await waitFor(async () => withTimeout(fresh.evaluate(() => !!globalThis.JDI && !!globalThis.JDI.background), 3000), {
    message: 'new worker ready',
  });

  // onInstalled re-injects content scripts; the new copy must answer.
  await waitFor(
    async () => {
      for (const r of page.mainFrame().extensionRealms()) {
        const ok = await r.evaluate(() => typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id).catch(() => false);
        if (ok) return true;
      }
      return false;
    },
    { message: 'a live content script after reload' },
  );
  await justDownloadIt(page, '#photo .media');
  const s = await waitFor(async () => {
    for (const r of page.mainFrame().extensionRealms()) {
      const state = await r
        .evaluate(() => {
          const host = document.querySelector('jdi-root');
          if (!host) return null;
          const shadow = chrome.dom.openOrClosedShadowRoot(host);
          const panel = shadow && shadow.querySelector('.panel');
          const title = panel && panel.querySelector('.title');
          return title && !panel.querySelector('.state .spinner') ? title.textContent : null;
        })
        .catch(() => null);
      if (state) return state;
    }
    return null;
  }, { message: 'picker after reload' });
  assert.equal(s, '@some.user');
  await page.close();
});

// ----------------------------------------------------------------------------
// Page buttons, YouTube, fullscreen
// ----------------------------------------------------------------------------

const YT = `https://${YT_HOST}:${PORT}`;

async function youtubeButton(page) {
  return waitFor(
    () =>
      page.evaluate(() => {
        const row = document.querySelector('ytd-watch-metadata #top-level-buttons-computed');
        const button = row && row.querySelector(':scope > jdi-button');
        if (!button) return null;
        const r = button.getBoundingClientRect();
        const like = row.querySelector('segmented-like-dislike-button-view-model');
        return {
          next: button.nextElementSibling ? button.nextElementSibling.tagName.toLowerCase() : null,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          width: r.width,
          sameRow: like ? Math.abs(like.getBoundingClientRect().top + like.getBoundingClientRect().height / 2 - (r.top + r.height / 2)) < 3 : false,
          theme: button.getAttribute('data-theme'),
          count: document.querySelectorAll('jdi-button').length,
        };
      }),
    { message: 'the YouTube Download button' },
  );
}

async function clickYouTubeButton(page) {
  const b = await youtubeButton(page);
  await page.mouse.click(b.x, b.y);
  return b;
}

function playerRequests() {
  return server.requests.filter((r) => r.path === '/youtubei/v1/player#body');
}

test('youtube: Download button sits just left of Like and opens the quality picker', async () => {
  const page = await openPage(`${YT}/watch?v=dQw4w9WgXcQ`);
  await realm(page);
  const b = await youtubeButton(page);
  assert.equal(b.next, 'segmented-like-dislike-button-view-model');
  assert.ok(b.sameRow, 'lined up with Like');
  assert.ok(b.width > 60);
  assert.equal(b.theme, 'dark', 'follows YouTube dark mode');
  assert.equal(b.count, 1);

  const before = playerRequests().length;
  await clickYouTubeButton(page);
  const s = await waitForPicker(page);
  assert.equal(s.error, '');
  assert.equal(s.title, 'Never Gonna Give You Up');
  assert.deepEqual(
    s.rows.map((r) => r.label),
    ['2160p', '1440p', '1080p', '720p', '360p', 'MP3', 'M4A', 'Thumbnail'],
  );
  assert.deepEqual(s.sections, ['Audio only', 'Other']);
  assert.match(s.rows[2].detail, /^1920 × 1080 · H\.264 · MP4/);
  const buttonTop = b.y - 18;
  const buttonBottom = b.y + 18;
  assert.ok(s.panelRect.top >= buttonBottom || s.panelRect.bottom <= buttonTop, `opens next to the button without covering it: button y=${b.y}, panel ${JSON.stringify(s.panelRect)}`);

  const request = playerRequests()[before];
  assert.equal(request.body.videoId, 'dQw4w9WgXcQ');
  assert.equal(request.body.context.client.clientName, 'VISIONOS');
  assert.equal(request.headers['x-goog-visitor-id'], 'CgtUZXN0VmlzaXRvchIEGgAgKw%3D%3D');
  assert.equal(request.headers.cookie, undefined, 'no cookies sent');

  // Clicking the button again closes the picker instead of reopening it.
  await clickYouTubeButton(page);
  await waitFor(async () => !(await pickerState(page)).open, { message: 'picker to close on second click' });
  await page.close();
});

test('youtube: 1080p combines H.264 video with AAC audio, with progress', async () => {
  const page = await openPage(`${YT}/watch?v=dQw4w9WgXcQ`);
  await realm(page);
  await clickYouTubeButton(page);
  await waitForPicker(page);
  await clickInPicker(page, '.row', 2);
  const seen = new Set();
  const [item] = await waitFor(
    async () => {
      for (const t of (await pickerState(page)).toasts) seen.add(t.text);
      const w = await worker();
      const all = await w.evaluate(() => chrome.downloads.search({ orderBy: ['startTime'] }));
      const fresh = all.filter((d) => d.id > lastDownloadId && d.state !== 'in_progress');
      return fresh.length ? fresh : null;
    },
    { timeout: 30000, message: 'the 1080p download' },
  );
  lastDownloadId = item.id;
  assert.equal(item.state, 'complete', item.error);
  assert.equal(relative(item), 'Just Download It/YouTube/Never Gonna Give You Up [dQw4w9WgXcQ] 1080p.mp4');
  const probe = await probeMp4(item.filename);
  assert.equal(probe.video.codec, 'avc');
  assert.equal(probe.audio.codec, 'aac');
  assert.ok(probe.duration > 2.8 && probe.duration < 3.3, `duration ${probe.duration}`);
  assert.ok([...seen].some((t) => /^Preparing your file/.test(t)), `progress toast shown: ${[...seen].join(' / ')}`);
  await page.close();
});

test('youtube: 2160p copies VP9 from WebM into MP4; MP3 is encoded on this computer', async () => {
  const page = await openPage(`${YT}/watch?v=dQw4w9WgXcQ`);
  await realm(page);
  await clickYouTubeButton(page);
  await waitForPicker(page);
  await clickInPicker(page, '.row', 0);
  const [uhd] = await newDownloads(1, 30000);
  assert.equal(uhd.state, 'complete', uhd.error);
  const uhdProbe = await probeMp4(uhd.filename);
  assert.equal(uhdProbe.video.codec, 'vp9');
  assert.equal(uhdProbe.audio.codec, 'aac');

  await clickYouTubeButton(page);
  await waitForPicker(page);
  await clickInPicker(page, '.row', 5); // MP3
  const [mp3] = await newDownloads(1, 30000);
  assert.equal(mp3.state, 'complete', mp3.error);
  assert.equal(relative(mp3), 'Just Download It/YouTube/Never Gonna Give You Up [dQw4w9WgXcQ].mp3');
  const mp3Probe = await probeMp4(mp3.filename);
  assert.equal(mp3Probe.audio.codec, 'mp3');
  assert.equal(mp3Probe.video, null);
  await page.close();
});

test('youtube: in-page navigation re-adds the button for the new video', async () => {
  const page = await openPage(`${YT}/watch?v=dQw4w9WgXcQ`);
  await realm(page);
  await youtubeButton(page);
  await page.evaluate(() => window.spaNavigate('jNQXAC9IVRw', 'Me at the zoo'));
  const b = await waitFor(async () => {
    const info = await youtubeButton(page);
    return info.next === 'segmented-like-dislike-button-view-model' ? info : null;
  }, { message: 'button in the re-rendered row' });
  assert.equal(b.count, 1, 'no duplicate buttons');
  await clickYouTubeButton(page);
  const s = await waitForPicker(page);
  assert.equal(s.title, 'Me at the zoo');
  await page.keyboard.press('Escape');
  await page.close();
});

test('youtube: right-click a video thumbnail link', async () => {
  const page = await openPage(`${YT}/watch?v=dQw4w9WgXcQ`);
  await justDownloadIt(page, '#thumbnail img');
  const s = await waitForPicker(page);
  assert.equal(s.title, 'Me at the zoo');
  assert.equal(s.rows[0].label, '2160p');
  await page.keyboard.press('Escape');
  await page.close();
});

test('settings: turning page buttons off removes them right away', async () => {
  const page = await openPage(`${YT}/watch?v=dQw4w9WgXcQ`);
  await realm(page);
  await youtubeButton(page);
  await setSettings({ pageButtons: false });
  try {
    await waitFor(async () => (await page.evaluate(() => document.querySelectorAll('jdi-button').length)) === 0, {
      message: 'buttons to disappear',
    });
  } finally {
    await setSettings({ pageButtons: true });
  }
  await youtubeButton(page);
  await page.close();
});

test('instagram: download icon after Share opens the picker for that post', async () => {
  const page = await openPage(`${IG}/`);
  await realm(page);
  const info = await waitFor(
    () =>
      page.evaluate(() => {
        const row = document.querySelector('#carousel section');
        const button = row && row.querySelector('jdi-button');
        if (!button) return null;
        button.scrollIntoView({ block: 'center' });
        const share = row.querySelector('svg[aria-label="Share"]').closest('[role="button"]');
        const r = button.getBoundingClientRect();
        return {
          afterShare: button.previousElementSibling === share,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          size: [Math.round(r.width), Math.round(r.height)],
          buttons: document.querySelectorAll('jdi-button').length,
        };
      }),
    { message: 'the Instagram download icon' },
  );
  assert.ok(info.afterShare, 'placed right after Share');
  assert.deepEqual(info.size, [40, 40]);
  assert.equal(info.buttons, 2, 'one per action row');

  const again = await page.evaluate(() => {
    const r = document.querySelector('#carousel section jdi-button').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(again.x, again.y);
  const s = await waitForPicker(page);
  assert.equal(s.title, '@jack.example · Photo 4 of 4', 'focuses the slide on screen');
  assert.equal(s.all, 'Download all 4 · best quality');
  await page.keyboard.press('Escape');
  await page.close();
});

test('instagram: right-click inside a post pop-up ignores the feed behind it', async () => {
  const page = await openPage(`${IG}/p/${CODES.photo}/?modal=1`);
  await justDownloadIt(page, '#modal-caption');
  const s = await waitForPicker(page);
  assert.equal(s.title, '@some.user');
  assert.match(s.rows[0].detail, /^1440 × 1800/);
  await page.keyboard.press('Escape');
  await page.close();
});

test('fullscreen: the picker still takes clicks', async () => {
  const page = await openPage(`${GENERIC}/`);
  const button = await center(page, '#go-fs');
  await page.mouse.click(button.x, button.y);
  await waitFor(() => page.evaluate(() => !!document.fullscreenElement), { message: 'fullscreen' });
  await justDownloadIt(page, '#fs-img');
  const s = await waitForPicker(page);
  assert.equal(s.tag, 'dialog');
  assert.ok(s.modal, 'shown as a modal dialog so it is not inert');
  await page.mouse.click(s.firstRowCenter.x, s.firstRowCenter.y);
  const [item] = await newDownloads(1);
  assert.equal(item.state, 'complete');
  await page.evaluate(() => document.exitFullscreen());
  await page.close();
});

test('options page saves settings', async () => {
  const page = await openPage(`chrome-extension://${EXTENSION_ID}/options/options.html`);
  await page.click('#saveAs');
  await waitFor(async () => (await page.$eval('#status', (n) => n.textContent)) === 'Saved', { message: 'Saved status' });
  const w = await worker();
  assert.equal((await w.evaluate(() => chrome.storage.sync.get('saveAs'))).saveAs, true);
  await page.click('#saveAs');
  await waitFor(async () => (await w.evaluate(() => chrome.storage.sync.get('saveAs'))).saveAs === false, { message: 'saveAs reset' });
  // The settings page shows a live example path for each kind of download.
  assert.match(await page.$eval('#downloadExample', (n) => n.textContent), /^Downloads\/Just Download It\/Instagram\//);
  assert.match(await page.$eval('#albumExample', (n) => n.textContent), /Just Download It\/Spotify\/After Hours\/01 - The Weeknd - Alone Again\.mp3$/);
  await page.close();
});

test('website: a link typed after its address opens in the popup, looked up', async () => {
  const link = `${GENERIC}/media/clip.mp4`;
  // "justdownloadit.peterwild.pw/<link>" has no page: 404.html sends it to the Paste a link page.
  const page = await openPage(`${SITE}/${link}`);
  await waitFor(() => page.url().startsWith(`${SITE}/download.html?url=`), { message: 'the redirect to download.html' });
  await page.waitForSelector('[data-state="extension"]:not([hidden])', { timeout: 5000 });
  assert.equal(await page.$eval('#link', (n) => n.value), link);
  assert.equal(await page.$eval('html', (n) => n.dataset.jdiExtension), (await (await worker()).evaluate(() => chrome.runtime.getManifest().version)));
  // Not one of the known sites, so it waits for a click rather than opening by itself.
  assert.match(await page.$eval('[data-ext-title]', (n) => n.textContent), /generic\.test/);
  const popupTarget = browser.waitForTarget((t) => t.url().includes(`${EXTENSION_ID}/popup/popup.html`), { timeout: 10000 });
  await page.click('[data-open-ext]');
  const popup = await (await popupTarget).asPage();
  await waitFor(() => popup.evaluate(() => document.getElementById('link').value), { message: 'the link in the popup' });
  assert.equal(await popup.evaluate(() => document.getElementById('link').value), link);
  await waitFor(() => popup.evaluate(() => document.querySelectorAll('#result .row').length > 0), { message: 'the popup to list what can be saved' });
  await waitFor(async () => /open in Just download it/i.test(await page.$eval('[data-ext-title]', (n) => n.textContent)), { message: 'the page to confirm' });
  // In a window of its own there's no current tab to save as a PNG or GIF.
  if (popup.url().includes('window=1')) assert.equal(await popup.evaluate(() => document.querySelector('.capture').hidden), true);
  await popup.close().catch(() => {});
  // The shortcut address itself is answered with 404.html and a 404 status, which Chrome logs.
  assert.deepEqual(page.jdiErrors.filter((e) => !/status of 404/.test(e)), []);
  await page.close();
});

test('website: other sites cannot ask the extension to open links', async () => {
  const page = await openPage(`${GENERIC}/`);
  const opened = await page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('message', (e) => e.data && e.data.jdi === 'open-link-result' && resolve(true));
    window.postMessage({ jdi: 'open-link', url: 'https://generic.test/media/clip.mp4' }, '/');
    setTimeout(() => resolve(false), 1500);
  }));
  assert.equal(opened, false);
  assert.equal(await page.$eval('html', (n) => n.dataset.jdiExtension || ''), '');
  await page.close();
});

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  const started = Date.now();
  try {
    await t.fn();
    console.log(`  ✔ ${t.name} (${Date.now() - started} ms)`);
  } catch (err) {
    failed++;
    console.log(`  ✖ ${t.name}\n    ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 8).join('\n    ')}`);
  }
}

await browser.close();
await server.close();
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (!existsSync(DOWNLOADS)) console.log('(no downloads folder was created)');
process.exit(failed ? 1 : 0);
