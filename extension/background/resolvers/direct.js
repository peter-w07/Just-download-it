/*
 * Direct links to a media file (…/clip.mp4, …/photo.jpg, an HLS playlist).
 * Links without a telling extension are checked with a HEAD request; anything
 * that isn't media returns null so the page is opened and looked at instead.
 */
import '../../shared/util.js';
import { timedFetch } from '../net.js';

const { util } = globalThis.JDI;

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|heic|bmp|mp4|m4v|mov|webm|mkv|m4a|mp3|aac|ogg|oga|opus|wav|flac|m3u8)$/i;

function kindOf(ext, mime) {
  if (/^image\//.test(mime) || /^(jpg|png|gif|webp|avif|heic|bmp|svg)$/.test(ext)) return 'image';
  if (/^audio\//.test(mime) || /^(m4a|mp3|aac|ogg|oga|opus|wav|flac)$/.test(ext)) return 'audio';
  return 'video';
}

function streamResolution(href, name) {
  return {
    site: '',
    title: name,
    focus: 0,
    items: [{ label: 'Stream', thumbnail: '', variants: [{ kind: 'video', label: 'MP4', detail: 'Saved from the stream on your computer', url: href, ext: 'mp4', filename: name, job: { type: 'hls', url: href } }] }],
  };
}

export default {
  id: 'direct',
  // Everything else gets a HEAD check; the popup falls back to opening the page.
  matches: (url) => /^https?:$/.test(url.protocol),
  async resolve(url) {
    const href = url.href;
    const name = util.basenameFromUrl(href) || url.hostname;
    const pathExt = (MEDIA_EXT.exec(url.pathname) || [])[1];

    if (pathExt && pathExt.toLowerCase() === 'm3u8') return streamResolution(href, name);

    let ext = pathExt ? util.normalizeExt(pathExt) : '';
    let mime = '';
    let size = 0;
    if (!ext) {
      if (!util.isPublicHttpUrl(href)) return null;
      const head = await timedFetch(href, { method: 'HEAD' }, 6000);
      if (!head || !head.ok) return null;
      mime = String(head.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (/mpegurl/i.test(mime)) return streamResolution(href, name);
      ext = util.extFromMime(mime);
      if (!ext) return null; // a web page
      size = Number(head.headers.get('content-length')) || 0;
    }
    const kind = kindOf(ext, mime);
    const variants = [{ kind, label: 'Original', detail: ext.toUpperCase(), url: href, ext, filename: name, size }];
    if (kind === 'video' && /^(mp4|m4v|mov)$/.test(ext) && /^https:/i.test(href)) {
      variants.push({ kind: 'audio', group: 'Audio only', label: 'MP3', detail: 'Converted on your computer', url: href, ext: 'mp3', filename: name, job: { type: 'mp3', audio: href } });
    }
    return {
      site: '',
      title: name,
      focus: 0,
      items: [{ label: kind === 'image' ? 'Image' : kind === 'audio' ? 'Audio' : 'Video', thumbnail: kind === 'image' ? href : '', variants }],
    };
  },
};
