// Live check of the website's "Paste a link" page without the extension
// (needs internet). Not part of `npm test`: it talks to the real X (through
// fxtwitter and vxtwitter), Twitch, Apple, YouTube, TikTok and Spotify.
// site/ is served locally the way Cloudflare Pages serves it, links are
// pasted into the page, and the files it saves are checked on disk.
//
//   node test/live/website.mjs
//   HEADFUL=1 node test/live/website.mjs
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(here, '..', '..', 'site');
const DOWNLOADS = join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'jdi-live-web');
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const server = http.createServer((req, res) => {
  const path = normalize(join(SITE, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  for (const candidate of [path, `${path}.html`, join(path, 'index.html')]) {
    if (path.startsWith(SITE + sep) || path === SITE) {
      if (isFile(candidate)) {
        res.writeHead(200, { 'Content-Type': MIME[extname(candidate)] || 'application/octet-stream' });
        return res.end(readFileSync(candidate));
      }
    }
  }
  res.writeHead(404, { 'Content-Type': MIME['.html'] });
  res.end(readFileSync(join(SITE, '404.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}`;

const browser = await puppeteer.launch({ headless: !process.env.HEADFUL, defaultViewport: { width: 1200, height: 900 } });

async function openLink(link, { blockFx = false } = {}) {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  if (blockFx) {
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.url().startsWith('https://api.fxtwitter.com/') ? r.abort() : r.continue()));
  }
  await page.goto(`${BASE}/download.html?url=${encodeURIComponent(link)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const web = document.querySelector('[data-state="web"]');
    const ext = document.querySelector('[data-state="no-extension"]');
    return (web && !web.hidden && !document.querySelector('.web-state')) || (ext && !ext.hidden && web.hidden);
  }, { timeout: 20000 });
  return page;
}

const summary = (page) =>
  page.evaluate(() => ({
    title: (document.querySelector('.web-title') || {}).textContent || '',
    rows: Array.from(document.querySelectorAll('.web-row .label')).map((n) => n.textContent),
    error: (document.querySelector('[data-web-results] .tool-error') || {}).textContent || '',
    needs: document.querySelector('[data-state="no-extension"]').hidden ? '' : document.querySelector('[data-noext-title]').textContent,
  }));

/** Click a row and wait for it to finish; returns the file it saved. */
async function download(page, index, pattern) {
  const before = new Set(readdirSync(DOWNLOADS));
  const rows = await page.$$('.web-row');
  await rows[index].click();
  await page.waitForFunction((i) => ['done', 'failed'].includes(document.querySelectorAll('.web-row')[i].dataset.state), { timeout: 60000 }, index);
  const state = await page.evaluate((i) => [document.querySelectorAll('.web-row')[i].dataset.state, document.querySelectorAll('.web-row')[i].querySelector('.detail').textContent], index);
  assert.equal(state[0], 'done', state[1]);
  let file = '';
  for (let t = 0; t < 50 && !file; t++) {
    file = readdirSync(DOWNLOADS).find((f) => !before.has(f) && !f.endsWith('.crdownload')) || '';
    if (!file) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(file, 'a file was saved');
  assert.match(file, pattern);
  const bytes = readFileSync(join(DOWNLOADS, file));
  return { file, bytes };
}

const checks = [
  ['X video: every quality, downloads an MP4', async () => {
    const page = await openLink('https://x.com/NASA_SLS/status/1545165837509738496');
    const s = await summary(page);
    assert.equal(s.needs, '');
    assert.ok(s.rows.includes('720p MP4') && s.rows.includes('Thumbnail'), JSON.stringify(s));
    const { file, bytes } = await download(page, s.rows.length - 2, /^NASA_SLS_\d{4}-\d{2}-\d{2}_1545165837509738496_\d+p\.mp4$/);
    assert.equal(bytes.subarray(4, 8).toString('latin1'), 'ftyp', `${file} is an MP4`);
    await page.close();
  }],
  ['X photo: original size', async () => {
    const page = await openLink('https://x.com/NASA/status/2052096368219447591');
    const s = await summary(page);
    assert.deepEqual(s.rows, ['Original', 'Large', 'Medium']);
    const { bytes } = await download(page, 2, /_medium\.jpg$/);
    assert.equal(bytes[0], 0xff);
    await page.close();
  }],
  ['X: says so plainly when it can’t reach the post data', async () => {
    const page = await openLink('https://twitter.com/NASA_SLS/status/1545165837509738496', { blockFx: true });
    const s = await summary(page);
    assert.match(s.error, /Couldn’t reach X/);
    await page.close();
  }],
  ['Twitch clip: every quality, downloads an MP4', async () => {
    const page = await openLink('https://clips.twitch.tv/CrispyJollyGullHassaanChop-nPlLKGxGRcBj37e4');
    const s = await summary(page);
    assert.ok(s.rows.length >= 3 && /^\d+p/.test(s.rows[0]), JSON.stringify(s));
    const smallest = s.rows.findLastIndex((r) => /^\d+p/.test(r));
    const { bytes } = await download(page, smallest, /\.mp4$/);
    assert.equal(bytes.subarray(4, 8).toString('latin1'), 'ftyp');
    await page.close();
  }],
  ['Apple Music song: cover art and preview; the full song needs the extension', async () => {
    const page = await openLink('https://music.apple.com/us/album/blinding-lights-remix-single/1542842760?i=1542842761');
    const s = await summary(page);
    assert.ok(s.rows.includes('30-second preview') && s.rows.includes('Full size'), JSON.stringify(s));
    assert.match(s.needs, /full song/);
    const { bytes } = await download(page, s.rows.indexOf('30-second preview'), /\(preview\)\.m4a$/);
    assert.ok(bytes.length > 100000);
    await page.close();
  }],
  ['YouTube: thumbnail here, the video needs the extension', async () => {
    const page = await openLink('https://youtu.be/rhZnmCfau4Q');
    const s = await summary(page);
    assert.match(s.title, /just download it/i);
    assert.equal(s.rows[0], 'Thumbnail, HD');
    assert.match(s.needs, /the video/);
    const { bytes } = await download(page, 0, /\[rhZnmCfau4Q\] thumbnail\.jpg$/);
    assert.equal(bytes[0], 0xff);
    await page.close();
  }],
  ['TikTok: cover here, the video needs the extension', async () => {
    const page = await openLink('https://www.tiktok.com/@scout2015/video/6718335390845095173');
    const s = await summary(page);
    assert.deepEqual(s.rows, ['Cover image']);
    assert.match(s.needs, /the video/);
    await page.close();
  }],
  ['Spotify: cover art here, the song needs the extension', async () => {
    const page = await openLink('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b');
    const s = await summary(page);
    assert.equal(s.rows[0], 'Cover art, full size');
    assert.match(s.needs, /the song/);
    const { bytes } = await download(page, 0, /\(cover\)\.jpg$/);
    assert.equal(bytes[0], 0xff);
    await page.close();
  }],
  ['Instagram: the extension card only', async () => {
    const page = await openLink('https://www.instagram.com/p/C0abcdefghi/');
    const s = await summary(page);
    assert.deepEqual(s.rows, []);
    assert.match(s.needs, /needs the free extension/);
    await page.close();
  }],
];

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✖ ${name}\n    ${String(err && err.message).split('\n').slice(0, 6).join('\n    ')}`);
  }
}
await browser.close();
server.close();
console.log(`\n${checks.length - failed} passed, ${failed} failed (files in ${DOWNLOADS})`);
process.exit(failed ? 1 : 0);
