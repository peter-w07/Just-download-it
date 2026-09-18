/*
 * Just download it: GIF recordings of part of a tab (the job runner: the
 * offscreen document in Chrome, the background page in Firefox).
 *
 * The service worker hands over the box to record (CSS pixels, relative to
 * the tab's viewport) and one of two ways to see the tab:
 *  - streamId (Chrome): a tab-capture stream ID. We open the tab's video
 *    stream (getUserMedia with chromeMediaSource: 'tab'), keep only the
 *    newest frame it delivered, and a few times a second copy the box out of it.
 *  - tabId (Firefox, which has no tab capture): we take screenshots of the tab
 *    with tabs.captureTab, one after another at up to `fps` a second, each
 *    rendered at about the size the GIF needs, and copy the box out of each
 *    as it arrives, stamped with the time it was taken. This needs the tabs
 *    API, which the background page has.
 * Either way the box goes into a small canvas (at most maxWidth wide), then:
 *  - frames that didn't change are skipped, which makes the previous frame last longer
 *  - each frame is encoded with its own 256-colour palette as soon as the next
 *    one arrives (only the rectangle that changed is stored), and finished
 *    bytes move into Blobs as we go, so memory use stays flat however long it runs
 *
 * startRecording({ streamId | tabId, crop, fps, maxWidth, maxSeconds, onProgress })
 * resolves once the tab can be seen, with
 *   { done: Promise<Blob | null>, stop(), cancel() }
 * `done` resolves with the GIF after stop() (or maxSeconds, or the tab going
 * away), and with null after cancel(). onProgress(0..1) reports the encoding
 * still left to do after the recording stopped.
 * crop: { x, y, width, height, viewportWidth, viewportHeight, pixelRatio,
 * windowWidth?, windowHeight? } (the window's size with its scrollbars, which
 * screenshots include).
 */
import { GIFEncoder, applyPalette, quantize } from '../vendor/gifenc.mjs';

const DEFAULT_FPS = 10;
const MAX_FPS = 15;
const DEFAULT_MAX_WIDTH = 800;
const MAX_FRAME_PIXELS = 800 * 800;
const DEFAULT_MAX_SECONDS = 60;
const MAX_CAPTURE_SIDE = 3840;
// Frames waiting to be encoded. If encoding falls behind, frames are skipped
// (the previous one is shown longer) rather than piling up.
const MAX_QUEUED_BYTES = 96 * 1024 * 1024;
// Encoded bytes are moved into a Blob every so often; Chrome can keep big
// blobs on disk instead of in this document's memory.
const BLOB_FLUSH_BYTES = 8 * 1024 * 1024;
// The last frame stays up a little before the GIF loops, so the end is readable.
const MIN_LAST_FRAME_MS = 1000;
// Screenshots (Firefox) render the whole window; past this many pixels they
// are rendered smaller than the screen, so each one stays quick.
const MAX_SNAPSHOT_PIXELS = 4 * 1000 * 1000;
// A screenshot that fails this many times in a row ends the recording (the tab closed).
const MAX_SNAPSHOT_FAILURES = 3;

export async function startRecording({ streamId, tabId, crop, fps, maxWidth, maxSeconds, onProgress } = {}) {
  const snapshots = !streamId && Number.isInteger(tabId) && tabId >= 0;
  if (!streamId && !snapshots) throw new Error('Nothing to record.');
  const box = checkCrop(crop);
  const rate = clamp(Number(fps) || DEFAULT_FPS, 1, MAX_FPS);
  const widthLimit = clamp(Math.round(Number(maxWidth) || DEFAULT_MAX_WIDTH), 32, 4096);
  const seconds = clamp(Number(maxSeconds) || DEFAULT_MAX_SECONDS, 1, 10 * 60);
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  const { stream, source } = snapshots
    ? { stream: null, source: await openSnapshotSource({ tabId, box, rate, widthLimit }) }
    : await openTabStream(streamId, box);
  const recording = new Recording({ stream, source, box, rate, widthLimit, seconds, report });
  recording.begin();
  return {
    done: recording.done,
    stop: () => recording.stop(),
    cancel: () => recording.cancel(),
  };
}

