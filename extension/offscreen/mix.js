/*
 * Just download it: "Combine into one mix" (offscreen document).
 *
 * Job: { type: 'mix', format: 'mp3' | 'm4a', crossfade: seconds, normalize,
 *        bitrate?: kbps (MP3), tags?: { title, artist, album, coverUrl… },
 *        entries: [{ url?, job?, title, artist }] }
 *
 * One continuous audio file from a playlist or album, song by song:
 *  1. Find the audio: a song job is looked up by the service worker
 *     (jdi:resolve-song) and its audio track used; an mp3/mux job's audio
 *     track is used; anything else uses the entry's url.
 *  2. Download the whole file in ranged requests of up to 8 MB (googlevideo
 *     only serves ranges reliably), without cookies. The next song downloads
 *     while the current one is decoded and encoded.
 *  3. Decode it with Web Audio (decodeAudioData resamples to 48 kHz), keep
 *     two channels, trim the silence at both ends (below -50 dBFS) and, with
 *     `normalize`, turn it up or down toward a common loudness (gated RMS,
 *     at most ±6 dB) without letting its peaks clip: a boost stops at the
 *     peak ceiling, and everything goes through a soft limiter.
 *  4. Stream it into the encoder in 1 s blocks. The last `crossfade` seconds
 *     are held back and faded (equal power) into the start of the next song;
 *     short songs get a shorter fade. Only one decoded song plus that short
 *     tail is in memory at any time.
 *  5. With tags, the audio is first encoded to a temporary file, then copied
 *     (not re-encoded) into the output with the tags, because the tracklist
 *     comment ("m:ss Artist – Title" per line, at the real start times after
 *     trims and fades) is only known at the end, and tags must be set before
 *     an output starts. Without tags it is encoded straight into the output.
 *
 * Songs that fail are skipped and mentioned in `note`; the job fails only when
 * no song works.
 *
 * Exports:
 *   buildMix(job, writable, progress, tools)  -> { note }
 *   analyzeSong, Mixer, formatTracklist        pure helpers (also used by tests)
 */
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferSource,
  Conversion,
  Input,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  canEncodeAudio,
} from '../vendor/media.mjs';

export const MAX_MIX_ENTRIES = 200;
export const SAMPLE_RATE = 48000;
const BLOCK_FRAMES = SAMPLE_RATE; // 1 s AudioSamples
const RANGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
// A decoded song is 48000 × 2 × 4 bytes per second (~23 MB a minute).
const MAX_SONG_SECONDS = 30 * 60;
const MAX_CROSSFADE_SECONDS = 12;

const SILENCE_DB = -50;
const TARGET_LOUDNESS_DB = -13; // gated RMS, roughly where streaming services play songs
const MAX_GAIN_DB = 6;
const PEAK_CEILING = 0.95;
const LIMITER_KNEE = 0.95;

// Progress within one song.
const SHARE_DOWNLOAD = 0.4;
const SHARE_DECODE = 0.1; // the rest is encoding
// With tags, the final copy into the output is the last few percent.
const SHARE_TAGGING = 0.04;

/**
 * @param job       see above
 * @param writable  the output file (FileSystemWritableFileStream)
 * @param progress  (0..1) => void
 * @param tools     { workDir(), resolveSong(job), loadTags(raw), ensureMp3Encoder(), checkCancelled(), isCancelled(), friendly(err) }
 */
