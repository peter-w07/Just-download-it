// Builds every image the Chrome Web Store listing needs, at the exact sizes the
// store accepts: five 1280x800 screenshots, a 440x280 small promo tile and a
// 1400x560 marquee, plus a copy of the 128x128 store icon. Run: node store/build.mjs
//
//   in    store/shots/<file>.png    the raw captures (see store/shots/README.md)
//   out   store/assets/*.png        the upload-ready images, plus a README saying
//                                   which store field each one goes in
//         store/placeholders/*.png  stand-in art for any capture not taken yet
//
// Everything a slot needs is in SLOTS below. Taking a capture and dropping it in
// store/shots/ under the name given there is the only change needed: the
// placeholder disappears and the real image is framed in its place.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { marqueeHtml, MARQUEE, SMALL, smallTileHtml } from './templates/promo.js';
import { placeholderHtml } from './templates/placeholder.js';
import { HEIGHT, mediaBox, screenshotHtml, WIDTH } from './templates/screenshot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { default: puppeteer } = await import(
  pathToFileURL(join(root, 'node_modules', 'puppeteer', 'lib', 'esm', 'puppeteer', 'puppeteer.js')).href
);

/* --------------------------------------------------------------------------
 * The listing, as data. Headlines and supporting lines come from the captions
 * in store/listing.md; `shot` is what store/shots/README.md is generated from.
 *
 *   layout  center | left (copy left, frame right) | right (frame left)
 *   frame   browser (chrome bar with a url) | plain (a bare rounded card)
 *   focus   object-position for the capture, i.e. the part to keep when cropping
 *   media   frame size override, for a capture that is not landscape
 *   recording  draw the GIF recorder's outline and pill over the capture
 * ------------------------------------------------------------------------ */

const SLOTS = [
  {
    id: 'youtube-quality',
    eyebrow: 'YouTube',
    headline: 'Every quality, right where you watch.',
    sub: '4K down to 144p, MP3 or M4A, and the thumbnail — one click from the Like button.',
    layout: 'center',
    frame: 'browser',
    url: 'youtube.com/watch',
    focus: '50% 34%',
    shot: {
      file: 'youtube-picker.png',
      needs: [
        'The Download button sitting in the action row, next to Like',
        'The quality picker open: 4K through 144p, MP3, M4A, thumbnail',
        'Enough of the video and title above it to read as a watch page',
      ],
      crop: 'Capture the browser content area at 1600x1000 or wider. Frame so the action row sits a little above centre; the picker must not be cut off at the bottom.',
    },
  },
  {
    id: 'album-downloads',
    eyebrow: 'Spotify and Apple Music',
    headline: 'Albums and playlists, tagged.',
    sub: 'Every track as an MP3 or M4A with cover art — as separate files, one ZIP, or a single mix.',
    layout: 'left',
    frame: 'browser',
    url: 'open.spotify.com/album',
    focus: '50% 40%',
    shot: {
      file: 'spotify-album-menu.png',
      needs: [
        'An album page with the Download button next to the play controls',
        'The picker showing a single song as a tagged MP3',
        'The "Download all" row with its ZIP and one-mix options',
      ],
      crop: 'Portrait-ish crop, roughly 4:3. Keep the album cover and title in shot for context; the open menu should sit in the middle third.',
    },
  },
  {
    id: 'page-to-png',
    eyebrow: 'Any page',
    headline: 'Save any part of a page as an image.',
    sub: 'Point at anything and take a PNG of it — including the parts taller than the screen.',
    layout: 'right',
    frame: 'browser',
    url: 'x.com',
    focus: '50% 0%',
    // The capture's own aspect, so the picker bar at the top and the whole
    // highlighted post (down to its action row) both stay in shot.
    media: { w: 640, h: 590 },
    shot: {
      file: 'webpage-png.png',
      needs: [
        'The element picker highlighting a post, with its size readout',
        'The "Save as PNG" affordance visible',
        'The finished PNG beside it, if it fits without crowding',
      ],
      crop: 'Roughly 4:3. The highlighted element should fill the middle; leave a little page around it so it is clear this is a live page.',
    },
  },
  {
    id: 'scrolling-gif',
    eyebrow: 'Any thread',
    headline: 'Record a scrolling GIF of a thread.',
    sub: 'Pick an area, scroll through it, press stop. The GIF is made by your own browser.',
    layout: 'left',
    frame: 'browser',
    url: 'reddit.com/r/XboxRetailHomebrew',
    focus: '50% 50%',
    // The capture is a frame of a real recording, which has no extension UI in
    // it: the outline and the pill are drawn over it, where the extension puts
    // them. `area` is [x, y, w, h] in pixels of the 700x496 framed capture.
    recording: { area: [12, 24, 460, 384], time: '0:06 / 1:00' },
    shot: {
      file: 'gif-record.png',
      needs: [
        'A thread or feed mid-scroll, with no hover cards or pop-ups open',
        'No readable usernames (blur them), and no mouse pointer',
        'No extension UI: the build draws the recording outline and pill over it',
      ],
      crop: 'Exactly 700x496 or a larger image of the same aspect, so `recording.area` lines up. The current one is frame 13 of gif-record-sample.gif, made by store/gif-frame.py.',
    },
  },
  {
    id: 'paste-a-link',
    eyebrow: 'Toolbar',
    headline: 'Paste any link. Pick a quality.',
    sub: 'It finds what is there and lists the options. Progress shows on the toolbar icon, so you can close the popup.',
    layout: 'right',
    frame: 'plain',
    focus: '50% 0%',
    media: { w: 430, h: 660 },
    shot: {
      file: 'popup-paste.png',
      needs: [
        'The toolbar popup with a link already pasted in the field',
        'The options it found listed underneath, with qualities',
        'No browser chrome around it — the popup only',
      ],
      crop: 'Capture the popup on its own, at 2x if possible, then trim to its rounded edge. Portrait, about 400x620.',
    },
  },
];