/** Chrome: the tab's video stream, and the newest-frame holder over it. */
async function openTabStream(streamId, box) {
  const ratio = clamp(Number(box.pixelRatio) || 1, 0.25, 8);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxFrameRate: 30,
          maxWidth: clamp(Math.round(box.viewportWidth * ratio), 64, MAX_CAPTURE_SIDE),
          maxHeight: clamp(Math.round(box.viewportHeight * ratio), 64, MAX_CAPTURE_SIDE),
        },
      },
    });
  } catch (err) {
    const reason = (err && (err.message || err.name)) || String(err);
    throw new Error(`Couldn’t record this tab (${reason}).`);
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopTracks(stream);
    throw new Error('Couldn’t record this tab (no video).');
  }

  try {
    return { stream, source: await openFrameSource(stream, track) };
  } catch (err) {
    stopTracks(stream);
    throw err;
  }
}

class Recording {
  constructor({ stream, source, box, rate, widthLimit, seconds, report }) {
    this.stream = stream;
    this.source = source;
    this.box = box;
    this.interval = 1000 / rate;
    this.widthLimit = widthLimit;
    this.seconds = seconds;
    this.report = report;

    this.stopping = false;
    this.canceled = false;
    this.stoppedAt = 0;
    this.timers = [];

    // Sampling
    this.canvas = null;
    this.ctx = null;
    this.width = 0;
    this.height = 0;
    this.previous = null; // RGBA of the last frame kept
    this.pending = null; // { data, rect, at }: kept, waiting to learn how long it lasts
    this.firstAt = 0;

    // Encoding
    this.queue = []; // { data, rect, at, until }
    this.queuedBytes = 0;
    this.wakeSampler = null;
    this.wakeEncoder = null;
    this.finishedQueueing = false;
    this.totalAtStop = 0;
    this.encoder = GIFEncoder({ auto: false });
    this.frames = 0;
    this.shownCs = 0; // centiseconds of animation written so far
    this.chunks = [];
    this.chunkBytes = 0;
    this.parts = [];

    this.done = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  begin() {
    this.timers.push(setTimeout(() => this.stop(), this.seconds * 1000));
    this.source.onEnded = () => this.stop();
    this.run().then(this.resolve, (err) => {
      this.release();
      this.reject(err);
    });
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.stoppedAt = performance.now();
    if (this.wakeSampler) this.wakeSampler();
    if (this.wakeEncoder) this.wakeEncoder();
  }

  cancel() {
    this.canceled = true;
    this.stop();
    this.release();
  }

  /** Stop the tab capture right away (Chrome's "recording" indicator goes with it). */
  release() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.source.close();
    if (this.stream) stopTracks(this.stream);
  }

  async run() {
    const encoding = this.encodeLoop();
    encoding.catch(() => this.stop()); // rethrown below
    const pulled = typeof this.source.pull === 'function';
    if (pulled) {
      await this.pullFrames();
    } else {
      // Sample on a steady clock. Encoding runs in between, on the same thread,
      // so a late tick just uses the time it actually ran.
      let next = performance.now();
      while (!this.stopping) {
        next += this.interval;
        await this.sleep(Math.max(0, next - performance.now()));
        if (this.stopping) break;
        if (next < performance.now() - this.interval) next = performance.now(); // fell behind: don't burst
        if (this.queuedBytes <= MAX_QUEUED_BYTES) this.sample(performance.now());
      }
    }
    if (this.canceled) {
      this.queue = [];
      this.queuedBytes = 0;
      if (this.wakeEncoder) this.wakeEncoder();
      await encoding.catch(() => {});
      return null;
    }
    // Whatever is on screen when the user pressed stop is the last frame
    // (screenshots: the last one taken, at most one interval earlier).
    if (!pulled) this.sample(this.stoppedAt, { final: true });
    this.release();
    if (this.pending) {
      const until = Math.max(this.stoppedAt, this.pending.at + MIN_LAST_FRAME_MS);
      this.enqueue({ ...this.pending, until });
      this.pending = null;
    }
    this.finishedQueueing = true;
    this.totalAtStop = this.frames + this.queue.length;
    if (this.wakeEncoder) this.wakeEncoder();
    await encoding;
    if (this.canceled) return null;
    if (!this.frames) throw new Error('Nothing was recorded. Try again.');
    this.flushChunks();
    const blob = new Blob([...this.parts, new Uint8Array([0x3b])], { type: 'image/gif' });
    this.parts = [];
    this.report(1);
    return blob;
  }

