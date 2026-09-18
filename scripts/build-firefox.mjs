// Builds the Firefox version into dist/firefox/: a copy of extension/ with a
// Firefox manifest. extension/ stays the only source (Chrome loads it as is);
// differences at runtime are feature checks in the code itself.
// Run: npm run build:firefox
//
// What the Firefox manifest changes:
//   background   Firefox MV3 has event pages, not service workers: the same
//                module runs as a background script (with a DOM, so the job
//                runner that Chrome keeps in an offscreen document runs in it)
//   permissions  no "offscreen" or "tabCapture" (Firefox has neither)
//   gecko        the add-on id and the oldest Firefox (and Firefox for Android) it supports
//   minimum_chrome_version is dropped; everything else (content scripts,
//   including the MAIN world one, host permissions, CSP) is the same.
//
// Load it in Firefox from about:debugging → This Firefox → Load Temporary
// Add-on… → dist/firefox/manifest.json, or run: npx web-ext run -s dist/firefox
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const out = join(root, 'dist', 'firefox');

export const GECKO_ID = 'just-download-it@peterwild.pw';
// 140 is the current ESR. Older versions lack parts the extension needs
// (WebCodecs audio decoding for MP3s, MAIN-world content scripts, data_collection_permissions).
export const MIN_FIREFOX = '140.0';
// Firefox for Android only knows data_collection_permissions from 142.
const MIN_FIREFOX_ANDROID = '142.0';
const CHROME_ONLY_PERMISSIONS = ['offscreen', 'tabCapture'];
// Chrome's offscreen document; in Firefox the job runner is imported into the event page.
const CHROME_ONLY_FILES = ['offscreen/offscreen.html'];

/** The Firefox manifest for a Chrome manifest. */
export function firefoxManifest(chrome) {
  const manifest = structuredClone(chrome);
  delete manifest.minimum_chrome_version;
  const worker = manifest.background && manifest.background.service_worker;
  if (!worker) throw new Error('manifest.json has no background.service_worker');
  manifest.background = { scripts: [worker], type: 'module' };
  manifest.permissions = (manifest.permissions || []).filter((p) => !CHROME_ONLY_PERMISSIONS.includes(p));
  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: MIN_FIREFOX,
      // Nothing leaves the computer except the requests to the sites themselves.
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: MIN_FIREFOX_ANDROID },
  };
  return manifest;
}

export function buildFirefox() {
  const manifest = firefoxManifest(JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const skip = new Set(['manifest.json', ...CHROME_ONLY_FILES].map((f) => join(source, f)));
  cpSync(source, out, { recursive: true, filter: (src) => !skip.has(src) });
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, manifest };
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const { out: dir, manifest } = buildFirefox();
  console.log(`Firefox build ${manifest.version} → ${dir}`);
}
