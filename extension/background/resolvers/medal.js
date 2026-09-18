/*
 * Medal clips (medal.tv): resolved from the service worker, without cookies,
 * from the clip's public page.
 *
 *  - Any clip link form (see content/handlers/medal.js) becomes
 *    https://medal.tv/clips/{id}, which redirects to the clip page.
 *  - The page is a Next.js app; its streamed data (self.__next_f.push) holds the
 *    clip object: contentUrl (the original upload, no watermark),
 *    socialMediaVideo (the share copy with Medal's watermark), contentUrlHls
 *    (a playlist with smaller sizes), sourceWidth/sourceHeight, thumbnail1080p…
 *    and poster (the uploader). contentUrl1080p/720p/… currently all point back
 *    at the original (marked "&missing"), so smaller sizes come from the HLS
 *    renditions and are saved as MP4 on this computer.
 *  - Fallback: the page's JSON-LD VideoObject (original MP4, title, author).
 *  - A clip that is private, deleted or doesn't exist gives a page without
 *    either, which becomes a friendly error.
 */
import '../../shared/util.js';
import '../../content/handlers/medal.js';
import { fetchText, timedFetch, userError } from '../net.js';

const { util, medal } = globalThis.JDI;

const SITE = 'Medal';
const GONE = 'Medal doesn’t share this clip publicly (it may be private or deleted).';

/** Every JSON row of the page's Next.js flight data. */
function flightRows(html) {
  let text = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      text += JSON.parse(m[1]);
    } catch {
      /* not a string chunk */
    }
  }
  // Rows are "{hex id}:{json}" lines, but a text row ("{id}:T{length},…") has no
  // line break after it, so the next row can start mid-line: try each place a
  // row could start ("id:[" or "id:{" never occurs inside JSON itself).
  const rows = [];
  for (const line of text.split(String.fromCharCode(10))) {
    if (!line.includes('"contentId"')) continue;
    for (const m of line.matchAll(/[0-9a-f]{1,8}:(?=[[{])/g)) {
      try {
        rows.push(JSON.parse(line.slice(m.index + m[0].length)));
        break;
      } catch {
        /* not a row start */
      }
    }
  }
  return rows;
}

/** The clip object for `id` in the flight data (the fullest copy), or null. */
function findClip(rows, id) {
  const found = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 80 || found.length > 20) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (node.contentId === id && (typeof node.contentUrl === 'string' || typeof node.contentTitle === 'string')) found.push(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(rows, 0);
  return found.find((c) => typeof c.contentUrl === 'string' && /^https:/i.test(c.contentUrl)) || found[0] || null;
}

/** The same fields from the page's JSON-LD VideoObject, or null. */
function clipFromJsonLd(html, id) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    for (const node of [].concat(data, (data && data['@graph']) || [])) {
      if (!node || node['@type'] !== 'VideoObject' || typeof node.contentUrl !== 'string') continue;
      if (node['@id'] && !String(node['@id']).includes(id)) continue;
      const thumbs = [].concat(node.thumbnailUrl || []).filter((u) => typeof u === 'string' && /^https:/i.test(u));
      return {
        contentId: id,
        contentTitle: typeof node.name === 'string' ? node.name : '',
        contentUrl: node.contentUrl,
        poster: { displayName: node.author && typeof node.author.name === 'string' ? node.author.name : '' },
        thumbnail1080p: thumbs[0] || '',
        thumbnail480p: thumbs[2] || thumbs[thumbs.length - 1] || '',
      };
    }
  }
  return null;
}

/** Renditions listed in an HLS master playlist: [{ url, width, height, name }]. */
async function hlsRenditions(masterUrl) {
  if (!/^https:\/\/([a-z0-9-]+\.)*medal\.tv\//i.test(String(masterUrl || ''))) return [];
  const res = await timedFetch(masterUrl, {}, 8000);
  if (!res || !res.ok) return [];
  const text = await res.text().catch(() => '');
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const size = /RESOLUTION=([0-9]+)x([0-9]+)/.exec(lines[i]);
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
    const uri = (lines[j] || '').trim();
    if (!uri) continue;
    let url;
    try {
      url = new URL(uri, masterUrl).href;
    } catch {
      continue;
    }
    const name = (/\/([^/?]+)\.m3u8/.exec(url) || [])[1] || '';
    out.push({ url, width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0, name });
  }
  return out;
}

