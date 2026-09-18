/*
 * Just download it: offscreen document.
 *
 * Runs the downloads that need processing, which a service worker can't do:
 *  - "mux": copy a video track and/or an audio track into one MP4 (or M4A)
 *    without re-encoding, e.g. YouTube 1080p video + its audio track.
 *  - "mp3": decode an audio track and encode it to MP3 on this computer.
 *    With `bitrate` (kbps) it encodes at that bitrate, otherwise at high quality.
 *  - "hls": copy an HLS stream into one MP4 (or M4A).
 *  Jobs may carry song tags (title, artist, album, cover art…) to write into the file.
 *  - "zip": many files (plain links, or any of the jobs above) in one ZIP (zip.js).
 *  - "mix": the songs of an album or playlist crossfaded into one MP3/M4A (mix.js).
 *  - GIF recordings of a tab (recorder.js), handed back the same way.
 *  A ZIP or a mix counts as one job. Their songs are looked up by the service
 *  worker (jdi:resolve-song), since this document can only use chrome.runtime.
 *
 * Inputs are read in ranges straight from the network and the output is
 * streamed into a temporary file in the extension's private storage (OPFS),
 * so even a long 4K video never has to fit in memory. ZIPs and mixes also get
 * a work folder (jobs/<jobId>.work) for their pieces, deleted when they end.
 * The finished file is handed to the service worker as a blob: URL for
 * chrome.downloads, and deleted once Chrome has saved it.
 *
 * Where it runs: in Chrome, the offscreen document (offscreen.html) loads this
 * module and it talks to the service worker through chrome.runtime. Firefox has
 * no offscreen documents, but its background event page has a DOM, so
 * background/offscreen-host.js imports this module there and calls
 * handleMessage() directly; connect() routes the messages below back to it.
 *
 * Messages (all JSON):
 *   SW -> here   { target: 'offscreen', type: 'jdi:job-start', jobId, job }
 *   SW -> here   { target: 'offscreen', type: 'jdi:job-release', jobId }  (also cancels a queued or running job;
 *                answered once the job's file is deleted)
 *   here -> SW   { type: 'jdi:job-progress', jobId, progress }       (0..1)
 *   here -> SW   { type: 'jdi:job-done', jobId, url, size, note? }   (note: e.g. songs left out of a mix)
 *   here -> SW   { type: 'jdi:job-failed', jobId, error }
 *   here -> SW   { type: 'jdi:resolve-song', jobId, job }  -> { ok, job: { type: 'mp3' | 'mux', audio, … } } | { ok: false, error }
 *   SW -> here   { target: 'offscreen', type: 'jdi:record-start', recId, streamId | tabId, … }  (see recorder.js;
 *                streamId: Chrome's tab capture, tabId: screenshots of the tab where there is none)
 *   SW -> here   { target: 'offscreen', type: 'jdi:record-stop', recId, cancel }
 *   SW -> here   { target: 'offscreen', type: 'jdi:ping' }  -> { ok, running, queued, finished, recording }
 *   A finished recording is reported with jdi:job-done / jdi:job-failed, jobId = recId.
 *
 * Exports (for background/offscreen-host.js in Firefox):
 *   handleMessage(message)   one of the SW -> here messages; resolves to its answer
 *   connect(deliver)         deliver(message) -> Promise<answer> takes the here -> SW messages
 */
import {
  ALL_FORMATS,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  HLS_FORMATS,
  Input,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  UrlSource,
  canEncodeAudio,
  registerMp3Encoder,
} from '../vendor/media.mjs';
import { startRecording } from './recorder.js';
import { buildMix } from './mix.js';
import { buildZip } from './zip.js';

const MAX_CONCURRENT_JOBS = 2;
const PROGRESS_INTERVAL_MS = 400;
const JOBS_DIR = 'jobs';
const JOB_TYPES = ['mux', 'mp3', 'hls', 'zip', 'mix'];
// What a ZIP entry or a looked-up song may run as.
const SUB_JOB_TYPES = ['mux', 'mp3', 'hls'];

const queue = [];
const running = new Map(); // jobId -> { cancelled }
const finished = new Map(); // jobId -> { url, name }
const recordings = new Map(); // recId -> { stop(), cancel() }

// Where messages for the service worker go (connect() replaces it in Firefox).
let deliver = (message) => chrome.runtime.sendMessage(message);

export function connect(fn) {
  deliver = fn;
}

