// Stand-in art for a capture that has not been taken yet, drawn at exactly the
// size of the slot's frame so nothing is cropped. Deliberately abstract: grey
// wireframe blocks, never an imitation of any real site, plus the file name and
// the shot list so the whole set can be reviewed before the real captures land.
import { arrow, FONT, MONO, palette } from './theme.js';

const escape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function placeholderHtml(slot, width, height) {
  const narrow = width < 560;
  const css = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: ${width}px; height: ${height}px; font-family: ${FONT}; background: #fff; }
.ph { position: relative; width: 100%; height: 100%; background: #f8fafd; overflow: hidden; }

/* Abstract page wireframe, so the composition reads like a real capture. */
.w { position: absolute; background: #e9edf5; border-radius: 8px; }
.w.bar { left: 0; right: 0; top: 0; height: 7%; border-radius: 0; background: #e4e9f2; }
.w.rail { left: 3%; top: 13%; width: 21%; bottom: 8%; background: #edf0f7; }
.w.hero { left: 28%; right: 3%; top: 13%; height: 44%; background: #e4e9f2; }
.w.l1 { left: 28%; top: 61%; width: ${narrow ? 60 : 38}%; height: 4%; background: #edf0f7; }
.w.l2 { left: 28%; top: 68%; width: ${narrow ? 44 : 26}%; height: 4%; background: #edf0f7; }
.pill {
  position: absolute; right: 5%; bottom: 7%;
  display: flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 13px 0 10px; border-radius: 999px;
  background: linear-gradient(${palette.brandFrom}, ${palette.brandTo});
  color: #fff; font-size: 13.5px; font-weight: 600;
  box-shadow: 0 4px 12px rgba(37, 83, 230, 0.35);
}
.pill svg { display: block; }

.tag {
  position: absolute; left: 14px; top: 14px;
  padding: 5px 10px; border-radius: 7px;
  background: #ffca3a; color: #49340a;
  font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
}

.note {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: ${narrow ? 90 : 74}%;
  padding: ${narrow ? 18 : 22}px ${narrow ? 18 : 26}px;
  background: rgba(255, 255, 255, 0.97);
  border: 2px dashed #b7c5e2; border-radius: 16px;
  box-shadow: 0 18px 40px -22px rgba(16, 40, 100, 0.55);
}
.note h2 {
  font-size: 11.5px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
  color: #8d9ab7;
}
.note .file {
  margin-top: 7px;
  font-family: ${MONO}; font-size: ${narrow ? 15 : 18}px; font-weight: 700; color: #16254a;
  word-break: break-all;
}
.note ul { margin-top: 12px; padding-left: 0; list-style: none; }
.note li {
  position: relative; padding-left: 16px; margin-top: 6px;
  font-size: ${narrow ? 12.5 : 14}px; line-height: 1.45; color: #47568a;
}
.note li::before {
  content: ""; position: absolute; left: 3px; top: 8px;
  width: 5px; height: 5px; border-radius: 50%; background: ${palette.brand};
}
.note .crop {
  margin-top: 12px; padding-top: 10px; border-top: 1px solid #e6ebf4;
  font-size: ${narrow ? 11.5 : 12.5}px; line-height: 1.45; color: #7b88a6;
}
`;
  const needs = (slot.shot.needs ?? []).map((n) => `<li>${escape(n)}</li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>${css}</style></head>
<body>
<div class="ph">
  <div class="w bar"></div><div class="w rail"></div><div class="w hero"></div>
  <div class="w l1"></div><div class="w l2"></div>
  <div class="pill">${arrow(16)}Download</div>
  <div class="tag">Placeholder</div>
  <div class="note">
    <h2>Needs a real capture</h2>
    <div class="file">store/shots/${escape(slot.shot.file)}</div>
    <ul>${needs}</ul>
    <div class="crop">${escape(slot.shot.crop ?? '')}</div>
  </div>
</div>
</body></html>`;
}