export async function buildMix(job, writable, progress, tools) {
  const entries = Array.isArray(job && job.entries) ? job.entries.filter((e) => e && typeof e === 'object') : [];
  if (!entries.length) throw new Error('Nothing to combine.');
  if (entries.length > MAX_MIX_ENTRIES) throw new Error(`A mix can combine up to ${MAX_MIX_ENTRIES} songs.`);
  const format = job.format === 'm4a' ? 'm4a' : 'mp3';
  const fadeSeconds = Math.min(MAX_CROSSFADE_SECONDS, Math.max(0, Number(job.crossfade) || 0));
  const normalize = !!job.normalize;
  const withTags = !!(job.tags && typeof job.tags === 'object');
  const encoding = await encodingFor(format, job.bitrate, tools);

  const total = entries.length;
  const fractions = new Float64Array(total);
  const encodeShare = withTags ? 1 - SHARE_TAGGING : 0.99;
  const report = () => {
    let sum = 0;
    for (const f of fractions) sum += f;
    progress(Math.min(encodeShare, (sum / total) * encodeShare));
  };
  const setFraction = (i, f) => {
    fractions[i] = Math.max(fractions[i], Math.min(1, f));
    report();
  };

  // Encode straight into the output, or into a temporary file to tag afterwards.
  let temp = null;
  if (withTags) {
    const dir = await tools.workDir();
    const handle = await dir.getFileHandle(`mix.${format}`, { create: true });
    temp = { dir, handle, name: `mix.${format}`, writable: await handle.createWritable() };
  }
  const aborter = new AbortController();
  let output = null;
  let source = null;
  let framesEncoded = 0;

  /** Called by the mixer with ready-to-encode blocks (planar, 2 channels). */
  const encodeBlock = async (planar, frames) => {
    tools.checkCancelled();
    if (!output) {
      output = new Output({
        format: format === 'mp3' ? new Mp3OutputFormat() : new Mp4OutputFormat({ fastStart: false }),
        target: new StreamTarget(temp ? temp.writable : writable, { chunked: true }),
      });
      source = new AudioSampleSource(encoding);
      output.addAudioTrack(source);
      await output.start();
    }
    const sample = new AudioSample({
      data: planar,
      format: 'f32-planar',
      numberOfChannels: 2,
      sampleRate: SAMPLE_RATE,
      timestamp: framesEncoded / SAMPLE_RATE,
    });
    framesEncoded += frames;
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
  };

  const mixer = new Mixer({ fadeFrames: Math.round(fadeSeconds * SAMPLE_RATE), write: encodeBlock });
  const tracklist = [];
  const failures = [];
  const downloads = new Map();
  const startDownload = (i) => {
    if (i >= total || downloads.has(i)) return;
    const task = loadEntry(entries[i], tools, aborter.signal, (f) => setFraction(i, f * SHARE_DOWNLOAD)).then(
      (bytes) => ({ ok: true, bytes }),
      (err) => ({ ok: false, error: err }),
    );
    downloads.set(i, task);
  };

  try {
    for (let i = 0; i < total; i++) {
      tools.checkCancelled();
      const entry = entries[i];
      startDownload(i);
      const loaded = await downloads.get(i);
      downloads.delete(i);
      startDownload(i + 1);
      // A song that can't be found, downloaded or decoded is left out...
      let left = null;
      let right = null;
      try {
        if (!loaded.ok) throw loaded.error;
        tools.checkCancelled();
        const song = await decodeSong(loaded.bytes);
        loaded.bytes = null;
        setFraction(i, SHARE_DOWNLOAD + SHARE_DECODE * 0.7);
        const { start, end, gain } = analyzeSong(song.left, song.right, { normalize });
        applyGain(song.left, song.right, start, end, gain);
        setFraction(i, SHARE_DOWNLOAD + SHARE_DECODE);
        left = song.left.subarray(start, end);
        right = song.right.subarray(start, end);
      } catch (err) {
        if (tools.isCancelled()) throw err;
        failures.push({ entry, error: tools.friendly(err) });
        setFraction(i, 1);
        continue;
      }
      // ...but an encoder or disk error ends the whole mix.
      const at = await mixer.add(left, right, (done) => setFraction(i, SHARE_DOWNLOAD + SHARE_DECODE + (1 - SHARE_DOWNLOAD - SHARE_DECODE) * done));
      left = right = null;
      tracklist.push({ seconds: at / SAMPLE_RATE, title: String(entry.title || ''), artist: String(entry.artist || '') });
      setFraction(i, 1);
    }
    tools.checkCancelled();
    if (!tracklist.length) {
      const first = failures[0] ? failures[0].error : 'Nothing to combine.';
      throw new Error(`None of the songs could be added to the mix. ${first}`);
    }
    await mixer.finish();
    source.close();
    await output.finalize();

    if (temp) {
      await closeQuietly(temp.writable);
      temp.writable = null;
      const tags = { ...((await tools.loadTags(job.tags)) || {}) };
      const comment = formatTracklist(tracklist);
      if (comment) tags.comment = comment;
      await copyWithTags(await temp.handle.getFile(), format, tags, writable, (p) => progress(encodeShare + SHARE_TAGGING * p));
      await temp.dir.removeEntry(temp.name).catch(() => {});
    }
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    if (temp && temp.writable) await temp.writable.abort().catch(() => {});
    throw err;
  } finally {
    aborter.abort();
  }

  return { note: failureNote(failures) };
}