/** A message from the service worker. Resolves to the answer, or undefined for messages that aren't for this runner. */
export async function handleMessage(message) {
  if (!message || message.target !== 'offscreen') return undefined;
  if (message.type === 'jdi:job-start') {
    queue.push({ jobId: String(message.jobId), job: message.job });
    pump();
    return { ok: true };
  }
  if (message.type === 'jdi:job-release') {
    // Answer once the file is deleted: the service worker may close this
    // document right after, which would cut the deletion short.
    return release(String(message.jobId)).then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
  }
  if (message.type === 'jdi:record-start') {
    return beginRecording(message).catch((err) => ({ ok: false, error: friendly(err) }));
  }
  if (message.type === 'jdi:record-stop') {
    const recording = recordings.get(String(message.recId));
    if (recording) {
      if (message.cancel) recording.cancel();
      else recording.stop();
    }
    return { ok: !!recording };
  }
  if (message.type === 'jdi:ping') {
    return { ok: true, running: running.size, queued: queue.length, finished: finished.size, recording: recordings.size };
  }
  return undefined;
}

// In the offscreen document (Chrome), messages arrive through chrome.runtime.
if (/\/offscreen\/offscreen\.html$/.test(globalThis.location ? location.pathname : '')) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || message.target !== 'offscreen') return false;
    const answer = handleMessage(message);
    answer.then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  });
}

// Temporary files from a previous session (browser closed mid-job) are useless now.
// Jobs wait for this, so a new job's file is never swept up with the old ones.
const leftoversCleaned = cleanUpLeftovers();

function pump() {
  while (running.size < MAX_CONCURRENT_JOBS && queue.length) {
    const { jobId, job } = queue.shift();
    const state = { cancelled: false };
    running.set(jobId, state);
    run(jobId, job, state)
      .then(
        ({ url, size, name, note }) => {
          finished.set(jobId, { url, name });
          if (state.cancelled) {
            release(jobId);
            send({ type: 'jdi:job-failed', jobId, error: 'Canceled.' });
            return;
          }
          send({ type: 'jdi:job-done', jobId, url, size, ...(note ? { note } : {}) });
        },
        (err) => {
          if (!state.cancelled) console.warn('[Just download it] job failed', err);
          send({ type: 'jdi:job-failed', jobId, error: state.cancelled ? 'Canceled.' : friendly(err) });
        },
      )
      .finally(() => {
        running.delete(jobId);
        pump();
      });
  }
}

function send(message) {
  Promise.resolve()
    .then(() => deliver(message))
    .catch(() => {
      /* the service worker wakes up for the next message */
    });
}

