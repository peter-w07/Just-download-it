// Just download it: "Screenshot or GIF any tab", with no extension.
//
// The browser's own screen sharing (getDisplayMedia) shows the tab the person
// picks in a <video> here. They drag a box over it, and the box is saved as a
// PNG, or recorded into a GIF a few times a second while they scroll. In
// Chrome and Edge, "Scroll from here" forwards the mouse wheel to the shared
// tab (Captured Surface Control), and sharing doesn't switch tabs, so this
// page stays in front. Nothing leaves the browser.
//
// The GIF encoding matches the extension's recorder (extension/offscreen/recorder.js):
// unchanged frames are skipped, and each frame only stores the rectangle that
// changed, with its own 256-colour palette.
import { GIFEncoder, applyPalette, quantize } from './vendor/gifenc.mjs';

const FPS = 10;
const MAX_SECONDS = 60;
const MAX_WIDTH = 800;
const MAX_FRAME_PIXELS = 800 * 800;
const MIN_LAST_FRAME_MS = 1000; // the last frame stays up a moment before the GIF loops
const BLOB_FLUSH_BYTES = 8 * 1024 * 1024;
const MIN_BOX = 8; // screen pixels: a smaller drag is a click, which clears the box

const $ = (id) => document.getElementById(id);
const video = $('cap-video');
const frame = $('cap-frame');
const overlay = $('cap-overlay');
const boxEl = $('cap-box');
const sizeEl = $('cap-size');
const hint = $('cap-hint');
const shareButton = $('cap-share');
const scrollButton = $('cap-scroll');
const allButton = $('cap-all');

let stream = null;
let controller = null;
let box = null; // { x, y, width, height } in the video's pixels, or null for the whole tab
let drag = null;
let recording = null;
let scrolling = false;
let lastUrl = '';

// ---------------------------------------------------------------------------
// Start: an optional page to open first (from ?url=), then share a tab
// ---------------------------------------------------------------------------

const pageLink = (() => {
  const raw = new URLSearchParams(location.search).get('url');
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
})();
if (pageLink) {
  $('cap-step-open').hidden = false;
  $('cap-open').href = pageLink.href;
  $('cap-open-host').textContent = `${pageLink.hostname.replace(/^www\./, '')} opens in a new tab. Scroll to the part you want.`;
  $('cap-share-num').textContent = '2';
}

const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
if (!canShare) {
  shareButton.disabled = true;
  $('cap-unsupported').hidden = false;
  if (pageLink) $('cap-step-open').hidden = true;
}

function showError(text) {
  const error = $('cap-error');
  error.textContent = text;
  error.hidden = !text;
}

async function share() {
  showError('');
  controller = typeof CaptureController === 'function' ? new CaptureController() : null;
  // Keep this page in front after the person picks a tab (Chrome, Edge).
  const stayHere = () => {
    try {
      controller.setFocusBehavior('no-focus-change');
    } catch {
      /* not supported, or too late */
    }
  };
  if (controller) stayHere();
  const options = {
    video: { displaySurface: 'browser', frameRate: 30 },
    audio: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'exclude',
  };
  if (controller) options.controller = controller;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return; // they closed the dialog
    showError(`Couldn’t share a tab (${(err && (err.message || err.name)) || err}).`);
    return;
  }
  if (controller) stayHere();

  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => stopSharing()); // "Stop sharing" in the browser's own bar

  box = null;
  scrolling = false;
  const surface = (track.getSettings && track.getSettings().displaySurface) || '';
  const canForward = !!(controller && typeof controller.forwardWheel === 'function') && surface === 'browser';
  scrollButton.hidden = !canForward;
  scrollButton.disabled = false;
  scrollButton.textContent = 'Scroll from here';
  $('cap-side-tip').hidden = canForward;
  // Show the stage first: a video that isn't displayed may never start.
  $('cap-start').hidden = true;
  $('cap-live').hidden = false;
  video.srcObject = stream;
  video.play().catch(() => {});
  if (!(await whenSized(video, 8000))) {
    stopSharing();
    showError('The shared tab didn’t show up. Try sharing it again.');
    return;
  }
  layout();
  render();
  $('cap-live').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** Resolves true once the video knows its size, or false after `ms`. */
