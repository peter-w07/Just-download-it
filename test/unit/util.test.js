import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../extension/shared/util.js');
const u = globalThis.JDI.util;

const ch = (code) => String.fromCodePoint(code);

test('sanitizeSegment strips characters Chrome rejects', () => {
  assert.equal(u.sanitizeSegment('a<b>c:d"e/f|g?h*i'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(u.sanitizeSegment(`back${ch(92)}slash`), 'back_slash');
  assert.equal(u.sanitizeSegment(`tab${ch(9)}and${ch(0)}nul`), 'tab andnul');
  assert.equal(u.sanitizeSegment('100% real'), '100_ real');
  assert.equal(u.sanitizeSegment('IMG~1'), 'IMG-1');
  assert.equal(u.sanitizeSegment(`bad${ch(0xfdd0)}${ch(0xfffe)}chars`), 'badchars');
});

test('sanitizeSegment removes format characters (emoji joiners, bidi overrides)', () => {
  assert.equal(u.sanitizeSegment(`photo${ch(0x202e)}gpj.exe`), 'photogpj.exe');
  const family = `${ch(0x1f468)}${ch(0x200d)}${ch(0x1f469)}${ch(0x200d)}${ch(0x1f467)}`;
  assert.equal(u.sanitizeSegment(`trip ${family}`), `trip ${ch(0x1f468)}${ch(0x1f469)}${ch(0x1f467)}`);
  assert.equal(u.sanitizeSegment(`soft${ch(0xad)}hyphen`), 'softhyphen');
  assert.equal(u.sanitizeSegment(`line${ch(0x2028)}break`), 'line break');
  assert.equal(u.sanitizeSegment(`heart${ch(0x2764)}${ch(0xfe0f)}`), `heart${ch(0x2764)}${ch(0xfe0f)}`, 'variation selectors are fine');
});

test('sanitizeSegment trims dots and spaces at the edges', () => {
  assert.equal(u.sanitizeSegment('  ..hidden  '), 'hidden');
  assert.equal(u.sanitizeSegment('~temp'), '-temp');
  assert.equal(u.sanitizeSegment('name. . .'), 'name');
  assert.equal(u.sanitizeSegment('   '), '');
  assert.equal(u.sanitizeSegment(null), '');
});

test('sanitizeSegment avoids Windows reserved and shell-integrated names', () => {
  assert.equal(u.sanitizeSegment('CON'), '_CON');
  assert.equal(u.sanitizeSegment('nul.txt'), '_nul.txt');
  assert.equal(u.sanitizeSegment('com1'), '_com1');
  assert.equal(u.sanitizeSegment('CLOCK$'), '_CLOCK$');
  assert.equal(u.sanitizeSegment('desktop.ini'), '_desktop.ini');
  assert.equal(u.sanitizeSegment('console'), 'console');
  assert.equal(u.sanitizeSegment('shortcut.lnk'), 'shortcut.lnk_');
  assert.equal(u.sanitizeSegment('folder.{20D04FE0-3AEA-1069-A2D8-08002B30309D}'), 'folder.{20D04FE0-3AEA-1069-A2D8-08002B30309D}_');
});

test('sanitizeSegment truncates without splitting emoji', () => {
  const s = u.sanitizeSegment('😀'.repeat(50), 10);
  assert.equal(Array.from(s).length, 10);
  assert.ok(s.isWellFormed());
});

test('normalizeExt / extFromUrl / extFromMime', () => {
  assert.equal(u.normalizeExt('JPEG'), 'jpg');
  assert.equal(u.normalizeExt('.mp4'), 'mp4');
  assert.equal(u.normalizeExt('exe'), '');
  assert.equal(u.extFromUrl('https://scontent.cdninstagram.com/v/t51/123_n.jpg?stp=dst-jpg&oh=1'), 'jpg');
  assert.equal(u.extFromUrl('https://example.com/video.MP4#t=3'), 'mp4');
  assert.equal(u.extFromUrl('https://example.com/no-extension'), '');
  assert.equal(u.extFromUrl('https://example.com/file.php'), '');
  assert.equal(u.extFromUrl('data:image/png;base64,AAAA'), 'png');
  assert.equal(u.extFromUrl('not a url'), '');
  assert.equal(u.extFromMime('image/webp; charset=binary'), 'webp');
  assert.equal(u.extFromMime('audio/mp4'), 'm4a');
  assert.equal(u.extFromMime('text/html'), '');
});

test('basenameFromUrl', () => {
  assert.equal(u.basenameFromUrl('https://a.com/x/My%20Photo.jpeg?x=1'), 'My Photo');
  assert.equal(u.basenameFromUrl('https://a.com/'), '');
  assert.equal(u.basenameFromUrl('data:image/png;base64,AAAA'), '');
});

test('buildDownloadPath', () => {
  assert.equal(
    u.buildDownloadPath({ folder: 'Just Download It', site: 'Instagram', base: 'user_2026-09-17_DdRzldIALvw', ext: 'jpeg' }),
    'Just Download It/Instagram/user_2026-09-17_DdRzldIALvw.jpg',
  );
  assert.equal(u.buildDownloadPath({ folder: '', site: '', base: 'a', ext: 'png' }), 'a.png');
  assert.equal(u.buildDownloadPath({ folder: '../../etc', site: 'x', base: 'a', ext: 'png' }), '_.._etc/x/a.png');
  assert.equal(u.buildDownloadPath({ folder: 'f', base: 'a', ext: '' }), '', 'no extension means let Chrome decide');
  assert.equal(u.buildDownloadPath({ folder: 'f', base: '...', ext: 'jpg' }), '', 'empty name means let Chrome decide');
});

test('parseSrcset handles commas inside URLs and descriptors', () => {
  const out = u.parseSrcset(
    'https://res.cloudinary.com/x/image/upload/w_320,h_200/a.jpg 320w, https://res.cloudinary.com/x/image/upload/w_640,h_400/a.jpg 640w,/rel/b.png 2x',
    'https://site.example/page',
  );
  assert.deepEqual(out, [
    { url: 'https://res.cloudinary.com/x/image/upload/w_320,h_200/a.jpg', width: 320 },
    { url: 'https://res.cloudinary.com/x/image/upload/w_640,h_400/a.jpg', width: 640 },
    { url: 'https://site.example/rel/b.png', density: 2 },
  ]);
  assert.deepEqual(u.parseSrcset('', 'https://a.com'), []);
  assert.deepEqual(u.parseSrcset('  a.jpg  ', 'https://a.com/'), [{ url: 'https://a.com/a.jpg' }]);
  assert.deepEqual(u.parseSrcset('a.jpg,, b.jpg 1.5x', 'https://a.com/'), [
    { url: 'https://a.com/a.jpg' },
    { url: 'https://a.com/b.jpg', density: 1.5 },
  ]);
});

test('formatBytes / formatDate', () => {
  assert.equal(u.formatBytes(0), '');
  assert.equal(u.formatBytes(512), '512 B');
  assert.equal(u.formatBytes(5921467), '5.6 MB');
  assert.equal(u.formatBytes(114853), '112 KB');
  assert.equal(u.formatDate(1789611915), '2026-09-17');
  assert.equal(u.formatDate('nope'), '');
});

test('handler registry replaces by id and sorts by priority', () => {
  globalThis.JDI.handlers.length = 0;
  u.registerHandler({ id: 'generic', priority: 0, matches: () => true });
  u.registerHandler({ id: 'site', priority: 100, matches: (loc) => loc.hostname === 'site.com' });
  u.registerHandler({ id: 'broken', priority: 50, matches: () => { throw new Error('boom'); } });
  u.registerHandler({ id: 'generic', priority: 1, matches: () => true, replaced: true });
  assert.deepEqual(u.handlersFor({ hostname: 'site.com' }).map((h) => h.id), ['site', 'generic']);
  assert.deepEqual(u.handlersFor({ hostname: 'other.com' }).map((h) => h.id), ['generic']);
  assert.equal(globalThis.JDI.handlers.filter((h) => h.id === 'generic').length, 1);
  assert.ok(globalThis.JDI.handlers.find((h) => h.id === 'generic').replaced);
});
