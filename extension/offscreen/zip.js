/*
 * Just download it: "Download as ZIP" (offscreen document).
 *
 * Job: { type: 'zip', entries: [{ name, url?, job? }] }
 *   name  the file's final name inside the ZIP, extension included (the
 *         service worker picks it; it is cleaned up again here)
 *   url   a plain https file, streamed straight to disk
 *   job   a mux / mp3 / hls job, or a song that is looked up first
 *         (jdi:resolve-song, answered by the service worker)
 *
 * How it works:
 *  1. Every entry is produced into its own temporary file in the job's work
 *     folder (OPFS), two at a time. An entry that fails is left out and listed
 *     in "Couldn’t download.txt" inside the ZIP instead; only when nothing
 *     works does the whole job fail.
 *  2. The finished files are streamed one after another into a ZIP written to
 *     the job's output file. Entries are stored, not compressed: songs and
 *     videos are already compressed, so deflate would only cost time. Each
 *     local header is written with its CRC left blank, the data is copied (and
 *     checksummed) in 4 MB pieces, then the CRC is patched in place, so the ZIP
 *     needs no data descriptors and opens everywhere. ZIP64 records are added
 *     when a file, an offset or the directory crosses 4 GB.
 *  Nothing is ever held in memory whole; each temporary file is deleted as
 *  soon as it is inside the ZIP.
 *
 * Exports:
 *   buildZip(job, writable, progress, tools)  -> { note }
 *   ZipWriter                                  the streaming writer (also used by tests)
 *   crc32(crc, bytes)                          running CRC-32
 *   cleanZipNames(names)                       safe, unique names inside a ZIP
 */

export const MAX_ZIP_ENTRIES = 300;
const PARALLEL_ENTRIES = 2;
const COPY_BUFFER_BYTES = 4 * 1024 * 1024;
// The last ~3% of the progress bar is the zipping itself.
const PRODUCE_SHARE = 0.97;
export const FAILURES_FILE = 'Couldn’t download.txt';

/**
 * @param job       { entries: [{ name, url?, job? }] }
 * @param writable  the output file (FileSystemWritableFileStream)
 * @param progress  (0..1) => void
 * @param tools     { workDir(), produce(job, writable, progress), resolveSong(job), checkCancelled(), isCancelled(), friendly(err) }
 */
export async function buildZip(job, writable, progress, tools) {
  const raw = Array.isArray(job && job.entries) ? job.entries : [];
  if (!raw.length) throw new Error('Nothing to download.');
  if (raw.length > MAX_ZIP_ENTRIES) throw new Error(`A ZIP can hold up to ${MAX_ZIP_ENTRIES} files.`);
  const names = cleanZipNames([...raw.map((e) => e && e.name), FAILURES_FILE]);
  const entries = raw.map((e, i) => ({ name: names[i], url: e && e.url, job: e && e.job, isSong: !!(e && e.job && e.job.type === 'song') }));
  const failuresName = names[names.length - 1];

  const dir = await tools.workDir();
  const total = entries.length;
  const fractions = new Float64Array(total);
  const report = () => {
    let sum = 0;
    for (const f of fractions) sum += f;
    progress(Math.min(PRODUCE_SHARE, (sum / total) * PRODUCE_SHARE));
  };

  // 1. Produce every entry into a temporary file.
  const results = new Array(total);
  let next = 0;
  const worker = async () => {
    while (next < total && !tools.isCancelled()) {
      const i = next++;
      results[i] = await produceEntry(entries[i], `${i}.part`, dir, tools, (f) => {
        fractions[i] = Math.max(fractions[i], Math.min(1, f));
        report();
      });
      fractions[i] = 1;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_ENTRIES, total) }, worker));
  tools.checkCancelled();

  const failures = [];
  const ready = [];
  entries.forEach((entry, i) => {
    const r = results[i];
    if (r && r.ok) ready.push({ entry, ...r });
    else failures.push({ entry, error: (r && r.error) || 'Unknown error' });
  });
  if (!ready.length) {
    const first = failures[0] ? failures[0].error : 'Download failed.';
    throw new Error(total === 1 ? first : `None of the files could be downloaded. ${first}`);
  }

  // 2. Stream them into the ZIP.
  const zip = new ZipWriter(writable);
  const zipBytes = ready.reduce((sum, r) => sum + r.size, 0) || 1;
  let copied = 0;
  for (const r of ready) {
    tools.checkCancelled();
    const file = await r.handle.getFile();
    if (file.size !== r.size) throw new Error('A temporary file changed while it was being zipped.');
    await zip.addFile(r.entry.name, file, {
      onBytes: (n) => progress(PRODUCE_SHARE + (1 - PRODUCE_SHARE) * Math.min(1, (copied + n) / zipBytes)),
      checkCancelled: tools.checkCancelled,
    });
    copied += r.size;
    await dir.removeEntry(r.name).catch(() => {});
  }
  if (failures.length) await zip.addBytes(failuresName, failuresText(failures));
  await zip.finish();

  return { note: failures.length ? failureNote(failures) : '' };
}

