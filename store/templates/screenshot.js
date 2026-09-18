// The 1280x800 store screenshot: a capture in a browser-ish frame on the brand
// stage, with one headline and one supporting line.
//
// Layouts (slot.layout):
//   center  headline above a wide frame
//   left    copy on the left, frame on the right
//   right   frame on the left, copy on the right
//
// The frame size is fixed per layout, so any capture works: it is cropped to
// fill with object-fit, around the focus point the slot asks for.
//
// slot.recording draws the GIF recorder's own UI over the capture (the red
// outline around the recorded area and the control pill under it), for a
// capture that was taken without it.
import { FONT, icon, page } from './theme.js';

export const WIDTH = 1280;
export const HEIGHT = 800;

const PAD_X = 64;
const PAD_Y = 56;
const TEXT_COL = 396;
const GAP = 56;
const MEDIA_COL = WIDTH - PAD_X * 2 - TEXT_COL - GAP; // 700
const CHROME_H = 40;

const DEFAULT_MEDIA = {
  center: { w: 1040, h: 468 },
  left: { w: 700, h: 536 },
  right: { w: 700, h: 536 },
};

/** Where the capture lands, in pixels. Placeholders are drawn at exactly innerW x innerH. */
export function mediaBox(slot) {
  const { w, h } = slot.media ?? DEFAULT_MEDIA[slot.layout];
  const chrome = slot.frame === 'browser' ? CHROME_H : 0;
  return { w, h, innerW: w, innerH: h - chrome };
}

const escape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The recorder UI as the extension draws it on a dark site (content/capture.js):
 * a 2px outline 4px outside the recorded area, and the pill 10px under it,
 * centred on the area. `area` is [x, y, w, h] in pixels of the framed capture.
 */
function recordingHtml({ area: [x, y, w, h], time }) {
  const ring = 4;
  const gap = 10;
  return `<div class="rec-outline" style="left:${x - ring}px;top:${y - ring}px;width:${w + ring * 2}px;height:${h + ring * 2}px"></div>
      <div class="rec-pill" style="left:${x + w / 2}px;top:${y + h + ring + gap}px">
        <span class="dot"></span><span class="time">${escape(time)}</span>
        <span class="btn primary">Stop &amp; save</span><span class="btn">Cancel</span>
      </div>`;
}

function frameHtml(slot, src) {
  const { w, h, innerH } = mediaBox(slot);
  const browser = slot.frame === 'browser';
  const chrome = browser
    ? `<div class="chrome">
        <b style="background:#ff5f57"></b><b style="background:#febc2e"></b><b style="background:#28c840"></b>
        <span class="url">${escape(slot.url ?? '')}</span>
        <span class="ext">${icon(18, `ch-${slot.id}`)}</span>
      </div>`
    : '';
  const overlay = slot.recording
    ? `<div class="overlay" style="top:${browser ? CHROME_H : 0}px;height:${innerH}px">${recordingHtml(slot.recording)}</div>`
    : '';
  return `<div class="frame ${browser ? '' : 'plain'}" style="width:${w}px;height:${h}px">
      ${chrome}
      <img src="${src}" style="height:${innerH}px;object-position:${slot.focus ?? '50% 50%'}" alt="">
      ${overlay}
    </div>`;
}

const css = `
.stage {
  position: relative;
  display: flex;
  width: 100%; height: 100%;
  padding: ${PAD_Y}px ${PAD_X}px;
  gap: ${GAP}px;
}
.stage.center { flex-direction: column; align-items: center; justify-content: center; gap: 42px; text-align: center; }
.stage.center h1 { font-size: 46px; letter-spacing: -0.9px; }
.stage.left { flex-direction: row; align-items: center; }
.stage.right { flex-direction: row-reverse; align-items: center; }
/* 48px keeps every side-layout headline to two lines in the ${TEXT_COL}px column. */
.stage.left h1, .stage.right h1 { font-size: 48px; }

.copy { width: ${TEXT_COL}px; flex: none; }
.stage.center .copy { width: auto; max-width: 1080px; }
.stage.center .sub { max-width: 860px; margin-left: auto; margin-right: auto; }

.media { width: ${MEDIA_COL}px; flex: none; display: flex; align-items: center; justify-content: center; }
.stage.center .media { width: auto; }

/* The GIF recorder, in the extension's dark theme. */
.overlay { position: absolute; left: 0; right: 0; }
.rec-outline {
  position: absolute; border: 2px solid #ff6b73; border-radius: 4px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.75), inset 0 0 0 1px rgba(0, 0, 0, 0.35);
}
.rec-pill {
  position: absolute; transform: translateX(-50%);
  display: flex; align-items: center; gap: 7px;
  padding: 5px 5px 5px 14px; border-radius: 999px;
  background: #1c1f26; color: #eef0f4; border: 1px solid #2e333d;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.18);
  font-family: ${FONT}; font-size: 14px; line-height: 1.35; white-space: nowrap;
}
.rec-pill .dot {
  width: 10px; height: 10px; border-radius: 50%; flex: none;
  background: #ff6b73; box-shadow: 0 0 0 3px rgba(255, 107, 115, 0.22);
}
.rec-pill .time { min-width: 82px; margin-left: 2px; color: #9aa2b1; font-variant-numeric: tabular-nums; }
.rec-pill .btn {
  height: 32px; padding: 0 14px; display: inline-flex; align-items: center;
  border-radius: 999px; font-weight: 600;
}
.rec-pill .btn.primary { background: #5b8cff; color: #0b0d12; }
`;

export function screenshotHtml(slot, src) {
  const body = `<div class="canvas">
  <div class="grid"></div><div class="glow a"></div><div class="glow b"></div>
  <div class="stage ${slot.layout}">
    <div class="copy">
      <div class="eyebrow"><i></i>${escape(slot.eyebrow)}</div>
      <h1>${escape(slot.headline)}</h1>
      <p class="sub">${escape(slot.sub)}</p>
    </div>
    <div class="media">${frameHtml(slot, src)}</div>
  </div>
</div>`;
  return page(css, body);
}
