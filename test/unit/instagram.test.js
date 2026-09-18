import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { photo, reel, carousel } from '../fixtures/instagram.js';

globalThis.DOMParser = DOMParser;
await import('../../extension/shared/util.js');
await import('../../extension/content/handlers/instagram.js');
const ig = globalThis.JDI.instagram;

const CDN = 'https://scontent-lhr8-1.cdninstagram.com';

test('shortcode <-> pk (vectors verified against the live API)', () => {
  const vectors = {
    DdRzldIALvw: '3986194019465083888',
    DdUtqbFMQvn: '3987012397518883815',
    DdW9NvLJmhn: '3987643744926460007',
  };
  for (const [code, pk] of Object.entries(vectors)) {
    assert.equal(ig.shortcodeToPk(code), pk);
    assert.equal(ig.pkToShortcode(pk), code);
  }
  assert.equal(ig.pkToShortcode('3987643744926460007_1234'), 'DdW9NvLJmhn', 'story ids carry _<user pk>');
  assert.equal(ig.shortcodeToPk('DdRzldIALvw' + 'X'.repeat(28)), '3986194019465083888', 'private-account shortcodes are longer');
  assert.equal(ig.shortcodeToPk('bad!code'), '');
  assert.equal(ig.shortcodeToPk(''), '');
  assert.equal(ig.pkToShortcode('abc'), '');
});

test('shortcodeFromPath covers every URL shape Instagram uses', () => {
  assert.equal(ig.shortcodeFromPath('/p/DdRzldIALvw/'), 'DdRzldIALvw');
  assert.equal(ig.shortcodeFromPath('/some.user/p/DdRzldIALvw/'), 'DdRzldIALvw');
  assert.equal(ig.shortcodeFromPath('/some.user/reel/DdUtqbFMQvn/'), 'DdUtqbFMQvn');
  assert.equal(ig.shortcodeFromPath('/reels/DdUtqbFMQvn/'), 'DdUtqbFMQvn');
  assert.equal(ig.shortcodeFromPath('/reel/DdUtqbFMQvn'), 'DdUtqbFMQvn');
  assert.equal(ig.shortcodeFromPath('/tv/B_abc-12345/'), 'B_abc-12345');
  assert.equal(ig.shortcodeFromPath('/p/DdRzldIALvw/c/17988679980101802/'), 'DdRzldIALvw');
  assert.equal(ig.shortcodeFromPath('/p/DdRzldIALvw/liked_by/'), 'DdRzldIALvw');
  assert.equal(ig.shortcodeFromPath('https://www.instagram.com/p/DdRzldIALvw/?img_index=2'), 'DdRzldIALvw');
  assert.equal(ig.shortcodeFromPath('/p/DdRzldIALvw/embed/captioned/'), 'DdRzldIALvw');
  assert.equal(ig.shortcodeFromPath('/reels/audio/1107660630498769/'), '');
  assert.equal(ig.shortcodeFromPath('/explore/'), '');
  assert.equal(ig.shortcodeFromPath('/some.user/'), '');
  assert.equal(ig.shortcodeFromPath('/some.user/reels/'), '');
  assert.equal(ig.shortcodeFromPath('/preview/p/'), '');
});

test('photo: drops square crops, sorts biggest first, labels the original', () => {
  const res = ig.buildResolution(photo(CDN));
  assert.equal(res.site, 'Instagram');
  assert.equal(res.title, '@some.user');
  assert.equal(res.items.length, 1);
  const v = res.items[0].variants;
  assert.deepEqual(v.map((x) => x.width), [1440, 1080, 720, 640, 480, 320, 240]);
  assert.ok(v.every((x) => Math.abs(x.width / x.height - 0.8) < 0.01), 'no square crops');
  assert.equal(v[0].label, 'Original');
  assert.equal(v[0].detail, '1440 × 1800 · JPG');
  assert.equal(v[0].filename, 'some.user_2026-09-15_DdW9NvLJmhn');
  assert.equal(v[1].filename, 'some.user_2026-09-15_DdW9NvLJmhn_1080w');
  assert.equal(v[0].ext, 'jpg');
  assert.match(res.items[0].thumbnail, /p240x240/);
});

