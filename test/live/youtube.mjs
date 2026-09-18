// Live check against the real youtube.com (needs internet). Not part of
// `npm test`: YouTube changes often, and this proves the real thing works.
//
//   node test/live/youtube.mjs [videoId]     (default: "Me at the zoo", 19 s)
//   node test/live/youtube.mjs dQw4w9WgXcQ 1080p
//   HEADFUL=1 node test/live/youtube.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import puppeteer from 'puppeteer';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const VIDEO = process.argv[2] || 'jNQXAC9IVRw';
const QUALITY = process.argv[3] || ''; // e.g. 1080p; default: the smallest MP4
const WORK = join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'jdi-live-youtube');
const PROFILE = join(WORK, 'profile');
const DOWNLOADS = join(WORK, 'downloads');

rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(PROFILE, 'Default'), { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });
writeFileSync(
  join(PROFILE, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: DOWNLOADS, prompt_for_download: false, directory_upgrade: true } }),
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 20000, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${message}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  pipe: true,
  enableExtensions: [join(root, 'extension')],
  userDataDir: PROFILE,
  defaultViewport: { width: 1400, height: 1000 },
  args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=user-gesture-required', '--mute-audio'],
});

let failed = false;
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background/service-worker.js'));
  const extensionId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  await waitFor(() => sw.evaluate(() => !!(globalThis.chrome && chrome.downloads)), { message: 'service worker' });

  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || /Just download it/.test(m.text())) console.log('  [page]', m.type(), m.text().slice(0, 300));
  });
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded' });

  // Consent screens (EU) would block the page; bail out clearly if we hit one.
  if (/consent\./.test(page.url())) throw new Error(`Landed on a consent page: ${page.url()}`);

  const realm = await waitFor(async () => {
    for (const r of page.mainFrame().extensionRealms()) {
      const ext = await r.extension();
      if (ext && ext.id === extensionId) return r;
    }
    return null;
  }, { message: 'content script' });

  // 1. The button sits just left of the Like button.
  const placement = await waitFor(
    () =>
      page.evaluate(() => {
        const row = document.querySelector('ytd-watch-metadata #top-level-buttons-computed');
        const button = row && row.querySelector(':scope > jdi-button');
        if (!button) return null;
        const next = button.nextElementSibling;
        const r = button.getBoundingClientRect();
        const n = next ? next.getBoundingClientRect() : null;
        return { next: next ? next.tagName.toLowerCase() : null, width: r.width, height: r.height, gap: n ? Math.round(n.left - r.right) : null, sameRow: n ? Math.abs(n.top - r.top) < 6 : null };
      }),
    { timeout: 30000, message: 'the Download button next to Like' },
  );
  console.log('button placement', placement);
  assert.match(placement.next, /like/);
  assert.ok(placement.width > 60 && placement.height >= 32, 'button is visible');
  assert.ok(placement.sameRow, 'same row as Like');

  const shot = join(WORK, 'button.png');
  const rowBox = await page.evaluate(() => {
    const row = document.querySelector('ytd-watch-metadata #actions');
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 20), width: Math.min(r.width + 40, 1400), height: r.height + 40 };
  });
  await wait(500);
  await page.screenshot({ path: shot, clip: rowBox });
  console.log('screenshot', shot);

  // 2. Click it: the picker lists qualities.
  const clickAt = await page.evaluate(() => {
    const r = document.querySelector('ytd-watch-metadata #top-level-buttons-computed > jdi-button').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(clickAt.x, clickAt.y);

  const state = await waitFor(
    () =>
      realm.evaluate(() => {
        const host = document.querySelector('jdi-root');
        const shadow = host && chrome.dom.openOrClosedShadowRoot(host);
        const panel = shadow && shadow.querySelector('.panel');
        if (!panel || panel.querySelector('.state .spinner')) return null;
        return {
          title: panel.querySelector('.title').textContent,
          error: (panel.querySelector('.state.error') || {}).textContent || '',
          rows: Array.from(panel.querySelectorAll('.row')).map((r) => `${r.querySelector('.label').textContent} | ${r.querySelector('.detail').textContent}`),
          sections: Array.from(panel.querySelectorAll('.section')).map((n) => n.textContent),
        };
      }),
    { timeout: 30000, message: 'picker' },
  );
  console.log('picker', JSON.stringify(state, null, 1));
  assert.equal(state.error, '');
  assert.ok(state.rows.some((r) => r.startsWith('MP3 |')), 'offers MP3');

  await page.screenshot({ path: join(WORK, 'picker.png') });

  async function choose(labelStart) {
    await realm.evaluate((start) => {
      const shadow = chrome.dom.openOrClosedShadowRoot(document.querySelector('jdi-root'));
      const rows = Array.from(shadow.querySelectorAll('.row'));
      const row = rows.find((r) => r.querySelector('.label').textContent.startsWith(start));
      if (!row) throw new Error(`no row ${start}`);
      row.click();
    }, labelStart);
  }

  async function nextDownload(afterId) {
    return waitFor(
      async () => {
        const items = await sw.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'] }));
        const fresh = items.filter((d) => d.id > afterId);
        const done = fresh.find((d) => d.state !== 'in_progress');
        return done || null;
      },
      { timeout: 120000, message: 'download' },
    );
  }

  async function probe(path) {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(readFileSync(path)) });
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    return {
      video: v ? `${await v.getCodec()} ${await v.getDisplayWidth()}x${await v.getDisplayHeight()}` : null,
      audio: a ? String(await a.getCodec()) : null,
      duration: Math.round((await input.computeDuration()) * 10) / 10,
    };
  }

  // 3. Smallest MP4 (keeps the test quick): combined video + audio.
  const videoRows = state.rows.filter((r) => /· MP4/.test(r));
  const smallest = QUALITY || videoRows[videoRows.length - 1].split(' | ')[0];
  const toasts = [];
  const toastWatcher = setInterval(async () => {
    const t = await realm
      .evaluate(() => {
        const host = document.querySelector('jdi-root');
        const shadow = host && chrome.dom.openOrClosedShadowRoot(host);
        return shadow ? Array.from(shadow.querySelectorAll('.toast .msg')).map((n) => n.textContent) : [];
      })
      .catch(() => []);
    for (const text of t) if (!toasts.includes(text)) toasts.push(text);
  }, 150);

  await choose(smallest);
  const mp4 = await nextDownload(0);
  console.log('mp4 download', mp4.state, mp4.error || '', mp4.filename, mp4.fileSize);
  assert.equal(mp4.state, 'complete');
  const mp4Probe = await probe(mp4.filename);
  console.log('mp4 probe', mp4Probe);
  assert.ok(mp4Probe.video && mp4Probe.audio, 'mp4 has video and audio');

  // 4. MP3 (converted on this computer).
  await page.mouse.click(clickAt.x, clickAt.y);
  await waitFor(() => realm.evaluate(() => {
    const shadow = chrome.dom.openOrClosedShadowRoot(document.querySelector('jdi-root'));
    const panel = shadow.querySelector('.panel');
    return panel && panel.querySelectorAll('.row').length > 0;
  }), { message: 'picker again' });
  await choose('MP3');
  const mp3 = await nextDownload(mp4.id);
  console.log('mp3 download', mp3.state, mp3.error || '', mp3.filename, mp3.fileSize);
  assert.equal(mp3.state, 'complete');
  const mp3Probe = await probe(mp3.filename);
  console.log('mp3 probe', mp3Probe);
  assert.equal(mp3Probe.audio, 'mp3');

  clearInterval(toastWatcher);
  console.log('toasts seen', toasts);

  // 5. The offscreen document closes and its temporary files are gone.
  await waitFor(async () => (await sw.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length === 0, {
    timeout: 20000,
    message: 'offscreen document to close',
  });
  console.log('\nLIVE YOUTUBE: PASS');
} catch (err) {
  failed = true;
  console.log('\nLIVE YOUTUBE: FAIL\n', err && err.stack ? err.stack : err);
} finally {
  await browser.close();
  if (existsSync(DOWNLOADS)) console.log('downloads in', DOWNLOADS);
}
process.exit(failed ? 1 : 0);