const TILES = {
  name: 'Just download it',
  line: 'Videos, songs, photos — where you already are.',
  // Optional: a real capture to use for the marquee instead of the drawn detail.
  marqueeDetail: 'marquee-detail.png',
};

/* -------------------------------------------------------------------------- */

const shotsDir = join(root, 'store', 'shots');
const assetsDir = join(root, 'store', 'assets');
const placeholderDir = join(root, 'store', 'placeholders');
for (const dir of [shotsDir, assetsDir, placeholderDir]) mkdirSync(dir, { recursive: true });

const dataUri = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;

/** Width and height as the PNG itself reports them, so the store sizes can be proved. */
function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Renders one document at an exact size and writes it, failing loudly on a size mismatch. */
async function render(page, html, width, height, file) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  const size = pngSize(png);
  if (size.width !== width || size.height !== height) {
    throw new Error(`${relative(root, file)}: rendered ${size.width}x${size.height}, wanted ${width}x${height}`);
  }
  writeFileSync(file, png);
  console.log(`${relative(root, file).replaceAll('\\', '/')}  ${width}x${height}`);
  return png;
}

const browser = await puppeteer.launch({ headless: true });
const built = [];
try {
  const page = await browser.newPage();

  // A capture if one has been taken, otherwise placeholder art at the same size.
  const captures = new Map();
  for (const slot of SLOTS) {
    const file = join(shotsDir, slot.shot.file);
    if (existsSync(file)) {
      captures.set(slot.id, { png: readFileSync(file), real: true });
      continue;
    }
    const { innerW, innerH } = mediaBox(slot);
    const png = await render(
      page,
      placeholderHtml(slot, innerW, innerH),
      innerW,
      innerH,
      join(placeholderDir, `${slot.id}.png`),
    );
    captures.set(slot.id, { png, real: false });
  }

  for (const [i, slot] of SLOTS.entries()) {
    const capture = captures.get(slot.id);
    const name = `screenshot-${i + 1}-${slot.id}.png`;
    await render(page, screenshotHtml(slot, dataUri(capture.png)), WIDTH, HEIGHT, join(assetsDir, name));
    built.push({
      field: `Screenshot ${i + 1}`,
      file: name,
      size: `${WIDTH}x${HEIGHT}`,
      what: `"${slot.headline}"`,
      source: capture.real ? `shots/${slot.shot.file}` : `placeholder (needs shots/${slot.shot.file})`,
    });
  }

  const small = `promo-small-${SMALL.w}x${SMALL.h}.png`;
  await render(page, smallTileHtml(TILES), SMALL.w, SMALL.h, join(assetsDir, small));
  built.push({ field: 'Small promo tile', file: small, size: `${SMALL.w}x${SMALL.h}`, what: 'Icon, name and one line', source: 'drawn' });

  const marquee = `promo-marquee-${MARQUEE.w}x${MARQUEE.h}.png`;
  await render(page, marqueeHtml(TILES), MARQUEE.w, MARQUEE.h, join(assetsDir, marquee));
  built.push({ field: 'Marquee promo tile', file: marquee, size: `${MARQUEE.w}x${MARQUEE.h}`, what: 'Name, line, and the Download button with its picker', source: 'drawn' });
} finally {
  await browser.close();
}

