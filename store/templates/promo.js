// The two promo tiles: the 440x280 small tile (icon, wordmark, one line) and the
// 1400x560 marquee (the same, beside a zoomed detail of the Download button and
// its quality picker). Same stage, type and shadows as the screenshots.
import { arrow, icon, page, palette } from './theme.js';

export const SMALL = { w: 440, h: 280 };
export const MARQUEE = { w: 1400, h: 560 };

const escape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const markCss = `
.mark { filter: drop-shadow(0 12px 26px rgba(37, 83, 230, 0.45)); }
.mark svg { display: block; border-radius: 22%; }
.wordmark { font-weight: 700; letter-spacing: -1px; color: ${palette.ink}; }
.line { color: ${palette.muted}; }
`;

/* ---------------------------------------------------------------- small tile */

const smallCss = `
${markCss}
.tile {
  position: relative; width: 100%; height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 30px 34px; text-align: center;
}
.wordmark { margin-top: 17px; font-size: 33px; }
/* Darker than muted: on a tile this small the glows turn the whole background mid-blue. */
.line { margin-top: 11px; font-size: 15.5px; line-height: 1.45; max-width: 330px; color: #3b4870; }
`;

export function smallTileHtml({ name, line }) {
  const body = `<div class="canvas">
  <div class="grid"></div><div class="glow a"></div><div class="glow b"></div>
  <div class="tile">
    <div class="mark">${icon(70, 'sm')}</div>
    <div class="wordmark">${escape(name)}</div>
    <div class="line">${escape(line)}</div>
  </div>
</div>`;
  return page(smallCss, body);
}

/* ------------------------------------------------------------------ marquee */

const marqueeCss = `
${markCss}
.tile { position: relative; width: 100%; height: 100%; display: flex; align-items: center; padding: 64px; gap: 64px; }
.intro { width: 560px; flex: none; }
.wordmark { margin-top: 26px; font-size: 56px; }
.line { margin-top: 16px; font-size: 22px; line-height: 1.45; max-width: 540px; }

.showcase { flex: 1; display: flex; justify-content: center; }

/* A zoomed fragment of a page: a site's action row, with the extension in it. */
.detail {
  flex: none;
  background: #fff;
  border: 1px solid rgba(15, 35, 95, 0.1);
  border-radius: 20px;
  padding: 26px 28px 30px;
  box-shadow:
    0 1px 2px rgba(16, 40, 100, 0.1),
    0 12px 26px -10px rgba(16, 40, 100, 0.22),
    0 48px 80px -34px rgba(16, 40, 100, 0.6);
}
.row { display: flex; align-items: center; gap: 14px; }
.ghost {
  display: flex; align-items: center; gap: 9px;
  height: 44px; padding: 0 20px; border-radius: 999px; background: #eef1f7;
}
.ghost i { width: 18px; height: 18px; border-radius: 50%; background: #d6dded; }
.ghost u { width: 46px; height: 9px; border-radius: 5px; background: #d6dded; }
.dl {
  display: flex; align-items: center; gap: 9px;
  height: 48px; padding: 0 24px 0 20px; border-radius: 999px;
  background: linear-gradient(${palette.brandFrom}, ${palette.brandTo});
  color: #fff; font-size: 19px; font-weight: 600; letter-spacing: -0.2px;
  box-shadow: 0 8px 22px -6px rgba(37, 83, 230, 0.7);
}
.picker {
  margin-top: 18px; padding: 10px;
  background: #fff; border: 1px solid #e4e9f3; border-radius: 16px;
  box-shadow: 0 16px 38px -18px rgba(16, 40, 100, 0.55);
}
.picker h3 {
  padding: 6px 10px 10px;
  font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #66738f;
}
.opt {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-radius: 10px;
  font-size: 16px; color: #2a3557;
}
.opt span { color: #66738f; font-size: 14px; }
.opt.on { background: rgba(47, 107, 255, 0.1); color: ${palette.brandTo}; font-weight: 600; }
.opt.on span { color: ${palette.brand}; }
`;

export function marqueeHtml({ name, line }) {
  const opts = [
    ['4K', 'MP4', true],
    ['1080p', 'MP4', false],
    ['Song', 'MP3, tagged', false],
    ['Song', 'M4A, tagged', false],
    ['Thumbnail', 'JPG', false],
  ]
    .map(([a, b, on]) => `<div class="opt${on ? ' on' : ''}">${a}<span>${b}</span></div>`)
    .join('');
  const body = `<div class="canvas">
  <div class="grid"></div><div class="glow a"></div><div class="glow b"></div>
  <div class="tile">
    <div class="intro">
      <div class="mark">${icon(76, 'mq')}</div>
      <div class="wordmark">${escape(name)}</div>
      <div class="line">${escape(line)}</div>
    </div>
    <div class="showcase"><div class="detail">
      <div class="row">
        <div class="ghost"><i></i><u></u></div>
        <div class="ghost"><i></i><u></u></div>
        <div class="dl">${arrow(21)}Download</div>
      </div>
      <div class="picker">
        <h3>Pick a quality</h3>
        ${opts}
      </div>
    </div></div>
  </div>
</div>`;
  return page(marqueeCss, body);
}