function whenSized(el, ms) {
  return new Promise((resolve) => {
    const check = () => {
      if (!el.videoWidth) return;
      finish();
      resolve(true);
    };
    const finish = () => {
      clearInterval(poll);
      clearTimeout(timer);
      el.removeEventListener('loadedmetadata', check);
      el.removeEventListener('resize', check);
    };
    el.addEventListener('loadedmetadata', check);
    el.addEventListener('resize', check);
    const poll = setInterval(check, 100);
    const timer = setTimeout(() => {
      finish();
      resolve(!!el.videoWidth);
    }, ms);
    check();
  });
}

function stopSharing() {
  if (recording) stopGif(true);
  if (stream) for (const track of stream.getTracks()) track.stop();
  stream = null;
  controller = null;
  video.srcObject = null;
  $('cap-live').hidden = true;
  $('cap-start').hidden = false;
  shareButton.textContent = 'Share another tab';
}

shareButton.addEventListener('click', share);
$('cap-stop').addEventListener('click', () => stopSharing());

// "Scroll from here": the wheel over the picture scrolls the shared tab. Chrome
// asks for permission the first time, so it has to start from a click.
scrollButton.addEventListener('click', async () => {
  if (!controller || scrolling) return;
  try {
    await controller.forwardWheel(overlay);
    scrolling = true;
    scrollButton.textContent = 'Scrolling from here';
    scrollButton.disabled = true;
    render();
  } catch (err) {
    showError(`Your browser wouldn’t let this page scroll the tab (${(err && (err.message || err.name)) || err}). Scroll it in its own window instead.`);
    scrollButton.hidden = true;
    $('cap-side-tip').hidden = false;
  }
});

// ---------------------------------------------------------------------------
// The picture and the box
// ---------------------------------------------------------------------------

/** Fit the shared tab into the page: as wide as there's room for, and not taller than most of the window. */
function layout() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const room = frame.parentElement.clientWidth;
  const maxHeight = Math.max(260, window.innerHeight * 0.72);
  const scale = Math.min(room / vw, maxHeight / vh);
  frame.style.width = `${Math.floor(vw * scale)}px`;
  frame.style.height = `${Math.floor(vh * scale)}px`;
  render();
}
window.addEventListener('resize', layout);
video.addEventListener('resize', () => {
  // The shared tab changed size: keep the box inside it.
  if (box) box = clampBox(box);
  layout();
});

function screenScale() {
  return video.videoWidth ? overlay.getBoundingClientRect().width / video.videoWidth : 1;
}

function toVideo(event) {
  const rect = overlay.getBoundingClientRect();
  const scale = video.videoWidth / rect.width;
  return {
    x: Math.min(video.videoWidth, Math.max(0, (event.clientX - rect.left) * scale)),
    y: Math.min(video.videoHeight, Math.max(0, (event.clientY - rect.top) * scale)),
  };
}

function clampBox(b) {
  const width = Math.min(b.width, video.videoWidth);
  const height = Math.min(b.height, video.videoHeight);
  return {
    x: Math.min(Math.max(0, b.x), video.videoWidth - width),
    y: Math.min(Math.max(0, b.y), video.videoHeight - height),
    width,
    height,
  };
}

