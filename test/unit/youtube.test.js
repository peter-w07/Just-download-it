import { test } from 'node:test';
import assert from 'node:assert/strict';
import { player } from '../fixtures/youtube.js';

await import('../../extension/shared/util.js');
await import('../../extension/content/handlers/youtube.js');
const yt = globalThis.JDI.youtube;

const GVS = 'https://rr3---sn-test.googlevideo.com';

test('videoIdFromUrl covers every YouTube URL shape', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(yt.videoIdFromUrl(`https://www.youtube.com/watch?v=${id}`), id);
  assert.equal(yt.videoIdFromUrl(`https://www.youtube.com/watch?app=desktop&v=${id}&t=42s`), id);
  assert.equal(yt.videoIdFromUrl(`/watch?v=${id}&list=PL123`), id);
  assert.equal(yt.videoIdFromUrl(`https://m.youtube.com/watch?v=${id}`), id);
  assert.equal(yt.videoIdFromUrl(`https://youtu.be/${id}?si=abc`), id);
  assert.equal(yt.videoIdFromUrl(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(yt.videoIdFromUrl(`https://www.youtube.com/embed/${id}?autoplay=1`), id);
  assert.equal(yt.videoIdFromUrl(`https://www.youtube-nocookie.com/embed/${id}`), id);
  assert.equal(yt.videoIdFromUrl(`https://www.youtube.com/live/${id}`), id);
  assert.equal(yt.videoIdFromUrl('https://www.youtube.com/watch?v=short'), '');
  assert.equal(yt.videoIdFromUrl('https://www.youtube.com/@channel'), '');
  assert.equal(yt.videoIdFromUrl(`https://notyoutube.com/watch?v=${id}`), '');
  assert.equal(yt.videoIdFromUrl('not a url at all ::::'), '');
});

test('usableFormat rejects ciphered, throttled and DRM formats', () => {
  assert.equal(yt.usableFormat({ url: `${GVS}/videoplayback?itag=18` }), true);
  assert.equal(yt.usableFormat({ signatureCipher: 's=abc&url=x' }), false);
  assert.equal(yt.usableFormat({ url: `${GVS}/videoplayback?itag=18&n=abcdef` }), false);
  assert.equal(yt.usableFormat({ url: `${GVS}/videoplayback?itag=18`, drmFamilies: ['WIDEVINE'] }), false);
  assert.equal(yt.usableFormat({ url: 'http://insecure/x' }), false);
  assert.equal(yt.usableFormat(null), false);
});

test('quality list: H.264 up to 1080p, VP9 above, best first, AAC audio for MP4', () => {
  const res = yt.buildResolution(player(GVS), 'dQw4w9WgXcQ');
  assert.equal(res.site, 'YouTube');
  assert.equal(res.title, 'Never Gonna Give You Up');
  const v = res.items[0].variants;
  const videos = v.filter((x) => x.kind === 'video');
  assert.deepEqual(videos.map((x) => x.label), ['2160p', '1440p', '1080p', '720p', '360p']);
  assert.match(videos[0].detail, /^3840 × 2160 · VP9 · MP4$/);
  assert.match(videos[2].detail, /^1920 × 1080 · H\.264 · MP4$/);
  assert.equal(videos[0].size, 359000000 + 3450000, 'video + non-DRC AAC');
  assert.equal(videos[2].filename, 'Never Gonna Give You Up [dQw4w9WgXcQ] 1080p');
  assert.deepEqual(videos[2].job, { type: 'mux', video: `${GVS}/videoplayback?expire=1789633515&ei=x&ip=1.2.3.4&id=o-test&itag=137&source=youtube&mime=video%2Fmp4&c=VISIONOS`, audio: videos[2].job.audio });
  assert.match(videos[2].job.audio, /itag=140/);
  assert.doesNotMatch(videos[2].job.audio, /drc/, 'skips the compressed-dynamics duplicate');
});

test('audio options: MP3 from Opus, M4A from AAC; thumbnail last', () => {
  const v = yt.buildResolution(player(GVS), 'dQw4w9WgXcQ').items[0].variants;
  const mp3 = v.find((x) => x.label === 'MP3');
  assert.equal(mp3.group, 'Audio only');
  assert.equal(mp3.ext, 'mp3');
  assert.equal(mp3.filename, 'Never Gonna Give You Up [dQw4w9WgXcQ]');
  assert.equal(mp3.job.type, 'mp3');
  assert.match(mp3.job.audio, /itag=251/);
  const m4a = v.find((x) => x.label === 'M4A');
  assert.equal(m4a.ext, 'm4a');
  assert.deepEqual(Object.keys(m4a.job).sort(), ['audio', 'type']);
  assert.match(m4a.detail, /^AAC · 127 kbps · original quality$/);
  const thumb = v[v.length - 1];
  assert.equal(thumb.label, 'Thumbnail');
  assert.equal(thumb.detail, '1280 × 720 · JPG');
  assert.match(thumb.url, /maxresdefault/);
});

test('titles with unsafe characters still produce safe download paths', () => {
  const res = yt.buildResolution(player(GVS, { title: 'AC/DC: "Back in Black" | Live?' }), 'dQw4w9WgXcQ');
  const best = res.items[0].variants[0];
  assert.equal(
    globalThis.JDI.util.buildDownloadPath({ folder: 'Just Download It', site: 'YouTube', base: best.filename, ext: best.ext }),
    'Just Download It/YouTube/AC_DC_ _Back in Black_ _ Live_ [dQw4w9WgXcQ] 2160p.mp4',
  );
});

test('errors are explained', () => {
  const err = (p) => {
    try {
      yt.buildResolution(p, 'dQw4w9WgXcQ');
    } catch (e) {
      return e;
    }
    return null;
  };
  assert.match(err({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' } }).userMessage, /signed-in account/);
  assert.match(err({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } }).userMessage, /not a bot/);
  assert.match(err({ playabilityStatus: { status: 'ERROR', reason: 'Video unavailable' } }).userMessage, /Video unavailable/);
  const live = player(GVS);
  live.videoDetails.isLive = true;
  assert.match(err(live).userMessage, /live/i);
  const ciphered = player(GVS);
  for (const f of ciphered.streamingData.adaptiveFormats) {
    f.signatureCipher = `s=x&url=${encodeURIComponent(f.url)}`;
    delete f.url;
  }
  assert.equal(err(ciphered).code, 'no-formats');
});

test('no AAC track: MP4s pair with Opus instead of disappearing', () => {
  const p = player(GVS);
  p.streamingData.adaptiveFormats = p.streamingData.adaptiveFormats.filter((f) => !/mp4a/.test(f.mimeType));
  const v = yt.buildResolution(p, 'dQw4w9WgXcQ').items[0].variants;
  assert.ok(v.some((x) => x.label === '1080p'));
  assert.match(v.find((x) => x.label === '1080p').job.audio, /itag=251/);
  assert.equal(v.find((x) => x.kind === 'audio' && x.label !== 'MP3').ext, 'mp4');
});
