import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../extension/shared/util.js');
const u = globalThis.JDI.util;
const { pickRelease, fillTags, primaryArtist, plainTitle, plainAlbum } = await import('../../extension/background/metadata.js');
const { cleanZipNames, crc32 } = await import('../../extension/offscreen/zip.js');

// A song item the way the Spotify resolver lists it: MP3 and M4A song jobs, then "Other".
function songItem(title, artist, { album = 'After Hours' } = {}) {
  const tags = { title, artist, album, coverUrl: 'https://i.scdn.co/image/abc' };
  const job = (format) => ({ type: 'song', format, match: { title, artists: [artist], album, durationMs: 200000 }, tags });
  return {
    label: `${title} · ${artist}`,
    variants: [
      { kind: 'audio', label: 'MP3', url: 'https://music.youtube.com/', ext: 'mp3', filename: `${artist} - ${title}`, job: job('mp3') },
      { kind: 'audio', label: 'M4A', url: 'https://music.youtube.com/', ext: 'm4a', filename: `${artist} - ${title}`, job: job('m4a') },
      { kind: 'image', group: 'Other', label: 'Cover art', url: 'https://i.scdn.co/image/abc', ext: 'jpg', filename: 'cover' },
    ],
  };
}

test('cleanSettings keeps valid song and mix settings and fixes bad ones', () => {
  const good = u.cleanSettings({ songFilename: 'title-artist', audioFormat: 'm4a', mp3Bitrate: '320', mixFormat: 'm4a', mixCrossfade: 3.6, embedTags: 0 });
  assert.equal(good.songFilename, 'title-artist');
  assert.equal(good.audioFormat, 'm4a');
  assert.equal(good.mp3Bitrate, 320);
  assert.equal(good.mixFormat, 'm4a');
  assert.equal(good.mixCrossfade, 4);
  assert.equal(good.embedTags, false);
  const bad = u.cleanSettings({ songFilename: 'x', audioFormat: 'flac', mp3Bitrate: 999, mixFormat: 'wav', mixCrossfade: 99, folder: 5 });
  assert.equal(bad.songFilename, 'artist-title');
  assert.equal(bad.audioFormat, 'mp3');
  assert.equal(bad.mp3Bitrate, 256);
  assert.equal(bad.mixFormat, 'mp3');
  assert.equal(bad.mixCrossfade, 12);
  assert.equal(bad.folder, 'Just Download It');
  assert.equal(u.cleanSettings({ mixCrossfade: 'soon' }).mixCrossfade, 6);
});

test('songBaseName follows the pattern and falls back without a title', () => {
  const tags = { title: 'Blinding Lights', artist: 'The Weeknd' };
  assert.equal(u.songBaseName(tags, 'artist-title'), 'The Weeknd - Blinding Lights');
  assert.equal(u.songBaseName(tags, 'title-artist'), 'Blinding Lights - The Weeknd');
  assert.equal(u.songBaseName(tags, 'title'), 'Blinding Lights');
  assert.equal(u.songBaseName({ title: 'Solo' }, 'artist-title'), 'Solo');
  assert.equal(u.songBaseName({ artist: 'Nobody' }, 'artist-title', 'fallback'), 'fallback');
  assert.equal(u.songBaseName(undefined, 'title', ''), '');
});

test('trackPrefix pads to the width of the total', () => {
  assert.equal(u.trackPrefix(1, 12), '01 - ');
  assert.equal(u.trackPrefix(12, 12), '12 - ');
  assert.equal(u.trackPrefix(7, 150), '007 - ');
  assert.equal(u.trackPrefix(0, 12), '');
  assert.equal(u.trackPrefix('x', 12), '');
});

test('buildDownloadPath puts songs of a collection in their own folder', () => {
  assert.equal(
    u.buildDownloadPath({ folder: 'Just Download It', site: 'Spotify', subfolder: 'My: Playlist', base: '01 - The Weeknd - Blinding Lights', ext: 'mp3' }),
    'Just Download It/Spotify/My_ Playlist/01 - The Weeknd - Blinding Lights.mp3',
  );
  assert.equal(u.buildDownloadPath({ folder: '', site: 'Spotify', base: 'After Hours', ext: 'zip' }), 'Spotify/After Hours.zip');
});