const httpsOr = (value) => (typeof value === 'string' && /^https:/i.test(value) ? value : '');
const shortSide = (w, h) => (w && h ? Math.min(w, h) : 0);

async function buildResolution(clip, id) {
  const title = String(clip.contentTitle || '').trim() || 'Medal clip';
  const poster = clip.poster || {};
  const uploader = String(poster.displayName || poster.userName || '').trim();
  const base = `${Array.from(title).slice(0, 80).join('').trim()} [${id}]`;
  const width = Number(clip.sourceWidth) || 0;
  const height = Number(clip.sourceHeight) || 0;
  const sourceShort = shortSide(width, height);

  const variants = [];
  const original = httpsOr(clip.contentUrl);
  if (original) {
    variants.push({
      kind: 'video',
      label: sourceShort ? `${sourceShort}p` : 'Original',
      detail: [width && height ? `${width} × ${height}` : '', 'MP4', 'original, no watermark'].filter(Boolean).join(' · '),
      url: original,
      ext: 'mp4',
      filename: `${base} ${sourceShort ? `${sourceShort}p` : 'original'}`,
      width,
      height,
    });
  }

  // Smaller sizes from the HLS playlist (skipping the copy of the original).
  const renditions = await hlsRenditions(httpsOr(clip.contentUrlHls));
  const seen = new Set();
  renditions
    .filter((r) => shortSide(r.width, r.height) && (!original || (r.name !== 'source' && (!sourceShort || shortSide(r.width, r.height) < sourceShort))))
    .sort((a, b) => shortSide(b.width, b.height) - shortSide(a.width, a.height))
    .forEach((r) => {
      const p = shortSide(r.width, r.height);
      if (seen.has(p)) return;
      seen.add(p);
      variants.push({
        kind: 'video',
        label: `${p}p`,
        detail: `${r.width} × ${r.height} · MP4`,
        url: r.url,
        ext: 'mp4',
        filename: `${base} ${p}p`,
        width: r.width,
        height: r.height,
        job: { type: 'hls', url: r.url },
      });
    });

  const social = httpsOr(clip.socialMediaVideo);
  if (social && social !== original) {
    // An extra when there's a copy without the watermark; otherwise the main video.
    variants.push({
      kind: 'video',
      ...(variants.length ? { group: 'Other' } : {}),
      label: 'With Medal watermark',
      detail: 'MP4 · the copy Medal shares to other sites',
      url: social,
      ext: 'mp4',
      filename: `${base} watermark`,
    });
  }

  const thumbnail = httpsOr(clip.thumbnail1080p) || httpsOr(clip.thumbnail720p) || httpsOr(clip.thumbnail);
  if (thumbnail) {
    const ext = util.extFromUrl(thumbnail) || 'jpg';
    variants.push({
      kind: 'image',
      group: 'Other',
      label: 'Thumbnail',
      detail: ext.toUpperCase(),
      url: thumbnail,
      ext,
      filename: `${base} thumbnail`,
    });
  }

  if (!variants.some((v) => v.kind === 'video')) return null;
  return {
    site: SITE,
    title,
    focus: 0,
    items: [
      {
        label: uploader ? `by ${uploader}` : 'Clip',
        thumbnail: httpsOr(clip.thumbnail480p) || httpsOr(clip.thumbnail720p) || thumbnail,
        variants,
      },
    ],
  };
}

export default {
  id: 'medal',
  matches: (url) => !!medal.clipIdFromUrl(url.href),
  async resolve(url) {
    const id = medal.clipIdFromUrl(url.href);
    if (!id) return null;
    const html = await fetchText(medal.clipUrl(id), { site: SITE, headers: { Accept: 'text/html' } });
    const clip = findClip(flightRows(html), id) || clipFromJsonLd(html, id);
    if (!clip) throw userError('medal-gone', GONE);
    if (!httpsOr(clip.contentUrl) && !httpsOr(clip.socialMediaVideo)) {
      if (clip.dmcaTakedown) throw userError('medal-dmca', 'Medal took this clip down after a copyright claim.');
      if (clip.processed === 0) throw userError('medal-processing', 'Medal is still processing this clip. Try again in a minute.');
      throw userError('medal-private', 'This Medal clip is private or only visible to signed-in viewers, so it can’t be saved.');
    }
    const resolution = await buildResolution(clip, id);
    if (!resolution) throw userError('medal-gone', GONE);
    return resolution;
  },
};

export { flightRows, findClip, clipFromJsonLd };
