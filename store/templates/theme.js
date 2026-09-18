// The look every store image shares: the palette, the type scale, the stage
// background and the browser-ish frame. Imported by screenshot.js, promo.js and
// placeholder.js so all seven images read as one system.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const palette = {
  brand: '#2f6bff',
  brandFrom: '#4f86ff',
  brandTo: '#2553e6',
  ink: '#0d1733',
  muted: '#4a5a85',
};

// No web fonts: the renderer must work offline, so this is the local stack.
export const FONT =
  "system-ui, 'Segoe UI Variable Display', 'Segoe UI', Inter, Roboto, 'Helvetica Neue', Arial, sans-serif";
export const MONO = "'Cascadia Mono', 'Consolas', ui-monospace, SFMono-Regular, Menlo, monospace";

/** The extension icon, inlined from extension/icons/icon.svg with a unique gradient id. */
export function icon(size, uid = 'ic') {
  const raw = readFileSync(join(root, 'extension', 'icons', 'icon.svg'), 'utf8').trim();
  return raw
    .replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
    .replaceAll('id="g"', `id="${uid}"`)
    .replaceAll('url(#g)', `url(#${uid})`);
}

/** Just the download arrow, for the Download pill drawn in the marquee tile. */
export function arrow(size, color = '#fff', stroke = 2.6) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 5.2v9.3m0 0 3.9-3.9M12 14.5 8.1 10.6M6.2 18.6h11.6" fill="none" stroke="${color}"
        stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

/** Reset, stage background (soft brand-blue gradient, faint grid, two glows) and type scale. */
export const baseCss = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; }
body {
  font-family: ${FONT};
  color: ${palette.ink};
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
}
.canvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: linear-gradient(142deg, #f6f9ff 0%, #e9f0ff 46%, #d7e4ff 100%);
}
.grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(47, 107, 255, 0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(47, 107, 255, 0.07) 1px, transparent 1px);
  background-size: 48px 48px;
  -webkit-mask-image: radial-gradient(125% 95% at 50% 0%, #000 0%, transparent 74%);
  mask-image: radial-gradient(125% 95% at 50% 0%, #000 0%, transparent 74%);
}
.glow { position: absolute; border-radius: 50%; }
.glow.a {
  width: 940px; height: 940px; left: -260px; top: -420px;
  background: radial-gradient(circle, rgba(79, 134, 255, 0.36), rgba(79, 134, 255, 0) 62%);
}
.glow.b {
  width: 880px; height: 880px; right: -280px; bottom: -400px;
  background: radial-gradient(circle, rgba(37, 83, 230, 0.24), rgba(37, 83, 230, 0) 62%);
}

/* Type scale. Sized so the headline stays readable when the store shrinks the image. */
.eyebrow {
  display: inline-flex; align-items: center; gap: 9px;
  font-size: 18px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase;
  color: ${palette.brand};
}
.eyebrow i {
  width: 9px; height: 9px; border-radius: 50%;
  background: linear-gradient(${palette.brandFrom}, ${palette.brandTo});
}
h1 {
  margin-top: 18px;
  font-size: 50px; line-height: 1.1; font-weight: 700; letter-spacing: -1.1px;
  color: ${palette.ink};
  text-wrap: balance;
}
.sub {
  margin-top: 20px;
  font-size: 22px; line-height: 1.5; font-weight: 400;
  color: ${palette.muted};
  text-wrap: pretty;
}

/* The frame the capture sits in. */
.frame {
  position: relative;
  background: #fff;
  border: 1px solid rgba(15, 35, 95, 0.1);
  border-radius: 18px;
  overflow: hidden;
  box-shadow:
    0 1px 2px rgba(16, 40, 100, 0.1),
    0 10px 24px -8px rgba(16, 40, 100, 0.22),
    0 44px 80px -32px rgba(16, 40, 100, 0.55);
}
.frame.plain { border-radius: 16px; }
.chrome {
  display: flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 14px;
  background: linear-gradient(#fbfcfe, #f2f5fb);
  border-bottom: 1px solid #e6ebf4;
}
.chrome b { width: 10px; height: 10px; border-radius: 50%; display: block; }
.chrome .url {
  flex: 1; height: 22px; margin: 0 12px 0 10px; padding: 0 11px;
  display: flex; align-items: center;
  border-radius: 11px; background: #eaeff8;
  font-size: 12.5px; color: #5d6983; letter-spacing: 0.1px;
}
/* The extension's own icon, sitting in the toolbar where it really is. */
.chrome .ext svg { display: block; border-radius: 4px; }
.frame img {
  display: block;
  width: 100%;
  object-fit: cover;
}
`;

/** Wraps a body in a full document sized for the render viewport. */
export function page(css, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>${baseCss}${css}</style>
</head>
<body>${body}</body>
</html>`;
}