/**
 * A song's stream link is tied to time and place, and one that has gone stale
 * answers 403. Worth looking the song up again once.
 */
export function isStaleLink(err) {
  return /\b403\b|forbidden|expired|refused the download/i.test(String((err && err.message) || err));
}

/** One entry into `tempName`. Never throws: returns { ok, handle, name, size } or { ok: false, error }. */
async function produceEntry(entry, tempName, dir, tools, onFraction) {
  const isSong = !!(entry.job && typeof entry.job === 'object' && entry.job.type === 'song');
  // The second try asks the service worker for a fresh link.
  for (let attempt = 0; ; attempt++) {
    let handle = null;
    let writable = null;
    try {
      tools.checkCancelled();
      handle = await dir.getFileHandle(tempName, { create: true });
      writable = await handle.createWritable();
      let sub = entry.job;
      if (sub && typeof sub === 'object') {
        if (sub.type === 'song') {
          sub = await tools.resolveSong(sub, { refresh: attempt > 0 });
          onFraction(0.05);
          tools.checkCancelled();
          await tools.produce(sub, writable, (p) => onFraction(0.05 + 0.95 * p));
        } else {
          await tools.produce(sub, writable, onFraction);
        }
      } else {
        await fetchInto(entry.url, writable, onFraction, tools);
      }
      await closeQuietly(writable);
      writable = null;
      const file = await handle.getFile();
      if (!file.size) throw new Error('The file was empty.');
      return { ok: true, handle, name: tempName, size: file.size };
    } catch (err) {
      if (writable) await writable.abort().catch(() => {});
      if (handle) await dir.removeEntry(tempName).catch(() => {});
      if (tools.isCancelled()) return { ok: false, error: 'Canceled.' };
      if (attempt === 0 && isSong && isStaleLink(err)) {
        onFraction(0);
        continue;
      }
      return { ok: false, error: tools.friendly(err) };
    }
  }
}

/**
 * Stream a plain file into `writable` (no cookies). One retry for a dropped
 * connection. The service worker only lets through public http(s) links and
 * data: images, videos and audio.
 */
