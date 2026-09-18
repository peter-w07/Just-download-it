// Renders the extension icon (an SVG defined here) to PNGs at every size the
// manifest uses. Run: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'extension', 'icons');
mkdirSync(out, { recursive: true });

// Small sizes get a thicker stroke so the arrow stays legible at 16px.
const svg = (size) => {
  const stroke = size <= 16 ? 3.4 : size <= 32 ? 2.9 : 2.4;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f86ff"/>
      <stop offset="1" stop-color="#2553e6"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="url(#g)"/>
  <path d="M12 5.2v9.3m0 0 3.9-3.9M12 14.5 8.1 10.6M6.2 18.6h11.6" fill="none" stroke="#fff"
        stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
};

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`,
      { waitUntil: 'load' },
    );
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    writeFileSync(join(out, `icon-${size}.png`), png);
    console.log(`icon-${size}.png`);
  }
  writeFileSync(join(out, 'icon.svg'), svg(128).trim() + '\n');
} finally {
  await browser.close();
}