function failureNote(failures) {
  if (!failures.length) return '';
  if (failures.length === 1) {
    const { title, artist } = failures[0].entry;
    const name = title ? `“${artist ? `${artist} – ` : ''}${title}”` : '1 song';
    return `${name} couldn’t be added and was left out of the mix.`;
  }
  return `${failures.length} songs couldn’t be added and were left out of the mix.`;
}

/** "0:00 Artist – Title" per line. */
export function formatTracklist(list) {
  return list
    .map(({ seconds, title, artist }) => {
      const s = Math.max(0, Math.floor(seconds));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = String(s % 60).padStart(2, '0');
      const time = h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
      const name = [artist, title].filter(Boolean).join(' – ') || 'Unknown song';
      return `${time} ${name}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

async function encodingFor(format, kbps, tools) {
  if (format === 'mp3') {
    await tools.ensureMp3Encoder();
    const rate = Math.min(320, Math.max(64, Math.round(Number(kbps) || 256)));
    return { codec: 'mp3', bitrate: rate * 1000 };
  }
  // Chrome's AAC encoder (Media Foundation on Windows) only takes a few bitrates.
  for (const bitrate of [256000, 192000, 160000, 128000]) {
    if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: SAMPLE_RATE, bitrate }).catch(() => false)) {
      return { codec: 'aac', bitrate };
    }
  }
  throw new Error('This computer can’t make M4A files. Choose MP3 for mixes in the extension’s settings.');
}

/** Copy the encoded mix into `writable` with its tags (no re-encoding). */
async function copyWithTags(file, format, tags, writable, progress) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const output = new Output({
      format: format === 'mp3' ? new Mp3OutputFormat() : new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(writable, { chunked: true }),
    });
    const conversion = await Conversion.init({ input, output, tags });
    if (!conversion.isValid) throw new Error('Couldn’t write the mix’s tags.');
    conversion.onProgress = (p) => progress(Math.min(1, p));
    await conversion.execute();
  } finally {
    input.dispose();
  }
}

// ---------------------------------------------------------------------------
// Download and decode
// ---------------------------------------------------------------------------

/** The entry's audio file, fully downloaded. */
async function loadEntry(entry, tools, signal, onFraction) {
  let url = entry.url;
  const job = entry.job && typeof entry.job === 'object' ? entry.job : null;
  if (job && job.type === 'song') {
    const resolved = await tools.resolveSong(job);
    url = resolved.audio;
  } else if (job && (job.type === 'mp3' || job.type === 'mux') && job.audio && !job.video) {
    url = job.audio;
  }
  onFraction(0.02);
  try {
    return await downloadAll(url, signal, onFraction);
  } catch (err) {
    // A song's stream link is tied to time and place; a stale one answers 403.
    // Look the song up again once and start its download over.
    if (!job || job.type !== 'song' || tools.isCancelled() || !/\b403\b|forbidden|expired/i.test(String((err && err.message) || err))) throw err;
    const again = await tools.resolveSong(job, { refresh: true });
    onFraction(0.02);
    return downloadAll(again.audio, signal, onFraction);
  }
}

/**
 * Whole file in ranged requests (≤ 8 MB each), no cookies. Plain links may be
 * public http(s) or data: audio (the service worker checked them).
 */
async function downloadAll(url, signal, onFraction) {
  if (!/^(https?:|data:(audio|video)\/)/i.test(String(url || ''))) throw new Error('Unsupported media URL.');
  let total = 0;
  try {
    total = Number(new URL(url).searchParams.get('clen')) || 0; // googlevideo tells the length up front
  } catch {
    /* checked above */
  }
  const pieces = [];
  let received = 0;
  for (;;) {
    const end = received + RANGE_BYTES - 1;
    const res = await fetchRange(url, received, total ? Math.min(end, total - 1) : end, signal);
    if (res.status === 200) {
      // No range support: the whole file in one response.
      if (received) throw new Error('The server stopped allowing partial downloads.');
      const length = Number(res.headers.get('content-length')) || 0;
      if (length > MAX_AUDIO_BYTES) throw new Error('The audio file is too large for a mix.');
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pieces.push(value);
        received += value.byteLength;
        if (received > MAX_AUDIO_BYTES) {
          reader.cancel().catch(() => {});
          throw new Error('The audio file is too large for a mix.');
        }
        if (length) onFraction(Math.min(0.99, received / length));
      }
      break;
    }
    const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    if (range) total = Number(range[1]);
    if (total > MAX_AUDIO_BYTES) throw new Error('The audio file is too large for a mix.');
    const piece = new Uint8Array(await res.arrayBuffer());
    pieces.push(piece);
    received += piece.byteLength;
    if (total) onFraction(Math.min(0.99, received / total));
    if (!piece.byteLength || (total && received >= total) || (!total && piece.byteLength < RANGE_BYTES)) break;
    if (received > MAX_AUDIO_BYTES) throw new Error('The audio file is too large for a mix.');
  }
  if (!received) throw new Error('The audio file was empty.');
  if (total && received < total) throw new Error('Network problem: the download was cut short.');
  if (pieces.length === 1) return pieces[0];
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const piece of pieces) {
    bytes.set(piece, at);
    at += piece.byteLength;
  }
  return bytes;
}

async function fetchRange(url, from, to, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'no-store', headers: { Range: `bytes=${from}-${to}` }, signal });
      if (res.status === 206 || (res.status === 200 && from === 0)) return res;
      if (res.status === 416 && from > 0) return new Response(new Uint8Array(0), { status: 206 });
      const err = new Error(`HTTP ${res.status}`);
      if (res.status < 500 || attempt >= 3) throw err;
    } catch (err) {
      if (signal.aborted || attempt >= 3 || /^HTTP [1-4]/.test(String(err && err.message))) throw err;
    }
    await new Promise((r) => setTimeout(r, 700 * attempt));
  }
}

/** { left, right } Float32Arrays at 48 kHz (mono is used for both sides). */
async function decodeSong(bytes) {
  // Check the length first: decoding a very long file would need gigabytes.
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const seconds = (await input.getDurationFromMetadata().catch(() => null)) || (await input.computeDuration().catch(() => 0));
    if (seconds > MAX_SONG_SECONDS) throw new Error(`It’s longer than ${MAX_SONG_SECONDS / 60} minutes, too long for a mix.`);
  } finally {
    input.dispose();
  }
  const context = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  let buffer;
  try {
    buffer = await context.decodeAudioData(bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer);
  } catch {
    throw new Error('Couldn’t decode this song’s audio.');
  }
  if (!buffer.length) throw new Error('The song had no audio.');
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return { left, right };
}

// ---------------------------------------------------------------------------
// Trim and loudness
// ---------------------------------------------------------------------------

const WINDOW_FRAMES = 480; // 10 ms
const BLOCK_WINDOWS = 40; // 400 ms loudness blocks

/**
 * Where the song really starts and ends, and the gain to apply.
 * @returns { start, end, gain, loudnessDb, peak }
 */
export function analyzeSong(left, right, { normalize = true } = {}) {
  const n = left.length;
  const windows = Math.ceil(n / WINDOW_FRAMES);
  const power = new Float32Array(windows);
  const silence = Math.pow(10, SILENCE_DB / 10); // mean square at -50 dBFS
  let first = -1;
  let last = -1;
  for (let w = 0; w < windows; w++) {
    const from = w * WINDOW_FRAMES;
    const to = Math.min(n, from + WINDOW_FRAMES);
    let sum = 0;
    for (let k = from; k < to; k++) sum += left[k] * left[k];
    if (right !== left) for (let k = from; k < to; k++) sum += right[k] * right[k];
    else sum *= 2;
    const ms = sum / (2 * (to - from));
    power[w] = ms;
    if (ms > silence) {
      if (first < 0) first = w;
      last = w;
    }
  }
  if (first < 0) throw new Error('The song was silent.');
  // Keep 10 ms either side so attacks and releases aren't clipped.
  const start = Math.max(0, (first - 1) * WINDOW_FRAMES);
  const end = Math.min(n, (last + 2) * WINDOW_FRAMES);

  let peak = 0;
  for (let k = start; k < end; k++) {
    const a = left[k] < 0 ? -left[k] : left[k];
    if (a > peak) peak = a;
  }
  if (right !== left) {
    for (let k = start; k < end; k++) {
      const a = right[k] < 0 ? -right[k] : right[k];
      if (a > peak) peak = a;
    }
  }

  // Loudness: mean power of the 400 ms blocks that aren't near-silent, gated
  // relative to the song's own level (like EBU R128, without the weighting).
  const blocks = [];
  for (let w = Math.floor(start / WINDOW_FRAMES); w < Math.ceil(end / WINDOW_FRAMES); w += BLOCK_WINDOWS) {
    let sum = 0;
    let count = 0;
    for (let j = w; j < Math.min(w + BLOCK_WINDOWS, windows); j++) {
      sum += power[j];
      count++;
    }
    if (count) blocks.push(sum / count);
  }
  const audible = blocks.filter((b) => b > 1e-7); // -70 dBFS
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  let loudnessDb = -70;
  if (audible.length) {
    const ungated = mean(audible);
    const gated = audible.filter((b) => b > ungated * 0.1); // within 10 dB of the average
    loudnessDb = 10 * Math.log10(gated.length ? mean(gated) : ungated);
  }

  let gain = 1;
  if (normalize) {
    const db = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, TARGET_LOUDNESS_DB - loudnessDb));
    gain = Math.pow(10, db / 20);
  }
  // A boost never pushes the peaks past the ceiling. Peaks that are already
  // over it (common after decoding lossy audio) are left to the mixer's soft
  // limiter, so a song that is already at the target isn't turned down for them.
  if (gain > 1 && peak * gain > PEAK_CEILING) gain = Math.max(1, PEAK_CEILING / peak);
  return { start, end, gain, loudnessDb, peak };
}

function applyGain(left, right, start, end, gain) {
  if (Math.abs(gain - 1) < 1e-4) return;
  for (let k = start; k < end; k++) left[k] *= gain;
  if (right !== left) for (let k = start; k < end; k++) right[k] *= gain;
}

// ---------------------------------------------------------------------------
// Crossfading mixer
// ---------------------------------------------------------------------------

/**
 * Joins songs into one stream of 1 s planar blocks.
 * add(left, right) returns the frame where that song starts in the mix (the
 * start of its fade-in). Each song's last `fadeFrames` (at most a third of the
 * song) are held back until the next song arrives, then crossfaded with equal
 * power: out = previous · cos(t·π/2) + next · sin(t·π/2).
 */
export class Mixer {
  constructor({ fadeFrames = 0, write, blockFrames = BLOCK_FRAMES }) {
    this.fadeFrames = Math.max(0, Math.floor(fadeFrames));
    this.write = write;
    this.blockFrames = blockFrames;
    this.block = null;
    this.fill = 0;
    this.written = 0; // frames handed to push so far (the mix's timeline)
    this.tail = null;
  }

  async add(left, right, onProgress) {
    const n = left.length;
    let skip = 0;
    let start = this.written;
    if (this.tail) {
      const [tl, tr] = this.tail;
      this.tail = null;
      const fade = Math.min(tl.length, Math.floor(n / 3));
      await this.push(tl.subarray(0, tl.length - fade), tr.subarray(0, tr.length - fade));
      start = this.written;
      if (fade) {
        const outL = new Float32Array(fade);
        const outR = new Float32Array(fade);
        const offset = tl.length - fade;
        for (let k = 0; k < fade; k++) {
          const t = ((k + 0.5) / fade) * (Math.PI / 2);
          const down = Math.cos(t);
          const up = Math.sin(t);
          outL[k] = tl[offset + k] * down + left[k] * up;
          outR[k] = tr[offset + k] * down + right[k] * up;
        }
        await this.push(outL, outR);
        skip = fade;
      }
    }
    const hold = Math.min(this.fadeFrames, Math.floor(n / 3));
    const bodyEnd = n - hold;
    const step = this.blockFrames * 10;
    for (let at = skip; at < bodyEnd; at += step) {
      const to = Math.min(bodyEnd, at + step);
      await this.push(left.subarray(at, to), right.subarray(at, to));
      if (onProgress) onProgress(to / n);
    }
    // A copy, so the whole decoded song can be let go.
    this.tail = hold ? [left.slice(bodyEnd), right.slice(bodyEnd)] : null;
    return start;
  }

  async finish() {
    if (this.tail) {
      const [tl, tr] = this.tail;
      this.tail = null;
      await this.push(tl, tr);
    }
    if (this.fill) {
      const frames = this.fill;
      const out = new Float32Array(frames * 2);
      out.set(this.block.subarray(0, frames), 0);
      out.set(this.block.subarray(this.blockFrames, this.blockFrames + frames), frames);
      this.block = null;
      this.fill = 0;
      await this.write(out, frames);
    }
  }

  /** Append frames (soft-limited) and write out every full block. */
  async push(left, right) {
    const n = left.length;
    this.written += n;
    let at = 0;
    while (at < n) {
      if (!this.block) this.block = new Float32Array(this.blockFrames * 2);
      const count = Math.min(this.blockFrames - this.fill, n - at);
      const block = this.block;
      const base = this.fill;
      const rightBase = this.blockFrames + base;
      for (let k = 0; k < count; k++) {
        block[base + k] = limit(left[at + k]);
        block[rightBase + k] = limit(right[at + k]);
      }
      this.fill += count;
      at += count;
      if (this.fill === this.blockFrames) {
        // A fresh array per block: the encoder may still hold the previous one.
        this.block = null;
        this.fill = 0;
        await this.write(block, this.blockFrames);
      }
    }
  }
}

/** Soft limiter: unchanged below the knee, then eases toward (never past) full scale. */
function limit(x) {
  if (x <= LIMITER_KNEE && x >= -LIMITER_KNEE) return x;
  const room = 1 - LIMITER_KNEE;
  if (x !== x) return 0; // NaN
  return x > 0 ? LIMITER_KNEE + room * Math.tanh((x - LIMITER_KNEE) / room) : -LIMITER_KNEE - room * Math.tanh((-x - LIMITER_KNEE) / room);
}

async function closeQuietly(writable) {
  try {
    await writable.close();
  } catch {
    /* StreamTarget may already have closed it */
  }
}