async function fetchInto(url, writable, onFraction, tools) {
  if (!/^(https?:|data:(image|video|audio)\/)/i.test(String(url || ''))) throw new Error('Unsupported media URL.');
  for (let attempt = 1; ; attempt++) {
    let written = 0;
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const length = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          tools.checkCancelled();
          await writable.write({ type: 'write', position: written, data: value });
          written += value.byteLength;
          if (length) onFraction(Math.min(0.99, written / length));
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      if (length && written < length) throw new Error('Network problem: the download was cut short.');
      await writable.truncate(written);
      return;
    } catch (err) {
      const retry = attempt < 2 && !tools.isCancelled() && /Failed to fetch|network|cut short|HTTP 5\d\d/i.test(String(err && err.message));
      if (!retry) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function failureNote(failures) {
  const songs = failures.every((f) => f.entry.isSong);
  const noun = songs ? 'song' : 'file';
  if (failures.length === 1) return `1 ${noun} couldn’t be downloaded and was left out.`;
  return `${failures.length} ${noun}s couldn’t be downloaded and were left out.`;
}

function failuresText(failures) {
  const lines = ['These files couldn’t be downloaded, so they aren’t in this ZIP:', ''];
  for (const f of failures) lines.push(f.entry.name, `    ${String(f.error).replace(/\s+/g, ' ')}`, '');
  // A byte order mark helps older text editors see UTF-8.
  const body = new TextEncoder().encode(lines.join('\r\n'));
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const BACKSLASH = String.fromCharCode(92);

/**
 * Names that are safe inside a ZIP and unique (ignoring case, like Windows):
 * no folders, no control characters, "name (2).ext" for repeats.
 */
export function cleanZipNames(names) {
  const seen = new Set();
  return names.map((raw, i) => {
    let name = Array.from(String(raw == null ? '' : raw), (ch) => {
      const c = ch.codePointAt(0);
      if (c < 32 || c === 127) return '';
      if (ch === '/' || ch === BACKSLASH || ch === ':' || '<>"|?*'.includes(ch)) return '_';
      return ch;
    })
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    if (Array.from(name).length > 200) {
      const m = /(\.[A-Za-z0-9]{1,5})$/.exec(name);
      const ext = m ? m[1] : '';
      name = Array.from(name.slice(0, name.length - ext.length)).slice(0, 190).join('').trim() + ext;
    }
    if (!name || name.startsWith('.')) name = `file ${i + 1}${name}`;
    const m = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/.exec(name);
    const stem = m[1] || name;
    const ext = m[2] || '';
    let candidate = name;
    for (let n = 2; seen.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}

// ---------------------------------------------------------------------------
// ZIP writer
// ---------------------------------------------------------------------------

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const UTF8_FLAG = 0x0800;
const VERSION_ZIP64 = 45;
const VERSION_DEFAULT = 20;
const VERSION_MADE_BY = (3 << 8) | VERSION_ZIP64; // Unix, so permissions below apply
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0; // regular file, rw-r--r--

/**
 * Writes a stored ZIP to a sink with positioned writes:
 * sink.write({ type: 'write', position, data }) (a FileSystemWritableFileStream).
 */
export class ZipWriter {
  // forceZip64: write ZIP64 records even for small files (used by tests).
  constructor(sink, { date = new Date(), forceZip64 = false } = {}) {
    this.sink = sink;
    this.forceZip64 = !!forceZip64;
    this.offset = 0;
    this.central = [];
    const d = date.getFullYear() < 1980 ? new Date(1980, 0, 1) : date;
    this.dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    this.dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }

  async append(bytes) {
    await this.sink.write({ type: 'write', position: this.offset, data: bytes });
    this.offset += bytes.byteLength;
  }

  /** A file from a Blob (e.g. an OPFS File), streamed. */
  async addFile(name, blob, { onBytes, checkCancelled } = {}) {
    const size = blob.size;
    const entry = this.begin(name, size);
    await this.append(localHeader(entry, this));
    const dataStart = this.offset;
    let crc = 0;
    let copied = 0;
    const reader = blob.stream().getReader();
    const buffer = new Uint8Array(Math.min(COPY_BUFFER_BYTES, Math.max(1, size)));
    let fill = 0;
    const flush = async () => {
      if (!fill) return;
      const piece = buffer.subarray(0, fill);
      crc = crc32(crc, piece);
      await this.append(piece);
      copied += fill;
      fill = 0;
      if (onBytes) onBytes(copied);
      if (checkCancelled) checkCancelled();
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let at = 0;
        while (at < value.byteLength) {
          const n = Math.min(buffer.length - fill, value.byteLength - at);
          buffer.set(value.subarray(at, at + n), fill);
          fill += n;
          at += n;
          if (fill === buffer.length) await flush();
        }
      }
      await flush();
    } finally {
      reader.cancel().catch(() => {});
    }
    if (copied !== size || this.offset - dataStart !== size) throw new Error('A file changed size while it was being zipped.');
    entry.crc = crc;
    await this.patchCrc(entry);
    this.central.push(entry);
  }

  /** A small file from memory. */
  async addBytes(name, bytes) {
    const entry = this.begin(name, bytes.byteLength);
    entry.crc = crc32(0, bytes);
    await this.append(localHeader(entry, this));
    await this.append(bytes);
    this.central.push(entry);
  }

  begin(name, size) {
    const nameBytes = new TextEncoder().encode(String(name));
    if (nameBytes.length > MAX16) throw new Error('File name too long for a ZIP.');
    return { nameBytes, size, crc: 0, headerOffset: this.offset, zip64Size: size >= MAX32 || this.forceZip64 };
  }

  async patchCrc(entry) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, entry.crc, true);
    await this.sink.write({ type: 'write', position: entry.headerOffset + 14, data: bytes });
  }

  /** Central directory and end records. */
  async finish() {
    const cdStart = this.offset;
    for (const entry of this.central) await this.append(centralHeader(entry, this));
    const cdSize = this.offset - cdStart;
    const count = this.central.length;
    if (count >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32 || this.forceZip64) {
      const zip64End = this.offset;
      const rec = new Uint8Array(56);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x06064b50, true);
      setUint64(v, 4, 44);
      v.setUint16(12, VERSION_MADE_BY, true);
      v.setUint16(14, VERSION_ZIP64, true);
      v.setUint32(16, 0, true);
      v.setUint32(20, 0, true);
      setUint64(v, 24, count);
      setUint64(v, 32, count);
      setUint64(v, 40, cdSize);
      setUint64(v, 48, cdStart);
      await this.append(rec);
      const loc = new Uint8Array(20);
      const l = new DataView(loc.buffer);
      l.setUint32(0, 0x07064b50, true);
      l.setUint32(4, 0, true);
      setUint64(l, 8, zip64End);
      l.setUint32(16, 1, true);
      await this.append(loc);
    }
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(4, 0, true);
    e.setUint16(6, 0, true);
    e.setUint16(8, Math.min(count, MAX16), true);
    e.setUint16(10, Math.min(count, MAX16), true);
    e.setUint32(12, Math.min(cdSize, MAX32), true);
    e.setUint32(16, Math.min(cdStart, MAX32), true);
    e.setUint16(20, 0, true);
    await this.append(end);
    return this.offset;
  }
}

function localHeader(entry, zip) {
  const extra = entry.zip64Size ? 20 : 0;
  const out = new Uint8Array(30 + entry.nameBytes.length + extra);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, entry.zip64Size ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  v.setUint16(6, UTF8_FLAG, true);
  v.setUint16(8, 0, true); // stored
  v.setUint16(10, zip.dosTime, true);
  v.setUint16(12, zip.dosDate, true);
  v.setUint32(14, entry.crc, true);
  v.setUint32(18, entry.zip64Size ? MAX32 : entry.size, true);
  v.setUint32(22, entry.zip64Size ? MAX32 : entry.size, true);
  v.setUint16(26, entry.nameBytes.length, true);
  v.setUint16(28, extra, true);
  out.set(entry.nameBytes, 30);
  if (extra) {
    const at = 30 + entry.nameBytes.length;
    v.setUint16(at, 0x0001, true);
    v.setUint16(at + 2, 16, true);
    setUint64(v, at + 4, entry.size);
    setUint64(v, at + 12, entry.size);
  }
  return out;
}

function centralHeader(entry, zip) {
  const bigOffset = entry.headerOffset >= MAX32 || zip.forceZip64;
  const fields = (entry.zip64Size ? 2 : 0) + (bigOffset ? 1 : 0);
  const extra = fields ? 4 + 8 * fields : 0;
  const out = new Uint8Array(46 + entry.nameBytes.length + extra);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, VERSION_MADE_BY, true);
  v.setUint16(6, fields ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  v.setUint16(8, UTF8_FLAG, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, zip.dosTime, true);
  v.setUint16(14, zip.dosDate, true);
  v.setUint32(16, entry.crc, true);
  v.setUint32(20, entry.zip64Size ? MAX32 : entry.size, true);
  v.setUint32(24, entry.zip64Size ? MAX32 : entry.size, true);
  v.setUint16(28, entry.nameBytes.length, true);
  v.setUint16(30, extra, true);
  v.setUint16(32, 0, true); // comment
  v.setUint16(34, 0, true); // disk
  v.setUint16(36, 0, true); // internal attributes
  v.setUint32(38, FILE_ATTRIBUTES, true);
  v.setUint32(42, bigOffset ? MAX32 : entry.headerOffset, true);
  out.set(entry.nameBytes, 46);
  if (extra) {
    let at = 46 + entry.nameBytes.length;
    v.setUint16(at, 0x0001, true);
    v.setUint16(at + 2, 8 * fields, true);
    at += 4;
    if (entry.zip64Size) {
      setUint64(v, at, entry.size);
      setUint64(v, at + 8, entry.size);
      at += 16;
    }
    if (bigOffset) setUint64(v, at, entry.headerOffset);
  }
  return out;
}

function setUint64(view, at, value) {
  view.setUint32(at, value >>> 0, true);
  view.setUint32(at + 4, Math.floor(value / 0x100000000), true);
}

async function closeQuietly(writable) {
  try {
    await writable.close();
  } catch {
    /* StreamTarget may already have closed it */
  }
}

// ---------------------------------------------------------------------------
// CRC-32 (slicing-by-8)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff] ^ (c >>> 8);
      t[k * 256 + n] = c;
    }
  }
  return t;
})();

/** Continue a CRC-32 (start with 0) over `bytes`. Returns an unsigned 32-bit number. */
export function crc32(crc, bytes) {
  const t = CRC_TABLE;
  let c = ~crc;
  let i = 0;
  const n = bytes.length;
  for (; i + 8 <= n; i += 8) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c =
      t[1792 + (c & 0xff)] ^
      t[1536 + ((c >>> 8) & 0xff)] ^
      t[1280 + ((c >>> 16) & 0xff)] ^
      t[1024 + (c >>> 24)] ^
      t[768 + bytes[i + 4]] ^
      t[512 + bytes[i + 5]] ^
      t[256 + bytes[i + 6]] ^
      t[bytes[i + 7]];
  }
  for (; i < n; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