function friendly(err) {
  const text = String((err && err.message) || err || 'Unknown error');
  if (/403|forbidden/i.test(text)) return 'The site refused the download (the link may have expired). Reload the page and try again.';
  if (/quota|NoModificationAllowed|not enough space/i.test(text)) return 'Not enough free disk space to prepare this file.';
  if (/Failed to fetch|NetworkError|network/i.test(text)) return 'Network problem while downloading. Try again.';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

async function beginRecording(message) {
  const recId = String(message.recId || '');
  if (!recId || recordings.has(recId)) throw new Error('Recording already started.');
  const recording = await startRecording({
    recId,
    streamId: String(message.streamId || ''),
    ...(Number.isInteger(message.tabId) && message.tabId >= 0 ? { tabId: message.tabId } : {}),
    crop: message.crop,
    fps: message.fps,
    maxWidth: message.maxWidth,
    maxSeconds: message.maxSeconds,
    onProgress: throttle((p) => send({ type: 'jdi:job-progress', jobId: recId, progress: p }), PROGRESS_INTERVAL_MS),
  });
  recordings.set(recId, recording);
  recording.done
    .then(
      (blob) => {
        if (!blob || !blob.size) {
          send({ type: 'jdi:job-failed', jobId: recId, error: 'Canceled.' });
          return;
        }
        const url = URL.createObjectURL(blob);
        finished.set(recId, { url, name: '' });
        send({ type: 'jdi:job-done', jobId: recId, url, size: blob.size });
      },
      (err) => {
        console.warn('[Just download it] recording failed', err);
        send({ type: 'jdi:job-failed', jobId: recId, error: friendly(err) });
      },
    )
    .finally(() => recordings.delete(recId));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** The file a job makes: { ext, mime }. */
function outputOf(job) {
  if (job.type === 'zip') return { ext: 'zip', mime: 'application/zip' };
  if (job.type === 'mix') return job.format === 'm4a' ? { ext: 'm4a', mime: 'audio/mp4' } : { ext: 'mp3', mime: 'audio/mpeg' };
  if (job.type === 'mp3') return { ext: 'mp3', mime: 'audio/mpeg' };
  const audioOnly = job.type === 'hls' ? !!job.audioOnly : !job.video;
  return audioOnly ? { ext: 'm4a', mime: 'audio/mp4' } : { ext: 'mp4', mime: 'video/mp4' };
}

/** @returns { url, size, name, note } */
async function run(jobId, job, state) {
  if (!job || !JOB_TYPES.includes(job.type)) throw new Error("This kind of download isn't supported yet.");
  await leftoversCleaned;
  if (state.cancelled) throw new Error('Canceled.');
  const { ext, mime } = outputOf(job);
  const name = `${jobId}.${ext}`;
  const workName = `${jobId}.work`;

  const dir = await jobsDirectory();
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  const progress = throttle((p) => send({ type: 'jdi:job-progress', jobId, progress: p }), PROGRESS_INTERVAL_MS);
  let note = '';

  try {
    if (job.type === 'zip' || job.type === 'mix') {
      const tools = bundleTools(jobId, state, dir, workName);
      const result = job.type === 'zip' ? await buildZip(job, writable, progress, tools) : await buildMix(job, writable, progress, tools);
      note = (result && typeof result.note === 'string' && result.note) || '';
    } else {
      await produce(job, writable, progress);
    }
  } catch (err) {
    await writable.abort().catch(() => {});
    await dir.removeEntry(name).catch(() => {});
    throw err;
  } finally {
    await dir.removeEntry(workName, { recursive: true }).catch(() => {});
  }
  await closeQuietly(writable);

  const file = await handle.getFile();
  if (!file.size) {
    await dir.removeEntry(name).catch(() => {});
    throw new Error('The finished file was empty.');
  }
  // A File from OPFS is backed by disk, so this doesn't copy it into memory.
  const url = URL.createObjectURL(new Blob([file], { type: mime }));
  progress.flush(1);
  return { url, size: file.size, name, note };
}

/** A single mux / mp3 / hls job into `writable` (also a ZIP's entries). */
async function produce(job, writable, progress) {
  if (!job || !SUB_JOB_TYPES.includes(job.type)) throw new Error("This kind of download isn't supported yet.");
  const tags = job.type === 'hls' ? null : await loadTags(job.tags);
  if (job.type === 'mp3') await convertToMp3(job, writable, progress, tags);
  else if (job.type === 'hls') await copyHls(job, writable, progress);
  else await mux(job, writable, progress, tags);
}

/** What zip.js and mix.js get to work with. */
function bundleTools(jobId, state, jobsDir, workName) {
  let work = null;
  const checkCancelled = () => {
    if (state.cancelled) throw new Error('Canceled.');
  };
  return {
    workDir: () => (work ||= jobsDir.getDirectoryHandle(workName, { create: true })),
    produce,
    resolveSong: (job, options) => resolveSong(jobId, job, checkCancelled, options),
    loadTags,
    ensureMp3Encoder,
    checkCancelled,
    isCancelled: () => state.cancelled,
    friendly,
  };
}

/**
 * Ask the service worker to find a song's audio (it looks it up on YouTube
 * Music). Returns the mp3 / mux job that converts it.
 */
async function resolveSong(jobId, job, checkCancelled, { refresh = false } = {}) {
  checkCancelled();
  let reply;
  try {
    reply = await deliver({ type: 'jdi:resolve-song', jobId, job, refresh });
  } catch {
    reply = null;
  }
  checkCancelled();
  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Couldn’t look up this song. Try again.');
  const found = reply.job;
  if (!found || !['mp3', 'mux'].includes(found.type) || !/^https:/i.test(String(found.audio || '')) || found.video) {
    throw new Error('Couldn’t find this song’s audio.');
  }
  return found;
}

/** Forget a finished job's file, or cancel a job that is still queued or running. */
async function release(jobId) {
  const queued = queue.findIndex((q) => q.jobId === jobId);
  if (queued >= 0) {
    queue.splice(queued, 1);
    send({ type: 'jdi:job-failed', jobId, error: 'Canceled.' });
  }
  const state = running.get(jobId);
  if (state) state.cancelled = true;
  const entry = finished.get(jobId);
  if (!entry) return;
  finished.delete(jobId);
  URL.revokeObjectURL(entry.url);
  if (!entry.name) return; // kept in memory (recordings)
  const dir = await jobsDirectory().catch(() => null);
  if (dir) await dir.removeEntry(entry.name).catch(() => {});
}

/**
 * Song tags for Mediabunny, with the cover art downloaded (and turned into a
 * JPEG if it isn't one, since players don't all show WebP covers).
 */
async function loadTags(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tags = {};
  for (const key of ['title', 'artist', 'album', 'albumArtist', 'genre', 'comment']) {
    if (typeof raw[key] === 'string' && raw[key]) tags[key] = raw[key];
  }
  for (const key of ['trackNumber', 'tracksTotal', 'discNumber', 'discsTotal']) {
    if (Number(raw[key]) > 0) tags[key] = Math.floor(Number(raw[key]));
  }
  if (raw.date) {
    const date = new Date(raw.date);
    if (!Number.isNaN(date.getTime())) tags.date = date;
  }
  if (typeof raw.coverUrl === 'string' && /^https:/i.test(raw.coverUrl)) {
    try {
      const res = await fetch(raw.coverUrl, { credentials: 'omit' });
      let blob = res.ok ? await res.blob() : null;
      if (blob && blob.size > 0 && blob.size < 15 * 1024 * 1024) {
        if (!/^image\/(jpeg|png)$/.test(blob.type)) {
          const bitmap = await createImageBitmap(blob);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          bitmap.close();
          blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
        }
        tags.images = [{ data: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type, kind: 'coverFront' }];
      }
    } catch {
      /* the song is still worth saving without its cover */
    }
  }
  return Object.keys(tags).length ? tags : null;
}

function openInput(url) {
  if (!/^https:/i.test(String(url))) throw new Error('Unsupported media URL.');
  const source = new UrlSource(url, {
    requestInit: { credentials: 'omit', cache: 'no-store' },
    // The default retries forever; a dead or expired link should fail instead.
    getRetryDelay: (attempts) => (attempts < 3 ? attempts : null),
    parallelism: 4,
  });
  return new Input({ formats: ALL_FORMATS, source });
}

/**
 * Copy a video track and/or an audio track into one MP4 without re-encoding.
 * With only audio, the result is a plain M4A.
 */
async function mux(job, writable, progress, tags) {
  const inputs = [];
  try {
    const videoInput = job.video ? openInput(job.video) : null;
    const audioInput = job.audio ? openInput(job.audio) : null;
    if (videoInput) inputs.push(videoInput);
    if (audioInput) inputs.push(audioInput);

    const videoTrack = videoInput ? await videoInput.getPrimaryVideoTrack() : null;
    const audioTrack = audioInput ? await audioInput.getPrimaryAudioTrack() : null;
    if (videoInput && !videoTrack) throw new Error("The video file didn't contain a video track.");
    if (audioInput && !audioTrack) throw new Error("The audio file didn't contain an audio track.");

    const output = new Output({
      // Metadata at the end: keeps memory flat for long videos.
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(writable, { chunked: true }),
    });
    if (tags) output.setMetadataTags(tags);

    const tracks = [];
    let duration = 0;
    if (videoTrack) {
      const [codec, decoderConfig, rotation, d] = await Promise.all([
        videoTrack.getCodec(),
        videoTrack.getDecoderConfig(),
        videoTrack.getRotation(),
        videoInput.getDurationFromMetadata().catch(() => null),
      ]);
      if (!codec || !decoderConfig) throw new Error("This video uses a format that can't be combined yet.");
      duration = Math.max(duration, d || 0);
      const source = new EncodedVideoPacketSource(codec);
      output.addVideoTrack(source, rotation ? { rotation } : undefined);
      tracks.push({ source, decoderConfig, packets: new EncodedPacketSink(videoTrack).packets() });
    }
    if (audioTrack) {
      const [codec, decoderConfig, d] = await Promise.all([
        audioTrack.getCodec(),
        audioTrack.getDecoderConfig(),
        audioInput.getDurationFromMetadata().catch(() => null),
      ]);
      if (!codec || !decoderConfig) throw new Error("This audio uses a format that can't be combined yet.");
      duration = Math.max(duration, d || 0);
      const source = new EncodedAudioPacketSource(codec);
      output.addAudioTrack(source);
      tracks.push({ source, decoderConfig, packets: new EncodedPacketSink(audioTrack).packets() });
    }
    await output.start();

    // Interleave by timestamp so neither track gets buffered as a whole.
    for (const t of tracks) {
      t.next = await t.packets.next();
      t.first = true;
    }
    for (;;) {
      const pending = tracks.filter((t) => !t.next.done);
      if (!pending.length) break;
      const t = pending.reduce((a, b) => (b.next.value.timestamp < a.next.value.timestamp ? b : a));
      const packet = t.next.value;
      await t.source.add(packet, t.first ? { decoderConfig: t.decoderConfig } : undefined);
      t.first = false;
      if (duration > 0) progress(Math.min(0.99, Math.max(0, packet.timestamp / duration)));
      t.next = await t.packets.next();
    }
    for (const t of tracks) t.source.close();
    await output.finalize();
  } finally {
    for (const input of inputs) input.dispose();
  }
}

let mp3EncoderReady = null;
function ensureMp3Encoder() {
  if (!mp3EncoderReady) {
    mp3EncoderReady = (async () => {
      if (!(await canEncodeAudio('mp3'))) registerMp3Encoder();
    })();
  }
  return mp3EncoderReady;
}

async function convertToMp3(job, writable, progress, tags) {
  await ensureMp3Encoder();
  const input = openInput(job.audio);
  try {
    const output = new Output({ format: new Mp3OutputFormat(), target: new StreamTarget(writable, { chunked: true }) });
    // The user's MP3 bitrate from the settings (kbps), when the service worker set one.
    const kbps = Math.round(Number(job.bitrate));
    const bitrate = kbps >= 32 && kbps <= 320 ? kbps * 1000 : QUALITY_HIGH;
    const conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
      audio: { codec: 'mp3', bitrate },
      ...(tags ? { tags } : {}),
    });
    if (!conversion.isValid) {
      const reason = (conversion.discardedTracks || []).map((d) => d.reason).join(', ');
      throw new Error(`Couldn't convert this audio to MP3${reason ? ` (${reason})` : ''}.`);
    }
    conversion.onProgress = (p) => progress(Math.min(0.99, p));
    await conversion.execute();
  } finally {
    input.dispose();
  }
}