test('photo: original larger than every candidate is labelled honestly', () => {
  const p = photo(CDN);
  p.original_width = 4000;
  p.original_height = 5000;
  const v = ig.buildResolution(p).items[0].variants;
  assert.equal(v[0].label, 'Largest available');
});

test('reel: sharper DASH track combined with audio comes first, then the MP4 with sound', () => {
  const res = ig.buildResolution(reel(CDN));
  const v = res.items[0].variants;
  assert.equal(res.items[0].label, 'Video');
  const labels = v.map((x) => `${x.group || ''}|${x.label}`);
  assert.deepEqual(labels, ['|1080p MP4', '|720p MP4', 'Other|Audio only', 'Other|Cover image']);

  assert.equal(v[0].detail, '1080 × 1920 · VP9 · with sound');
  assert.equal(v[0].filename, 'reel_maker_2026-09-14_DdUtqbFMQvn');
  assert.deepEqual(v[0].job, {
    type: 'mux',
    video: `${CDN}/o1/v/t2/f2/m78/video-1080.mp4?efg=x&oh=2`,
    audio: `${CDN}/o1/v/t2/f2/m69/audio.mp4?efg=y&oh=4`,
  }, 'XML entities decoded, best video + best audio');

  assert.equal(v[1].detail, '720 × 1280 · with sound');
  assert.equal(v[1].ext, 'mp4');
  assert.equal(v[1].job, undefined);
  assert.equal(v[1].filename, 'reel_maker_2026-09-14_DdUtqbFMQvn_720p');
  assert.match(v[1].url, /progressive-720\.mp4\?efg=101/, 'deduped to the first listing');

  assert.equal(v[2].ext, 'm4a');
  assert.equal(v[2].detail, 'M4A · 59 kbps');
  assert.deepEqual(v[2].job, { type: 'mux', audio: `${CDN}/o1/v/t2/f2/m69/audio.mp4?efg=y&oh=4` }, 'repackaged so Chrome keeps .m4a');
  assert.equal(v[2].filename, 'reel_maker_2026-09-14_DdUtqbFMQvn_audio');
  assert.equal(v[3].kind, 'image');
  assert.equal(v[3].filename, 'reel_maker_2026-09-14_DdUtqbFMQvn_cover');
});

test('reel whose MP4 is already the sharpest needs no combining', () => {
  const r = reel(CDN);
  r.video_versions = r.video_versions.map((x) => ({ ...x, width: 1080, height: 1920 }));
  const v = ig.buildResolution(r).items[0].variants;
  assert.deepEqual(v.map((x) => x.label), ['1080p MP4', 'Audio only', 'Cover image']);
  assert.equal(v[0].job, undefined);
  assert.equal(v[0].filename, 'reel_maker_2026-09-14_DdUtqbFMQvn');
});

test('reel without sound: silent tracks are offered as plain files', () => {
  const r = reel(CDN);
  r.has_audio = false;
  const v = ig.buildResolution(r).items[0].variants;
  assert.equal(v[0].label, '1080p MP4');
  assert.equal(v[0].detail, '1080 × 1920 · VP9 · no sound');
  assert.equal(v[0].job, undefined);
  assert.match(v[0].url, /video-1080\.mp4/);
  assert.equal(v[1].detail, '720 × 1280 · no sound');
  assert.ok(!v.some((x) => x.kind === 'audio'));
});

test('reel with a broken manifest still offers the MP4', () => {
  const r = reel(CDN);
  r.video_dash_manifest = '<MPD><Period>';
  const v = ig.buildResolution(r).items[0].variants;
  assert.equal(v[0].label, '720p MP4');
  assert.equal(v[0].filename, 'reel_maker_2026-09-14_DdUtqbFMQvn');
  assert.ok(!v.some((x) => x.kind === 'audio'));
});

test('story photo that Instagram turned into a video offers the photo first', () => {
  const r = reel(CDN);
  r.original_media_type = 1;
  r.product_type = 'story';
  const res = ig.buildResolution(r, { kindHint: 'story' });
  const v = res.items[0].variants;
  assert.equal(res.items[0].label, 'Story photo');
  assert.equal(v[0].kind, 'image');
  assert.ok(v.some((x) => x.group === 'As a video' && x.kind === 'video'));
});