test('preferAudioFormat lists the preferred song format first and leaves other items alone', () => {
  const photo = { label: 'Photo', variants: [{ kind: 'image', url: 'https://x.test/a.jpg', ext: 'jpg' }] };
  const res = { site: 'Spotify', items: [songItem('A', 'X'), photo] };
  const m4a = u.preferAudioFormat(res, 'm4a');
  assert.deepEqual(m4a.items[0].variants.map((v) => v.label), ['M4A', 'MP3', 'Cover art']);
  assert.equal(m4a.items[1], photo);
  assert.equal(u.preferAudioFormat(res, 'mp3').items[0], res.items[0], 'already first: unchanged');
  assert.equal(u.preferAudioFormat(res, 'ogg'), res);
});

test('collectionOf and canMix', () => {
  const res = { site: 'Spotify', title: 'After Hours', items: [songItem('A', 'X'), songItem('B', 'Y')] };
  assert.deepEqual(u.collectionOf(res), { name: 'After Hours', total: 2 });
  assert.deepEqual(u.collectionOf({ ...res, collection: { name: 'The Weeknd · Top tracks' } }), { name: 'The Weeknd · Top tracks', total: 2 });
  assert.equal(u.canMix(res), true);
  assert.equal(u.canMix({ ...res, items: [res.items[0]] }), false, 'one song is not a mix');
  const video = { label: 'Clip', variants: [{ kind: 'video', url: 'https://x.test/a.mp4', ext: 'mp4', job: { type: 'mux', video: 'https://x.test/v', audio: 'https://x.test/a' } }] };
  assert.equal(u.canMix({ ...res, items: [res.items[0], video] }), false);
  const plainAudio = { label: 'Horse', variants: [{ kind: 'audio', url: 'https://x.test/horse.mp3', ext: '' }] };
  assert.equal(u.canMix({ ...res, items: [res.items[0], plainAudio] }), true);
});

test('bundleVariant makes one ZIP or mix from every item’s first choice', () => {
  const res = {
    site: 'Spotify',
    title: 'After Hours',
    collection: { name: 'After Hours', artist: 'The Weeknd', coverUrl: 'https://i.scdn.co/image/album', kind: 'album' },
    items: [songItem('Alone Again', 'The Weeknd'), songItem('Too Late', 'The Weeknd')],
  };
  const zip = u.bundleVariant(res, 'zip');
  assert.equal(zip.ext, 'zip');
  assert.equal(zip.filename, 'After Hours');
  assert.equal(zip.job.type, 'zip');
  assert.deepEqual(zip.job.entries.map((e) => [e.position, e.ext, e.job.format, e.filename]), [
    [1, 'mp3', 'mp3', 'The Weeknd - Alone Again'],
    [2, 'mp3', 'mp3', 'The Weeknd - Too Late'],
  ]);

  const mix = u.bundleVariant(u.preferAudioFormat(res, 'm4a'), 'mix', u.cleanSettings({ mixFormat: 'm4a' }));
  assert.equal(mix.ext, 'm4a');
  assert.equal(mix.filename, 'After Hours (mix)');
  assert.deepEqual(mix.job.tags, { title: 'After Hours (mix)', album: 'After Hours', artist: 'The Weeknd', coverUrl: 'https://i.scdn.co/image/album' });
  assert.deepEqual(mix.job.entries.map((e) => [e.title, e.artist, e.job.format]), [
    ['Alone Again', 'The Weeknd', 'm4a'],
    ['Too Late', 'The Weeknd', 'm4a'],
  ]);

  const noCollection = u.bundleVariant({ ...res, collection: undefined }, 'mix');
  assert.equal(noCollection.job.tags.artist, 'Various Artists');
  assert.equal(noCollection.job.tags.coverUrl, 'https://i.scdn.co/image/abc', 'falls back to the first song’s cover');
});

test('batchStatus adds a note to the success text', () => {
  const s = u.batchStatus({ started: 1, refused: 0, done: 1, failed: 0, error: '', note: '1 song couldn’t be added and was left out of the mix.', progress: {} });
  assert.equal(s.kind, 'success');
  assert.equal(s.text, 'Saved to your Downloads. 1 song couldn’t be added and was left out of the mix.');
});

// ---------------------------------------------------------------------------
// iTunes tags (background/metadata.js)
// ---------------------------------------------------------------------------

