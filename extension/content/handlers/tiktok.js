/*
 * Just download it: TikTok handler.
 *
 *  - The video id comes from the player (id="xgwrapper-<n>-<videoId>"), a
 *    /video/<id> or /photo/<id> link in the post, or the address bar.
 *  - The data comes from the video's own page: TikTok embeds the post as JSON
 *    (#__UNIVERSAL_DATA_FOR_REHYDRATION__, older pages #SIGI_STATE) with every
 *    quality in video.bitrateInfo, slideshow photos, the sound and the cover.
 *    The page is fetched from this tab with the user's session.
 *  - TikTok's video servers check the site's cookies and referrer, so files are
 *    fetched inside the page (variant.via = 'page').
 *  - Button: a hover button on videos.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const ID_IN_PATH = /\/(?:video|photo)\/(\d{15,21})(?:[/?#]|$)/;

  function isTikTok(loc) {
    return /(^|\.)tiktok\.com$/i.test(loc.hostname);
  }

  function fromHref(href) {
    let u;
    try {
      u = new URL(String(href || ''), window.location.href);
    } catch {
      return null;
    }
    if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return null;
    const m = ID_IN_PATH.exec(u.pathname);
    if (!m) return null;
    const user = /^\/@([^/]+)\//.exec(u.pathname);
    return { id: m[1], username: user ? decodeURIComponent(user[1]) : '' };
  }

  const CONTAINERS =
    '[data-e2e="recommend-list-item-container"], [data-e2e="user-post-item"], [data-e2e*="video-item"], article, [class*="DivItemContainer"], [class*="ItemContainer"]';

  /** The post an element belongs to. */
  function postFrom(element) {
    const start = element && element.nodeType === 1 ? element : null;
    if (!start) return null;
    const link = start.closest('a[href]');
    const fromLink = link && fromHref(link.getAttribute('href'));
    if (fromLink) return fromLink;
    const wrapper = start.closest('[id^="xgwrapper-"]');
    const wm = wrapper && /^xgwrapper-\d+-(\d{15,21})$/.exec(wrapper.id);
    const container = start.closest(CONTAINERS);
    const inner = container && container.querySelector('a[href*="/video/"], a[href*="/photo/"]');
    const fromInner = inner && fromHref(inner.getAttribute('href'));
    if (wm) return { id: wm[1], username: fromInner ? fromInner.username : '' };
    if (fromInner) return fromInner;
    const innerWrapper = container && container.querySelector('[id^="xgwrapper-"]');
    const iw = innerWrapper && /^xgwrapper-\d+-(\d{15,21})$/.exec(innerWrapper.id);
    if (iw) return { id: iw[1], username: '' };
    return null;
  }

  function snapshot({ stack, target }) {
    for (const node of (stack && stack.length ? stack : [target]).filter(Boolean).slice(0, 12)) {
      const post = postFrom(node);
      if (post) return post;
    }
    return fromHref(window.location.href) || { id: '', username: '' };
  }

  /** The post's JSON from a TikTok page document. */
  function itemFromDocument(doc, id) {
    try {
      const universal = doc.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (universal) {
        const data = JSON.parse(universal.textContent);
        const scope = data && data.__DEFAULT_SCOPE__;
        const detail = scope && scope['webapp.video-detail'];
        const item = detail && detail.itemInfo && detail.itemInfo.itemStruct;
        if (item && String(item.id) === String(id)) return item;
      }
    } catch {
      /* try the older format */
    }
    try {
      const sigi = doc.getElementById('SIGI_STATE');
      if (sigi) {
        const data = JSON.parse(sigi.textContent);
        const item = data && data.ItemModule && data.ItemModule[id];
        if (item) return item;
      }
    } catch {
      /* not found */
    }
    return null;
  }

  function codecName(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('265') || t.includes('bytevc1') || t.includes('hevc')) return 'HEVC';
    if (t.includes('264')) return 'H.264';
    return '';
  }

  function firstUrl(list) {
    const urls = (Array.isArray(list) ? list : []).filter((u) => typeof u === 'string' && /^https:/i.test(u));
    return urls[0] || '';
  }

  /** Turn TikTok's itemStruct into a Resolution. */
  function buildResolution(item) {
    const author = (item.author && (item.author.uniqueId || item.author.nickname)) || (typeof item.author === 'string' ? item.author : '');
    const base = [author, util.formatDate(item.createTime), item.id].filter(Boolean).join('_');
    const items = [];

    const images = (item.imagePost && item.imagePost.images) || [];
    images.forEach((image, i) => {
      const list = (image.imageURL && image.imageURL.urlList) || [];
      const url = list.find((u) => /\.jpe?g/i.test(u)) || firstUrl(list);
      if (!url) return;
      const ext = util.extFromUrl(url) || 'jpg';
      items.push({
        label: images.length > 1 ? `Photo ${i + 1} of ${images.length}` : 'Photo',
        thumbnail: url,
        variants: [
          {
            kind: 'image',
            label: 'Original',
            detail: [image.imageWidth && image.imageHeight ? `${image.imageWidth} × ${image.imageHeight}` : '', ext.toUpperCase()].filter(Boolean).join(' · '),
            url,
            ext,
            filename: images.length > 1 ? `${base}_${i + 1}` : base,
            via: 'page',
          },
        ],
      });
    });

    const video = item.video || {};
    if (!images.length) {
      const seen = new Set();
      const qualities = (video.bitrateInfo || [])
        .map((b) => {
          const addr = b.PlayAddr || {};
          const url = firstUrl(addr.UrlList);
          const w = Number(addr.Width) || 0;
          const h = Number(addr.Height) || 0;
          return { url, w, h, side: w && h ? Math.min(w, h) : 0, codec: codecName(b.CodecType), size: Number(addr.DataSize) || 0, bitrate: Number(b.Bitrate) || 0 };
        })
        .filter((q) => q.url)
        // Best first; at the same size H.264 before HEVC (plays everywhere).
        .sort((a, b) => b.side - a.side || (a.codec === 'H.264' ? -1 : 0) - (b.codec === 'H.264' ? -1 : 0) || b.bitrate - a.bitrate)
        .filter((q) => {
          const key = `${q.side}|${q.codec}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      const variants = qualities.map((q, i) => ({
        kind: 'video',
        label: q.side ? `${q.side}p${q.codec === 'HEVC' ? ' HEVC' : ''}` : 'Video',
        detail: [q.w && q.h ? `${q.w} × ${q.h}` : '', q.codec, 'MP4'].filter(Boolean).join(' · '),
        url: q.url,
        ext: 'mp4',
        filename: i === 0 ? base : `${base}_${q.side}p${q.codec === 'HEVC' ? '_hevc' : ''}`,
        size: q.size,
        via: 'page',
      }));
      if (!variants.length && typeof video.playAddr === 'string' && /^https:/i.test(video.playAddr)) {
        variants.push({ kind: 'video', label: 'Video', detail: [video.width && video.height ? `${video.width} × ${video.height}` : '', 'MP4'].filter(Boolean).join(' · '), url: video.playAddr, ext: 'mp4', filename: base, via: 'page' });
      }
      if (typeof video.downloadAddr === 'string' && /^https:/i.test(video.downloadAddr)) {
        variants.push({ kind: 'video', group: 'Other', label: 'With TikTok watermark', detail: 'MP4', url: video.downloadAddr, ext: 'mp4', filename: `${base}_watermark`, via: 'page' });
      }
      const cover = video.originCover || video.cover;
      if (typeof cover === 'string' && /^https:/i.test(cover)) {
        variants.push({ kind: 'image', group: 'Other', label: 'Cover image', detail: util.extFromUrl(cover).toUpperCase() || 'Image', url: cover, ext: util.extFromUrl(cover) || 'jpg', filename: `${base}_cover`, via: 'page' });
      }
      if (variants.length) items.push({ label: 'Video', thumbnail: typeof video.cover === 'string' ? video.cover : '', variants });
    }

    const music = item.music || {};
    if (typeof music.playUrl === 'string' && /^https:/i.test(music.playUrl)) {
      const ext = util.extFromUrl(music.playUrl) || 'mp3';
      const sound = {
        kind: 'audio',
        group: 'Other',
        label: 'Sound',
        detail: [music.title, ext.toUpperCase()].filter(Boolean).join(' · '),
        url: music.playUrl,
        ext,
        filename: `${base}_sound`,
        via: 'page',
      };
      if (items.length === 1) items[0].variants.push(sound);
      else items.push({ label: 'Sound', thumbnail: '', variants: [{ ...sound, group: '' }] });
    }

    if (!items.length) return null;
    return { site: 'TikTok', title: author ? `@${author}` : 'TikTok', focus: 0, items };
  }

  const cache = new Map();

  async function fetchItem({ id, username }) {
    const fromPage = itemFromDocument(document, id);
    if (fromPage) return fromPage;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.time < 10 * 60 * 1000) return hit.promise;
    const promise = (async () => {
      const url = `${window.location.origin}/@${encodeURIComponent(username || 'i')}/video/${id}`;
      let res;
      try {
        res = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } });
      } catch {
        throw Object.assign(new Error('network'), { userMessage: 'Couldn’t reach TikTok.' });
      }
      const html = await res.text();
      const item = itemFromDocument(new DOMParser().parseFromString(html, 'text/html'), id);
      if (!item) {
        throw Object.assign(new Error('no item'), {
          userMessage: 'TikTok didn’t share this video’s details. Open the video on its own page and try again.',
        });
      }
      return item;
    })();
    cache.set(id, { time: Date.now(), promise });
    promise.catch(() => cache.delete(id));
    return promise;
  }

  // Other shapes a post's address takes (mobile pages, embeds, share pages).
  const PAGE_ID_PATHS = [/^\/v\/(\d{15,21})(?:\.html)?/, /^\/embed\/(?:v2\/)?(\d{15,21})/, /^\/player\/v1\/(\d{15,21})/, /^\/share\/(?:video|photo)\/(\d{15,21})/];

  /**
   * The post this page shows (a pasted link). vm.tiktok.com / vt.tiktok.com
   * short links have already redirected to the full address by now.
   */
  function pageSnapshot() {
    const loc = window.location;
    const post = fromHref(loc.href);
    if (post) return post;
    for (const re of PAGE_ID_PATHS) {
      const m = re.exec(loc.pathname);
      if (m) return { id: m[1], username: '' };
    }
    const params = new URLSearchParams(loc.search);
    const fromQuery = params.get('item_id') || params.get('share_item_id');
    if (/^\d{15,21}$/.test(fromQuery || '')) return { id: fromQuery, username: '' };
    // A login or verification page that kept the link.
    for (const key of ['redirect_url', 'redirect', 'next']) {
      const inner = params.get(key) && fromHref(params.get(key));
      if (inner) return inner;
    }
    throw Object.assign(new Error('not a post'), { final: true, userMessage: 'That TikTok page isn’t a single video or photo post. Paste the link to one post.' });
  }

  async function resolve(ctx) {
    const snap = ctx.snapshot || snapshot(ctx);
    if (!snap || !snap.id) return null;
    if (ctx.page) {
      // Asked again until the page answers: fetch the post's page at most every few seconds.
      const once = (JDI.generic && JDI.generic.pageOnce) || ((k, fn) => fn());
      return once(`tiktok:${snap.id}`, () => resolve({ ...ctx, page: false }), 4000);
    }
    const item = await fetchItem(snap);
    const resolution = buildResolution(item);
    if (!resolution) {
      throw Object.assign(new Error('no media'), { userMessage: 'TikTok didn’t offer a downloadable file for this post.' });
    }
    return resolution;
  }

  util.registerHandler({ id: 'tiktok', name: 'TikTok', priority: 100, matches: isTikTok, snapshot, pageSnapshot, pageGeneric: false, resolve });

  if (JDI.buttons && isTikTok(window.location)) {
    JDI.buttons.register((api) => {
      // TikTok's own volume and "..." buttons sit 8px inside the player's top
      // corners; this one goes straight to the left of the "..." button.
      api.hoverVideos({
        look: 'tiktok-overlay',
        size: 48,
        inset: 8,
        gap: 48,
        onClick: (video, hostEl) => JDI.core.openPicker({ handlerId: 'tiktok', snapshot: snapshot(api.centreOf(video)), anchor: hostEl }),
      });
    });
  }

  JDI.tiktok = { fromHref, postFrom, itemFromDocument, buildResolution, snapshot };
})();