test('profile picture variants', () => {
  const res = ig.profilePictureResolution({
    username: 'some.user',
    hd_profile_pic_url_info: { url: `${CDN}/v/t51/pic_n.jpg?stp=dst-jpg_s1080x1080&oh=1`, width: 1080, height: 1080 },
    hd_profile_pic_versions: [
      { url: `${CDN}/v/t51/pic_n.jpg?stp=dst-jpg_s320x320&oh=2`, width: 320, height: 320 },
      { url: `${CDN}/v/t51/pic_n.jpg?stp=dst-jpg_s640x640&oh=3`, width: 640, height: 640 },
      { url: `${CDN}/v/t51/pic_n.jpg?stp=dst-jpg_s1080x1080&oh=4`, width: 1080, height: 1080 },
    ],
  });
  const v = res.items[0].variants;
  assert.deepEqual(v.map((x) => x.width), [1080, 640, 320]);
  assert.equal(v[0].filename, 'some.user_profile-picture');
  assert.equal(res.items[0].label, 'Profile picture');
});

test('imageExt trusts stp over the path; usernameFromPath', () => {
  assert.equal(ig.imageExt(`${CDN}/v/t51/abc_n.webp?stp=dst-jpg_e35&oh=1`), 'jpg');
  assert.equal(ig.imageExt(`${CDN}/v/t51/abc_n.jpg?stp=dst-webp_s640x640&oh=1`), 'webp');
  assert.equal(ig.imageExt(`${CDN}/v/t51/abc_n.png?oh=1`), 'png');
  assert.equal(ig.imageExt(`${CDN}/v/t51/abc?oh=1`), 'jpg');
  assert.equal(ig.usernameFromPath('/some.user/'), 'some.user');
  assert.equal(ig.usernameFromPath('https://www.instagram.com/some_user'), 'some_user');
  assert.equal(ig.usernameFromPath('/explore/'), '');
  assert.equal(ig.usernameFromPath('/some.user/p/DdRzldIALvw/'), '');
  assert.equal(ig.usernameFromPath('/reels/'), '');
});

test('carousel: numbered items, mixed photo/video, focus by clicked filename', () => {
  const media = carousel(CDN);
  const res = ig.buildResolution(media, { focus: { fileKeys: ['770002_0818699158354293_n.jpg'] } });
  assert.equal(res.items.length, 4);
  assert.deepEqual(res.items.map((i) => i.label), ['Photo 1 of 4', 'Video 2 of 4', 'Photo 3 of 4', 'Photo 4 of 4']);
  assert.equal(res.focus, 3, 'file 770002 is the 4th slide because the video sits at index 1');
  assert.equal(res.items[0].variants[0].filename, 'jack.example_2026-09-13_DdRzldIALvw_01');
  assert.equal(res.items[1].variants[0].filename, 'jack.example_2026-09-13_DdRzldIALvw_02');
  assert.equal(res.items[0].variants[0].width, 3273);

  const byCover = ig.buildResolution(media, { focus: { fileKeys: ['770009_video_cover_n.jpg'] } });
  assert.equal(byCover.focus, 1, 'video slide found through its cover image');

  const byIndex = ig.buildResolution(media, { focus: { fileKeys: ['unrelated.jpg'], index: 2 } });
  assert.equal(byIndex.focus, 2, 'falls back to the carousel position');

  const outOfRange = ig.buildResolution(media, { focus: { index: 12 } });
  assert.equal(outOfRange.focus, 0);
});

test('story items are named after their pk', () => {
  const s = photo(CDN, { pk: '3990000000000000001' });
  delete s.code;
  s.product_type = 'story';
  const res = ig.buildResolution(s, { kindHint: 'story', focus: { pk: '3990000000000000001_1234' } });
  assert.equal(res.items[0].label, 'Story photo');
  assert.equal(res.items[0].variants[0].filename, 'some.user_2026-09-15_story_3990000000000000001');
});

test('fileKey ignores query strings and hosts', () => {
  assert.equal(ig.fileKey(`${CDN}/v/t51/abc_n.jpg?stp=dst-jpg_p1080x1080&oh=1`), 'abc_n.jpg');
  assert.equal(ig.fileKey('https://other-cdn.fbcdn.net/v/abc_n.jpg?x=2'), 'abc_n.jpg');
});