/** The part to save, in whole video pixels. */
function region() {
  const b = box || { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
  const x = Math.round(b.x);
  const y = Math.round(b.y);
  return { x, y, width: Math.max(1, Math.round(b.x + b.width) - x), height: Math.max(1, Math.round(b.y + b.height) - y) };
}

function render() {
  const scale = screenScale();
  boxEl.hidden = !box;
  overlay.classList.toggle('has-box', !!box);
  allButton.hidden = !box || !!recording;
  if (box) {
    boxEl.style.left = `${box.x * scale}px`;
    boxEl.style.top = `${box.y * scale}px`;
    boxEl.style.width = `${box.width * scale}px`;
    boxEl.style.height = `${box.height * scale}px`;
    const r = region();
    sizeEl.textContent = `${r.width} × ${r.height}`;
  }
  if (!recording) {
    hint.textContent = scrolling
      ? 'Scroll over the picture to scroll the tab. Drag a box around what you want; no box saves the whole tab.'
      : 'Drag a box around what you want. No box saves the whole tab.';
  }
}

overlay.addEventListener('pointerdown', (event) => {
  if (recording || event.button !== 0 || !video.videoWidth) return;
  const point = toVideo(event);
  const inside = box && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
  drag = inside ? { mode: 'move', start: point, from: { ...box } } : { mode: 'draw', start: point };
  overlay.setPointerCapture(event.pointerId);
  event.preventDefault();
});

overlay.addEventListener('pointermove', (event) => {
  if (!video.videoWidth) return;
  const point = toVideo(event);
  if (!drag) {
    const inside = box && !recording && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
    overlay.classList.toggle('can-move', !!inside);
    return;
  }
  if (drag.mode === 'draw') {
    box = {
      x: Math.min(drag.start.x, point.x),
      y: Math.min(drag.start.y, point.y),
      width: Math.abs(point.x - drag.start.x),
      height: Math.abs(point.y - drag.start.y),
    };
  } else {
    box = clampBox({ ...drag.from, x: drag.from.x + point.x - drag.start.x, y: drag.from.y + point.y - drag.start.y });
  }
  render();
});

function endDrag() {
  if (!drag) return;
  drag = null;
  const scale = screenScale();
  if (box && (box.width * scale < MIN_BOX || box.height * scale < MIN_BOX)) box = null;
  render();
}
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

allButton.addEventListener('click', () => {
  box = null;
  render();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('cap-live').hidden) return;
  if (recording) stopGif(false);
  else if (box) {
    box = null;
    render();
  }
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function deliver(blob, kind) {
  const name = `Just download it ${stamp()}.${kind}`;
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = lastUrl;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();

  $('cap-result').hidden = false;
  $('cap-result-img').src = lastUrl;
  $('cap-result-img').alt = kind === 'gif' ? 'The GIF you recorded' : 'The picture you saved';
  $('cap-result-title').textContent = kind === 'gif' ? 'GIF saved' : 'PNG saved';
  $('cap-result-text').textContent = `${name} · ${formatBytes(blob.size)}. It’s in your Downloads folder.`;
  const again = $('cap-result-save');
  again.href = lastUrl;
  again.download = name;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

$('cap-png').addEventListener('click', async () => {
  if (!video.videoWidth) return;
  const r = region();
  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext('2d').drawImage(video, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  frame.classList.remove('flash');
  void frame.offsetWidth;
  frame.classList.add('flash');
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob) deliver(blob, 'png');
  else showError('Couldn’t make the picture. Try a smaller box.');
});

// ---------------------------------------------------------------------------
// GIF recording
// ---------------------------------------------------------------------------

/** Ticks from a worker: unlike timers on the page, they keep coming if this tab is in the background. */
function ticker(ms, onTick) {
  try {
    const source = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
    const worker = new Worker(source);
    URL.revokeObjectURL(source);
    worker.onmessage = onTick;
    return () => worker.terminate();
  } catch {
    const timer = setInterval(onTick, ms);
    return () => clearInterval(timer);
  }
}

class GifRecording {
  constructor(source, r) {
    this.source = source;
    this.r = r;
    let scale = Math.min(1, MAX_WIDTH / r.width, Math.sqrt(MAX_FRAME_PIXELS / (r.width * r.height)));
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    this.width = Math.max(1, Math.round(r.width * scale));
    this.height = Math.max(1, Math.round(r.height * scale));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    this.ctx.imageSmoothingQuality = 'high';
    this.encoder = GIFEncoder({ auto: false });
    this.previous = null;
    this.pending = null; // { data, rect, at }: waiting to learn how long it lasts
    this.firstAt = 0;
    this.shownCs = 0;
    this.frames = 0;
    this.chunks = [];
    this.chunkBytes = 0;
    this.parts = [];
  }

  sample(now) {
    const { r, width, height } = this;
    this.ctx.drawImage(this.source, r.x, r.y, r.width, r.height, 0, 0, width, height);
    const data = this.ctx.getImageData(0, 0, width, height).data;
    const rect = this.previous ? changedRect(this.previous, data, width, height) : { x: 0, y: 0, width, height };
    if (!rect) return; // nothing moved: the pending frame just lasts longer
    if (this.pending) this.encode({ ...this.pending, until: now });
    else this.firstAt = now;
    this.pending = { data, rect, at: now };
    this.previous = data;
  }

  finish(now) {
    this.sample(now);
    if (this.pending) this.encode({ ...this.pending, until: Math.max(now, this.pending.at + MIN_LAST_FRAME_MS) });
    this.pending = null;
    this.flush();
    return new Blob([...this.parts, new Uint8Array([0x3b])], { type: 'image/gif' });
  }

  encode({ data, rect, until }) {
    const first = this.frames === 0;
    const full = rect.x === 0 && rect.y === 0 && rect.width === this.width && rect.height === this.height;
    const pixels = full ? data : cropPixels(data, this.width, rect);
    // Delays are in centiseconds; count from the running total so rounding
    // doesn't drift, and never below 2 (browsers show less as 10).
    const endCs = Math.round((until - this.firstAt) / 10);
    const delayCs = Math.max(2, endCs - this.shownCs);
    this.shownCs += delayCs;
    const palette = quantize(pixels, 256, { format: 'rgb444' });
    const index = applyPalette(pixels, palette, 'rgb565');
    const enc = this.encoder;
    enc.reset();
    if (first) enc.writeHeader();
    enc.writeFrame(index, rect.width, rect.height, { palette, first, delay: delayCs * 10, repeat: 0, dispose: 1 });
    const bytes = enc.bytes();
    if (!first) {
      // gifenc places every frame at 0,0; move it to the rectangle that changed.
      // The image descriptor follows the 8-byte graphic control extension.
      bytes[9] = rect.x & 0xff;
      bytes[10] = (rect.x >> 8) & 0xff;
      bytes[11] = rect.y & 0xff;
      bytes[12] = (rect.y >> 8) & 0xff;
    }
    this.chunks.push(bytes);
    this.chunkBytes += bytes.byteLength;
    this.frames++;
    if (this.chunkBytes >= BLOB_FLUSH_BYTES) this.flush();
  }

  flush() {
    if (!this.chunks.length) return;
    this.parts.push(new Blob(this.chunks));
    this.chunks = [];
    this.chunkBytes = 0;
  }
}

/** The smallest rectangle holding every pixel that differs, or null if none do. */
function changedRect(a, b, width, height) {
  const A = new Uint32Array(a.buffer, a.byteOffset, width * height);
  const B = new Uint32Array(b.buffer, b.byteOffset, width * height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (A[row + x] !== B[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function cropPixels(data, width, rect) {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.y + y) * width + rect.x) * 4;
    out.set(data.subarray(start, start + rect.width * 4), y * rect.width * 4);
  }
  return out;
}

let stopTicks = null;
let startedAt = 0;

function startGif() {
  if (!video.videoWidth || recording) return;
  recording = new GifRecording(video, region());
  startedAt = performance.now();
  recording.sample(startedAt);
  let last = startedAt;
  stopTicks = ticker(1000 / FPS, () => {
    const now = performance.now();
    if (now - startedAt >= MAX_SECONDS * 1000) return stopGif(true);
    if (now - last < 1000 / FPS / 2) return; // ticks that queued up while encoding
    last = now;
    try {
      recording.sample(now);
    } catch (err) {
      showError(`The recording stopped (${(err && err.message) || err}).`);
      stopGif(true);
      return;
    }
    const seconds = Math.floor((now - startedAt) / 1000);
    $('cap-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });
  $('cap-time').textContent = '0:00';
  $('cap-rec-hint').textContent = scrolling ? 'scroll over the picture' : 'scroll the shared tab now';
  $('cap-tools').hidden = true;
  $('cap-recbar').hidden = false;
  overlay.classList.add('is-recording');
  render();
}

function stopGif(save) {
  if (!recording) return;
  if (stopTicks) stopTicks();
  stopTicks = null;
  const done = recording;
  recording = null;
  $('cap-tools').hidden = false;
  $('cap-recbar').hidden = true;
  overlay.classList.remove('is-recording');
  render();
  if (!save) return;
  try {
    deliver(done.finish(performance.now()), 'gif');
  } catch (err) {
    showError(`Couldn’t save the GIF (${(err && err.message) || err}).`);
  }
}

$('cap-gif').addEventListener('click', startGif);
$('cap-rec-stop').addEventListener('click', () => stopGif(true));
$('cap-rec-cancel').addEventListener('click', () => stopGif(false));