// The store icon is the extension's own 128px icon, copied as is.
{
  const from = join(root, 'extension', 'icons', 'icon-128.png');
  const size = pngSize(readFileSync(from));
  if (size.width !== 128 || size.height !== 128) throw new Error(`icon-128.png is ${size.width}x${size.height}, wanted 128x128`);
  copyFileSync(from, join(assetsDir, 'icon-128.png'));
  console.log('store/assets/icon-128.png  128x128');
  built.unshift({ field: 'Store icon', file: 'icon-128.png', size: '128x128', what: 'The extension icon', source: 'extension/icons/icon-128.png' });
}

/* ------------------------------------------------------- the two README files */

const missing = SLOTS.filter((s) => !existsSync(join(shotsDir, s.shot.file)));

writeFileSync(
  join(assetsDir, 'README.md'),
  `# Chrome Web Store images

Upload-ready. In the developer dashboard: Store listing, Graphic assets.

| Store field | File | Size | What it shows |
|---|---|---|---|
${built.map((b) => `| ${b.field} | \`${b.file}\` | ${b.size} | ${b.what} |`).join('\n')}

Screenshots go in the order numbered. Captions and descriptions are in
\`store/listing.md\`.

Generated by \`node store/build.mjs\` from the captures in \`store/shots/\` — edit
the templates or the slot config there, never these files.
${
    missing.length
      ? `Still on placeholder art (${missing.length} of ${SLOTS.length}): ${missing
          .map((s) => `\`${s.shot.file}\``)
          .join(', ')}. See \`store/shots/README.md\`, then run the build again.`
      : 'Every screenshot uses a real capture.'
  }
`,
);

writeFileSync(
  join(shotsDir, 'README.md'),
  `# Raw captures

Drop each capture here under the file name below and run \`node store/build.mjs\`.
The build crops and frames it, so the size does not have to be exact — but more
pixels are better, and the listed part must be in shot. PNG only.

Capture with the browser at a comfortable zoom, on a clean profile (no other
extensions in the toolbar, no personal account name or avatar in frame), and a
light page theme so the captures match the light frame around them.

Capture the page content only — the build draws its own browser chrome around it.
The address shown in that chrome is the slot's \`url\` in \`store/build.mjs\`; change
it to match whatever page the capture was actually taken on.

${SLOTS.map(
  (slot) => `## \`${slot.shot.file}\`

Screenshot ${SLOTS.indexOf(slot) + 1} — "${slot.headline}"

Must be visible:

${slot.shot.needs.map((n) => `- ${n}`).join('\n')}

Cropping: ${slot.shot.crop}

Framed at ${mediaBox(slot).innerW}x${mediaBox(slot).innerH} and cropped to fill, anchored ${slot.focus.split(' ')[0]} across and ${slot.focus.split(' ')[1]} down. That is the slot's \`focus\` in \`store/build.mjs\` — change it if the crop lands badly.
`,
).join('\n')}
## \`${TILES.marqueeDetail}\` (optional)

Not used yet: the marquee draws its own close-up of the Download button and the
quality picker. A real close-up of the button in a site's action row could
replace it later.
`,
);

console.log(
  `store/assets/README.md, store/shots/README.md  (${built.length} images, ${missing.length} still on placeholder art)`,
);