const release = (over) => ({
  kind: 'song',
  trackName: 'Blinding Lights',
  artistName: 'The Weeknd',
  collectionName: 'After Hours',
  collectionArtistName: 'The Weeknd',
  collectionId: 1499378108,
  trackTimeMillis: 200040,
  trackNumber: 9,
  trackCount: 14,
  discNumber: 1,
  discCount: 1,
  primaryGenreName: 'R&B/Soul',
  releaseDate: '2019-11-29T08:00:00Z',
  ...over,
});

test('metadata name helpers', () => {
  assert.equal(primaryArtist('The Weeknd, Daft Punk'), 'The Weeknd');
  assert.equal(primaryArtist('Simon & Garfunkel feat. X'), 'Simon');
  assert.equal(plainTitle('Here Comes The Sun - Remastered 2009'), 'Here Comes The Sun');
  assert.equal(plainTitle('Starboy (feat. Daft Punk)'), 'Starboy');
  assert.equal(plainTitle('Blinding Lights (Remix)'), 'Blinding Lights (Remix)');
  assert.equal(plainAlbum('After Hours - Single'), 'After Hours');
});

test('pickRelease prefers the original album over singles, deluxe editions and compilations', () => {
  const results = [
    release({ collectionName: 'The Highlights', collectionId: 1 }),
    release({ collectionName: 'Blinding Lights - Single', collectionId: 2, trackNumber: 1, trackCount: 1 }),
    release({ collectionName: 'After Hours (Deluxe)', collectionId: 3 }),
    release({ collectionId: 1499378108 }),
    release({ trackName: 'Blinding Lights (Remix)', collectionName: 'Remixes', collectionId: 4 }),
  ];
  const want = { title: 'Blinding Lights', artist: 'The Weeknd', durationMs: 200040 };
  assert.equal(pickRelease(results, want).collectionName, 'After Hours');
  assert.equal(pickRelease(results, { ...want, album: 'The Highlights' }).collectionName, 'The Highlights');
  assert.equal(pickRelease(results, { ...want, durationMs: 240000 }), null, 'a different length is a different recording');
  assert.equal(pickRelease(results, { ...want, artist: 'Someone Else' }), null);
  assert.equal(pickRelease(results, { ...want, durationMs: 0 }), null);
});

test('fillTags only fills gaps, and takes just the genre from another album', () => {
  assert.equal(fillTags({ title: 'A', artist: 'B', date: '2020' }, release()).date, '2020', 'a year that disagrees is kept');
  const tags = fillTags({ title: 'Blinding Lights', artist: 'The Weeknd', date: '2019' }, release());
  assert.deepEqual(tags, {
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    date: '2019-11-29',
    genre: 'R&B/Soul',
    album: 'After Hours',
    albumArtist: 'The Weeknd',
    trackNumber: 9,
    tracksTotal: 14,
  });
  const other = fillTags({ title: 'Blinding Lights', artist: 'The Weeknd', album: 'Blinding Lights', date: '2019' }, release());
  assert.deepEqual(other, { title: 'Blinding Lights', artist: 'The Weeknd', album: 'Blinding Lights', date: '2019', genre: 'R&B/Soul' });
  assert.equal(fillTags({ title: 'A', artist: 'B', date: '2021-01-01' }, release()).date, '2021-01-01', 'a full date is kept');
});

// ---------------------------------------------------------------------------
// ZIP names and CRC (offscreen/zip.js)
// ---------------------------------------------------------------------------

test('cleanZipNames makes safe, unique names', () => {
  assert.deepEqual(cleanZipNames(['a/b.mp3', 'A_b.mp3', '..hidden.txt', '', 'x:y?.jpg', 'Song.MP3', 'song.mp3']), [
    'a_b.mp3',
    'A_b (2).mp3',
    'hidden.txt',
    'file 4',
    'x_y_.jpg',
    'Song.MP3',
    'song (2).mp3',
  ]);
});

test('crc32 matches known values and can continue', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(0, bytes), 0xcbf43926);
  assert.equal(crc32(crc32(0, bytes.subarray(0, 4)), bytes.subarray(4)), 0xcbf43926);
  assert.equal(crc32(0, new Uint8Array(0)), 0);
});