/**
 * An HLS media playlist (e.g. one Twitch VOD quality) copied into a single MP4
 * (or M4A for audio-only playlists) without re-encoding.
 */
async function copyHls(job, writable, progress) {
  if (!/^https:/i.test(String(job.url))) throw new Error('Unsupported media URL.');
  const input = new Input({
    formats: HLS_FORMATS,
    source: new UrlSource(job.url, {
      requestInit: { credentials: 'omit', cache: 'no-store' },
      getRetryDelay: (attempts) => (attempts < 4 ? attempts : null),
      parallelism: 6,
    }),
    // Keep timestamps starting at zero instead of wall-clock time.
    formatOptions: { hls: { offsetTimestampsByDateTime: false } },
  });
  try {
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(writable, { chunked: true }),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: job.audioOnly ? { discard: true } : {},
    });
    if (!conversion.isValid) {
      const reason = (conversion.discardedTracks || []).map((d) => d.reason).join(', ');
      throw new Error(`Couldn't save this stream${reason ? ` (${reason})` : ''}.`);
    }
    conversion.onProgress = (p) => progress(Math.min(0.99, p));
    await conversion.execute();
  } finally {
    input.dispose();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function jobsDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(JOBS_DIR, { create: true });
}

async function cleanUpLeftovers() {
  try {
    const dir = await jobsDirectory();
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    await Promise.all(names.map((name) => dir.removeEntry(name, { recursive: true }).catch(() => {})));
  } catch {
    /* nothing to clean */
  }
}

async function closeQuietly(writable) {
  try {
    await writable.close();
  } catch {
    /* StreamTarget may already have closed it */
  }
}

function throttle(fn, ms) {
  let last = 0;
  let timer = 0;
  let pending = null;
  const call = (value) => {
    pending = value;
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      clearTimeout(timer);
      timer = 0;
      fn(value);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = 0;
        fn(pending);
      }, ms - (now - last));
    }
  };
  call.flush = (value) => {
    clearTimeout(timer);
    timer = 0;
    fn(value);
  };
  return call;
}