  sleep(ms) {
    return new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        clearTimeout(timer);
        if (this.wakeSampler === done) this.wakeSampler = null;
        resolve();
      };
      timer = setTimeout(done, ms);
      this.wakeSampler = done;
    });
  }

  /**
   * Screenshots: take frames as the source hands them over (it paces
   * itself), each stamped with when it was taken. Ends with the recording,
   * or when the tab is gone (keeping what was recorded).
   */
  async pullFrames() {
    while (!this.stopping) {
      const frame = await this.source.pull();
      if (!frame) {
        this.stop();
        break;
      }
      if (this.stopping || this.queuedBytes > MAX_QUEUED_BYTES) frame.release();
      else this.sampleFrame(frame, frame.at);
    }
  }

  /** Copy the box out of the newest frame, if there is a new one. */
  sample(now, { final = false } = {}) {
    const frame = this.source.take({ force: final });
    if (frame) this.sampleFrame(frame, now);
  }

  sampleFrame(frame, now) {
    try {
      const fw = frame.width;
      const fh = frame.height;
      if (!fw || !fh) return;
      const { x, y, width, height, viewportWidth, viewportHeight } = this.box;
      // The captured video keeps the tab's aspect ratio; if it ever doesn't,
      // Chrome letterboxes it, so map the viewport onto the centred content.
      const scale = Math.min(fw / viewportWidth, fh / viewportHeight);
      const offsetX = (fw - viewportWidth * scale) / 2;
      const offsetY = (fh - viewportHeight * scale) / 2;
      if (!this.canvas) this.setUpCanvas(width * scale, height * scale);
      const ctx = this.ctx;
      ctx.drawImage(frame.image, offsetX + x * scale, offsetY + y * scale, width * scale, height * scale, 0, 0, this.width, this.height);
    } finally {
      frame.release();
    }
    const data = this.ctx.getImageData(0, 0, this.width, this.height).data;
    const rect = this.previous ? changedRect(this.previous, data, this.width, this.height) : { x: 0, y: 0, width: this.width, height: this.height };
    if (!rect) return; // identical: the pending frame just lasts longer
    if (this.pending) this.enqueue({ ...this.pending, until: now });
    else this.firstAt = now;
    this.pending = { data, rect, at: now };
    this.previous = data;
  }

  setUpCanvas(sourceWidth, sourceHeight) {
    let scale = Math.min(1, this.widthLimit / sourceWidth, Math.sqrt(MAX_FRAME_PIXELS / (sourceWidth * sourceHeight)));
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    this.width = clamp(Math.round(sourceWidth * scale), 1, 65535);
    this.height = clamp(Math.round(sourceHeight * scale), 1, 65535);
    this.canvas = new OffscreenCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  enqueue(item) {
    this.queue.push(item);
    this.queuedBytes += item.data.byteLength;
    if (this.wakeEncoder) this.wakeEncoder();
  }

  async encodeLoop() {
    for (;;) {
      if (this.canceled) return;
      const item = this.queue.shift();
      if (!item) {
        if (this.finishedQueueing) return;
        await new Promise((resolve) => {
          this.wakeEncoder = () => {
            this.wakeEncoder = null;
            resolve();
          };
        });
        continue;
      }
      this.queuedBytes -= item.data.byteLength;
      this.encodeFrame(item);
      if (this.finishedQueueing && this.totalAtStop) this.report(Math.min(0.99, this.frames / this.totalAtStop));
      // Let sampling ticks and messages in between frames.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  encodeFrame({ data, rect, at, until }) {
    const first = this.frames === 0;
    const full = rect.x === 0 && rect.y === 0 && rect.width === this.width && rect.height === this.height;
    const pixels = full ? data : cropPixels(data, this.width, rect);

    // GIF delays are in centiseconds. Work from the running total so rounding
    // doesn't drift; browsers show delays under 2cs as 10cs, so never go below 2.
    const endCs = Math.round((until - this.firstAt) / 10);
    const delayCs = Math.max(2, endCs - this.shownCs);
    this.shownCs += delayCs;

    // rgb444 buckets make the palette search ~10x faster than rgb565, and
    // matching pixels to it in rgb565 keeps gradients smooth.
    const palette = quantize(pixels, 256, { format: 'rgb444' });
    const index = applyPalette(pixels, palette, 'rgb565');

    const enc = this.encoder;
    enc.reset();
    if (first) enc.writeHeader();
    enc.writeFrame(index, rect.width, rect.height, {
      palette,
      first,
      delay: delayCs * 10,
      repeat: 0,
      dispose: 1, // keep the previous frame; this one only covers what changed
    });
    const bytes = enc.bytes();
    if (!first) {
      // gifenc always places frames at 0,0. The image descriptor follows the
      // 8-byte graphic control extension: 0x2C, left (2 bytes), top (2 bytes).
      if (bytes[8] !== 0x2c) throw new Error('GIF encoder output changed.');
      bytes[9] = rect.x & 0xff;
      bytes[10] = (rect.x >> 8) & 0xff;
      bytes[11] = rect.y & 0xff;
      bytes[12] = (rect.y >> 8) & 0xff;
    }
    this.chunks.push(bytes);
    this.chunkBytes += bytes.byteLength;
    this.frames++;
    if (this.chunkBytes >= BLOB_FLUSH_BYTES) this.flushChunks();
  }

  flushChunks() {
    if (!this.chunks.length) return;
    this.parts.push(new Blob(this.chunks));
    this.chunks = [];
    this.chunkBytes = 0;
  }
}

// ---------------------------------------------------------------------------
// Frames from the stream
// ---------------------------------------------------------------------------

/**
 * Newest-frame holder over the stream. take() returns { image, width, height,
 * release() } when a frame arrived since the last take (or always, with force).
 */
async function openFrameSource(stream, track) {
  if (typeof MediaStreamTrackProcessor === 'function') {
    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    const source = {
      onEnded: null,
      latest: null,
      fresh: false,
      closed: false,
      take({ force = false } = {}) {
        if (!this.latest || (!this.fresh && !force)) return null;
        this.fresh = false;
        const frame = this.latest;
        return { image: frame, width: frame.displayWidth, height: frame.displayHeight, release() {} };
      },
      close() {
        if (this.closed) return;
        this.closed = true;
        reader.cancel().catch(() => {});
        if (this.latest) this.latest.close();
        this.latest = null;
      },
    };
    (async () => {
      for (;;) {
        let result;
        try {
          result = await reader.read();
        } catch {
          break;
        }
        if (result.done) break;
        if (source.closed) {
          result.value.close();
          break;
        }
        if (source.latest) source.latest.close();
        source.latest = result.value;
        source.fresh = true;
      }
      if (!source.closed && source.onEnded) source.onEnded();
    })();
    return source;
  }

  // Older Chrome: read frames through a <video> element.
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  track.addEventListener('ended', () => {
    if (source.onEnded) source.onEnded();
  });
  const source = {
    onEnded: null,
    take() {
      if (video.readyState < 2) return null;
      return { image: video, width: video.videoWidth, height: video.videoHeight, release() {} };
    },
    close() {
      video.pause();
      video.srcObject = null;
    },
  };
  return source;
}

// ---------------------------------------------------------------------------
// Frames from screenshots (Firefox)
// ---------------------------------------------------------------------------

/**
 * Screenshots of the tab, for a browser without tab capture. pull() waits
 * for its turn (at most `rate` a second, and never while the previous
 * screenshot is still being taken), takes one and resolves with
 * { image, width, height, at, release() }, or with null once the source is
 * closed or the tab is gone. width × height is the viewport's part of the
 * image (a screenshot also shows the scrollbars, to the right and below).
 *
 * Screenshots render the page afresh, so they're asked for at the scale the
 * GIF needs: the box comes out at about its final size and nothing is
 * rendered only to be scaled down. The page's zoom multiplies whatever scale
 * we ask for, so it's measured once, from a first screenshot at scale 1.
 * PNG, not JPEG: it's about as quick, and it keeps text and edges exact
 * instead of blurring them for the 256-colour palette to spend colours on.
 *
 * Measured in Firefox 156 on a 1280 × 800 YouTube watch page, rendered at
 * 800 px wide: 50–60 ms per screenshot (PNG or JPEG alike), so a recording
 * gets about 8 frames a second, and the page kept its 60 fps while scrolling.
 */
async function openSnapshotSource({ tabId, box, rate, widthLimit }) {
  const tabs = globalThis.chrome && chrome.tabs;
  if (!tabs || typeof tabs.captureTab !== 'function') throw new Error('Couldn’t record this tab (no screenshots).');
  const windowWidth = Math.max(box.viewportWidth, Number(box.windowWidth) || 0);
  const windowHeight = Math.max(box.viewportHeight, Number(box.windowHeight) || 0);
  const grab = async (scale) => {
    const dataUrl = await tabs.captureTab(tabId, { format: 'png', scale });
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('empty screenshot');
    const blob = await (await fetch(dataUrl)).blob();
    return createImageBitmap(blob);
  };

  let zoom;
  try {
    const first = await grab(1);
    zoom = first.width / windowWidth;
    first.close();
  } catch (err) {
    const reason = (err && (err.message || err.name)) || String(err);
    throw new Error(`Couldn’t record this tab (${reason}).`);
  }
  if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1;

  // Screenshot pixels per CSS px: the screen's, or less when the GIF is smaller.
  const ratio = clamp(Number(box.pixelRatio) || 1, 0.25, 8);
  const wanted = Math.min(
    ratio,
    widthLimit / box.width,
    Math.sqrt(MAX_FRAME_PIXELS / (box.width * box.height)),
    Math.sqrt(MAX_SNAPSHOT_PIXELS / (windowWidth * windowHeight)),
  );
  const scale = clamp(wanted / zoom, 0.05, 8);
  const interval = 1000 / rate;

  let closed = false;
  let failures = 0;
  let nextAt = 0;
  let wake = null;
  const rest = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });

  return {
    async pull() {
      while (!closed) {
        const wait = nextAt - performance.now();
        if (wait > 0) await rest(wait);
        if (closed) return null;
        const at = performance.now();
        nextAt = at + interval;
        let image;
        try {
          image = await grab(scale);
        } catch {
          // The tab closed, or it's between two pages: try again a few times.
          if (++failures >= MAX_SNAPSHOT_FAILURES) return null;
          continue;
        }
        failures = 0;
        if (closed) {
          image.close();
          return null;
        }
        const s = image.width / windowWidth; // what we actually got
        return {
          image,
          width: box.viewportWidth * s,
          height: box.viewportHeight * s,
          at,
          release: () => image.close(),
        };
      }
      return null;
    },
    close() {
      closed = true;
      if (wake) wake();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The smallest rectangle containing every pixel that differs, or null if none do. */
function changedRect(a, b, width, height) {
  const pa = new Uint32Array(a.buffer, a.byteOffset, width * height);
  const pb = new Uint32Array(b.buffer, b.byteOffset, width * height);
  let top = -1;
  for (let y = 0; y < height && top < 0; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (pa[row + x] !== pb[row + x]) {
        top = y;
        break;
      }
    }
  }
  if (top < 0) return null;
  let bottom = top;
  for (let y = height - 1; y > top; y--) {
    const row = y * width;
    let differs = false;
    for (let x = 0; x < width; x++) {
      if (pa[row + x] !== pb[row + x]) {
        differs = true;
        break;
      }
    }
    if (differs) {
      bottom = y;
      break;
    }
  }
  let left = width;
  let right = -1;
  for (let y = top; y <= bottom; y++) {
    const row = y * width;
    for (let x = 0; x < left; x++) {
      if (pa[row + x] !== pb[row + x]) {
        left = x;
        break;
      }
    }
    for (let x = width - 1; x > right; x--) {
      if (pa[row + x] !== pb[row + x]) {
        right = x;
        break;
      }
    }
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function cropPixels(data, width, rect) {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const start = ((rect.y + row) * width + rect.x) * 4;
    out.set(data.subarray(start, start + rect.width * 4), row * rect.width * 4);
  }
  return out;
}

function checkCrop(crop) {
  const c = crop && typeof crop === 'object' ? crop : {};
  const box = {
    x: Number(c.x),
    y: Number(c.y),
    width: Number(c.width),
    height: Number(c.height),
    viewportWidth: Number(c.viewportWidth),
    viewportHeight: Number(c.viewportHeight),
    pixelRatio: Number(c.pixelRatio) || 1,
    windowWidth: Number(c.windowWidth) || 0,
    windowHeight: Number(c.windowHeight) || 0,
  };
  const ok =
    [box.x, box.y, box.width, box.height, box.viewportWidth, box.viewportHeight].every(Number.isFinite) &&
    box.width >= 1 &&
    box.height >= 1 &&
    box.viewportWidth >= 1 &&
    box.viewportHeight >= 1;
  if (!ok) throw new Error('Nothing to record.');
  return box;
}

function stopTracks(stream) {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
