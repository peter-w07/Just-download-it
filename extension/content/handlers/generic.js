/*
 * Just download it: generic handler, the fallback for every site.
 *
 * Handles plain <img> (with srcset / <picture> / lazy-load attributes and
 * "click to enlarge" links), <video>/<audio> with real file URLs, CSS
 * background images, and finally the page's own preview image (og:image).
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-full', 'data-hi-res-src', 'data-zoom-src'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

  function hostLabel() {
    return window.location.hostname.replace(/^www\./, '');
  }

  function absolute(url) {
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return '';
    }
  }

  function usable(url) {
    return /^(https?:|data:(image|video|audio)\/)/i.test(url || '');
  }

  function nameFor(url, fallback) {
    const fromUrl = util.basenameFromUrl(url);
    if (fromUrl && fromUrl.length >= 3) return fromUrl;
    return `${hostLabel()}_${fallback}`;
  }

  // ---------------------------------------------------------------------------
  // <img>
  // ---------------------------------------------------------------------------

  function imageCandidates(img) {
    const list = [];
    const add = (url, extra) => {
      const href = absolute(url);
      if (!usable(href)) return;
      const existing = list.find((c) => c.url === href);
      if (existing) Object.assign(existing, { ...extra, ...existing });
      else list.push({ url: href, ...extra });
    };

    // A link around the image that points straight at an image file is
    // usually the full-size version ("click to enlarge").
    const link = img.closest('a[href]');
    if (link && util.extFromUrl(link.href) && /^(jpg|png|gif|webp|avif|heic|bmp)$/.test(util.extFromUrl(link.href))) {
      add(link.href, { linked: true });
    }

    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    if (picture) {
      for (const source of picture.querySelectorAll('source')) {
        const ext = util.extFromMime(source.type);
        for (const c of util.parseSrcset(source.srcset || source.getAttribute('data-srcset'), document.baseURI)) {
          add(c.url, { width: c.width, density: c.density, ext });
        }
      }
    }
    for (const c of util.parseSrcset(img.getAttribute('srcset'), document.baseURI)) add(c.url, { width: c.width, density: c.density });
    for (const attr of LAZY_SRCSET_ATTRS) {
      for (const c of util.parseSrcset(img.getAttribute(attr), document.baseURI)) add(c.url, { width: c.width, density: c.density });
    }
    for (const attr of LAZY_SRC_ATTRS) if (img.getAttribute(attr)) add(img.getAttribute(attr), {});
    if (img.currentSrc) {
      // naturalWidth/Height are divided by the srcset density Chrome picked, so
      // recover the file's real pixel size from the descriptor when there is one.
      const shown = list.find((c) => c.url === absolute(img.currentSrc)) || {};
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      let width = nw;
      let height = nh;
      if (nw && nh && shown.width) {
        width = shown.width;
        height = Math.round((nh * shown.width) / nw);
      } else if (nw && nh && shown.density) {
        width = Math.round(nw * shown.density);
        height = Math.round(nh * shown.density);
      }
      add(img.currentSrc, { shown: true, width: width || undefined, height: height || undefined });
      if (shown.url && !shown.height && height) shown.height = height;
    }
    if (img.getAttribute('src')) add(img.getAttribute('src'), {});

    // Best first: linked full-size, then widest, then highest density, then what's shown.
    const score = (c) => (c.linked ? 1e9 : 0) + (c.width || 0) * 10 + (c.density || 0) * 1000 + (c.shown ? 1 : 0);
    return list.sort((a, b) => score(b) - score(a));
  }

  function imageItem(img, candidates = imageCandidates(img)) {
    if (!candidates.length) return null;
    const title = (img.alt || '').trim();
    const variants = candidates.map((c, i) => {
      const ext = c.ext || util.extFromUrl(c.url);
      // Width alone is already in the label ("1200px wide"), so the detail only shows full dimensions.
      const size = c.width && c.height ? `${c.width} × ${c.height}` : !c.width && c.density ? `${c.density}x` : '';
      let label = 'Image';
      if (c.linked) label = 'Full size (linked)';
      else if (i === 0 && candidates.length > 1) label = 'Largest';
      else if (c.shown) label = 'As shown on the page';
      else if (c.width) label = `${c.width}px wide`;
      return {
        kind: 'image',
        label,
        detail: [size, ext.toUpperCase()].filter(Boolean).join(' · '),
        url: c.url,
        ext,
        filename: nameFor(c.url, 'image'),
        width: c.width,
      };
    });
    return { label: title ? title.slice(0, 60) : 'Image', thumbnail: img.currentSrc || candidates[0].url, variants };
  }

  // ---------------------------------------------------------------------------
  // <video> / <audio>
  // ---------------------------------------------------------------------------

  function mediaItem(media) {
    const kind = media.tagName === 'AUDIO' ? 'audio' : 'video';
    const variants = [];
    const seen = new Set();
    const add = (url, { type, quality } = {}) => {
      const href = absolute(url);
      if (!usable(href) || seen.has(href)) return;
      seen.add(href);
      const ext = util.extFromMime(type) || util.extFromUrl(href);
      variants.push({
        kind,
        label: quality ? `${quality}` : kind === 'audio' ? 'Audio' : 'Video',
        detail: [ext.toUpperCase()].filter(Boolean).join(' · '),
        url: href,
        ext,
        filename: nameFor(href, kind),
      });
    };

    for (const source of media.querySelectorAll('source[src]')) {
      const quality = source.getAttribute('size') || source.getAttribute('res') || source.getAttribute('label') || source.getAttribute('data-quality') || '';
      add(source.getAttribute('src'), { type: source.type, quality: quality && /^\d+$/.test(quality) ? `${quality}p` : quality });
    }
    if (media.currentSrc) add(media.currentSrc, {});
    if (media.getAttribute('src')) add(media.getAttribute('src'), {});

    // Streams (blob:/MediaSource) can't be saved as a file without site support.
    const streamed = !variants.length && /^blob:/i.test(media.currentSrc || media.src || '');

    if (kind === 'video' && media.poster) {
      const poster = absolute(media.poster);
      if (usable(poster)) {
        variants.push({
          kind: 'image',
          group: 'Other',
          label: 'Poster image',
          detail: util.extFromUrl(poster).toUpperCase(),
          url: poster,
          ext: util.extFromUrl(poster),
          filename: `${nameFor(variants[0] ? variants[0].url : poster, 'video')}_poster`,
        });
      }
    }

    if (streamed && variants.length === 0) {
      const err = new Error('streamed media');
      err.userMessage = "This video streams in small pieces, so it can't be saved directly on this site yet.";
      throw err;
    }
    if (!variants.length) return null;
    return { label: kind === 'audio' ? 'Audio' : 'Video', thumbnail: kind === 'video' ? absolute(media.poster || '') : '', variants, streamed };
  }

  // ---------------------------------------------------------------------------
  // Single URL items (Chrome's srcUrl/linkUrl, backgrounds, og:image)
  // ---------------------------------------------------------------------------

  function urlItem(url, label, kind) {
    if (!usable(url)) return null;
    const ext = util.extFromUrl(url);
    const guessedKind = kind || (/^(mp4|m4v|mov|webm|mkv)$/.test(ext) ? 'video' : /^(m4a|mp3|aac|ogg|oga|opus|wav|flac)$/.test(ext) ? 'audio' : 'image');
    return {
      label,
      thumbnail: guessedKind === 'image' ? url : '',
      variants: [
        {
          kind: guessedKind,
          label,
          detail: ext.toUpperCase(),
          url,
          ext,
          filename: nameFor(url, guessedKind),
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Page mode: the page as a whole (a link pasted into the toolbar popup)
  // ---------------------------------------------------------------------------

  const PAGE_MAX_ITEMS = 60;
  const PAGE_MIN_SIDE = 200;
  const PROBE_TIMEOUT_MS = 2000;
  const PROBE_MAX = 40;
  const FILE_EXT = /^(mp4|m4v|mov|webm|mkv|ogv|m4a|mp3|aac|ogg|oga|opus|wav|flac)$/;

  const pageMemo = new Map();
  /**
   * Run fn once per key for ttlMs. The service worker asks a page again and
   * again until it answers, so handlers use this to not repeat network
   * requests (or re-hit rate limits) on every retry. Errors are kept too.
   */
  function pageOnce(key, fn, ttlMs = 30000) {
    const hit = pageMemo.get(key);
    if (hit && Date.now() - hit.time < ttlMs) return hit.promise;
    const promise = Promise.resolve().then(fn);
    pageMemo.set(key, { time: Date.now(), promise });
    promise.catch(() => {}); // callers handle it; don't report as unhandled
    return promise;
  }

  /** A site handler for this page said a page-wide scan makes no sense here. */
  function pageScanDeferred() {
    return util.handlersFor(window.location).some((h) => {
      if (h.id === 'generic' || !('pageGeneric' in h)) return false;
      try {
        return typeof h.pageGeneric === 'function' ? !h.pageGeneric(window.location) : !h.pageGeneric;
      } catch {
        return false;
      }
    });
  }

  /** querySelectorAll that also looks inside open shadow roots. */
  function deepQueryAll(selector, root = document, depth = 0, out = []) {
    for (const node of root.querySelectorAll(selector)) out.push(node);
    if (depth < 4) {
      for (const host of root.querySelectorAll('*')) {
        if (host.shadowRoot) deepQueryAll(selector, host.shadowRoot, depth + 1, out);
      }
    }
    return out;
  }

  function metaText(...names) {
    for (const name of names) {
      const node = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      const value = node && node.getAttribute('content');
      if (value) return value.trim();
    }
    return '';
  }

  /** Same file, ignoring query strings (CDN size parameters). */
  function sameFile(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    // Only for real file paths: /image.php?id=1 and ?id=2 are different pictures.
    if (!/^(jpg|png|gif|webp|avif|heic|bmp|mp4|m4v|mov|webm|mp3|m4a|ogg|opus|wav|flac)$/.test(util.extFromUrl(a))) return false;
    try {
      const x = new URL(a);
      const y = new URL(b);
      return /^https?:$/.test(x.protocol) && x.origin === y.origin && x.pathname === y.pathname && x.pathname.length > 1;
    } catch {
      return false;
    }
  }

  /** Load an image on its own to learn its real size: { w, h }, 'error' (not an image), or null (no answer in time). */
  function probeImage(url, deadline) {
    return new Promise((done) => {
      if (!/^https?:/i.test(url)) return done(null);
      const probe = new Image();
      const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
      function finish(value) {
        clearTimeout(timer);
        probe.onload = probe.onerror = null;
        done(value);
      }
      probe.onload = () => finish(probe.naturalWidth && probe.naturalHeight ? { w: probe.naturalWidth, h: probe.naturalHeight } : 'error');
      probe.onerror = () => finish('error');
      probe.referrerPolicy = 'no-referrer-when-downgrade';
      probe.src = url;
    });
  }

  /**
   * An <img>'s files with their pixel size as far as the page tells without
   * loading anything (w/h 0 when unknown), largest first. A "click to
   * enlarge" link stays first: it's the full-size file.
   */
  function sizedCandidates(img, candidates) {
    const loaded = img.naturalWidth > 1 && img.naturalHeight > 1 && !/^data:/i.test(img.currentSrc || '');
    // The image's own size in CSS pixels (density-corrected), for density (1.5x, 2x) entries and the shape.
    let cssW = loaded ? img.naturalWidth : Number(img.getAttribute('width')) || 0;
    let cssH = loaded ? img.naturalHeight : Number(img.getAttribute('height')) || 0;
    if (!(cssW && cssH)) {
      const r = img.getBoundingClientRect();
      cssW = r.width > 2 ? Math.round(r.width) : 0;
      cssH = r.height > 2 ? Math.round(r.height) : 0;
    }
    const ratio = cssW && cssH ? cssH / cssW : 0;
    const sized = candidates.map((c) => {
      let w = 0;
      let h = 0;
      if (/^data:/i.test(c.url)) {
        /* inline placeholder: size unknown, never preferred */
      } else if (c.shown && loaded && c.width && c.height) {
        w = c.width;
        h = c.height;
      } else if (c.width) {
        w = c.width;
        h = c.height || (ratio ? Math.round(c.width * ratio) : 0);
      } else if (c.density && cssW && cssH) {
        w = Math.round(cssW * c.density);
        h = Math.round(cssH * c.density);
      }
      return { ...c, w, h };
    });
    const rank = (c) => (c.linked ? 4 : 0) + (/^data:/i.test(c.url) ? -4 : 0);
    return sized.sort((a, b) => rank(b) - rank(a) || b.w * b.h - a.w * a.h || b.w - a.w || (b.shown ? 1 : 0) - (a.shown ? 1 : 0));
  }

  function largestKnown(candidates) {
    let best = { w: 0, h: 0 };
    for (const c of candidates) if (c.w && c.h && c.w * c.h > best.w * best.h) best = { w: c.w, h: c.h };
    return best;
  }

  function isDecorativeVideo(video) {
    return video.tagName === 'VIDEO' && !video.controls && video.muted && video.loop;
  }

  /** Every photo, video and sound file on the page, best first. */
  async function scanPage() {
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    let streamError = null;

    // <video> and <audio> with real file URLs.
    const avs = [];
    for (const el of deepQueryAll('video, audio')) {
      let item = null;
      try {
        item = mediaItem(el);
      } catch (err) {
        streamError = streamError || err;
      }
      // A player that hasn't been given its file yet only has a poster: not a video to save.
      if (!item || !item.variants.some((v) => v.kind !== 'image')) continue;
      const r = el.getBoundingClientRect();
      const area = (el.videoWidth || 0) * (el.videoHeight || 0) || r.width * r.height;
      if (el.tagName === 'VIDEO') {
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (label) item.label = label.slice(0, 60);
      }
      avs.push({ item, el, area, audio: el.tagName === 'AUDIO', decorative: isDecorativeVideo(el) });
    }

    // og:video / twitter:player:stream, when they are files (not an embedded player page).
    const metaVideos = [];
    const addMetaVideo = (url, type) => {
      if (!usable(url)) return;
      const ext = util.extFromUrl(url);
      const okType = /^(video|audio)\//i.test(type) && !/mpegurl|dash/i.test(type);
      if (!okType && !FILE_EXT.test(ext)) return;
      if (/^text\//i.test(type)) return;
      metaVideos.push(url);
    };
    addMetaVideo(JDI.dom.metaContent('og:video:secure_url', 'og:video:url', 'og:video'), metaText('og:video:type'));
    addMetaVideo(JDI.dom.metaContent('twitter:player:stream'), metaText('twitter:player:stream:content_type'));

    let mainVideo = null;
    for (const url of metaVideos) {
      const match = avs.find((a) => a.item.variants.some((v) => sameFile(v.url, url)));
      if (match) {
        mainVideo = mainVideo || match;
        continue;
      }
      if (avs.some((a) => a.meta && sameFile(a.item.variants[0].url, url))) continue;
      const item = urlItem(url, 'Page video');
      if (!item) continue;
      const entry = { item, el: null, area: 1e12, audio: item.variants[0].kind === 'audio', meta: true, decorative: false };
      avs.push(entry);
      mainVideo = mainVideo || entry;
    }

    // <img>, including lazy-loaded ones (data-src, srcset) that haven't loaded.
    const images = [];
    const toProbe = [];
    for (const img of deepQueryAll('img')) {
      let candidates = imageCandidates(img);
      // Inline placeholders (lazy loading) aren't worth offering when there's a real file.
      if (candidates.some((c) => !/^data:/i.test(c.url))) candidates = candidates.filter((c) => !/^data:/i.test(c.url));
      else if (!candidates.some((c) => c.url.length > 4096)) continue;
      candidates = sizedCandidates(img, candidates);
      const best = candidates[0];
      if (!best) continue;
      if (/^data:image\/svg/i.test(best.url) || util.extFromUrl(best.url) === 'svg') continue;
      const entry = { img, candidates, url: best.url, ...largestKnown(candidates) };
      images.push(entry);
      // Probe files of unknown size, except links around small icons.
      const worthIt = !(entry.w && entry.h) || Math.min(entry.w, entry.h) >= PAGE_MIN_SIDE / 2;
      if (!(best.w && best.h) && worthIt && toProbe.length < PROBE_MAX) toProbe.push(entry);
    }

    const ogImageUrl = JDI.dom.metaContent('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src');
    let ogImage = null;
    if (usable(ogImageUrl) && util.extFromUrl(ogImageUrl) !== 'svg') {
      ogImage = images.find((e) => e.candidates.some((c) => sameFile(c.url, ogImageUrl)));
      if (!ogImage) {
        ogImage = { img: null, candidates: [{ url: ogImageUrl, w: 0, h: 0 }], url: ogImageUrl, w: 0, h: 0 };
        images.push(ogImage);
        toProbe.push(ogImage);
      }
      ogImage.og = true;
    }

    // Learn the real size of files the page hasn't loaded (all at once, briefly).
    await Promise.all(
      toProbe.map(async (entry) => {
        const size = await probeImage(entry.url, deadline);
        if (size === 'error') {
          // Not an image after all (e.g. a link to an HTML page named like a .jpg).
          entry.candidates.shift();
          if (!entry.candidates.length) entry.broken = true;
          else entry.url = entry.candidates[0].url;
        } else if (size) {
          Object.assign(entry.candidates[0], size);
        }
        Object.assign(entry, largestKnown(entry.candidates));
      }),
    );

    const seen = [];
    const keptImages = images
      .filter((e) => {
        if (e.broken) return false;
        if (e.w && e.h) return Math.min(e.w, e.h) >= PAGE_MIN_SIDE;
        // Size still unknown: keep the page's own preview image and big srcset entries.
        return e.og || (e.candidates[0] && e.candidates[0].width >= 2 * PAGE_MIN_SIDE);
      })
      .sort((a, b) => (b.og ? 1 : 0) - (a.og ? 1 : 0) || (b.w * b.h || 0) - (a.w * a.h || 0))
      .filter((e) => {
        const urls = e.candidates.length ? e.candidates.map((c) => c.url) : [e.url];
        if (seen.some((u) => urls.some((v) => sameFile(u, v)))) return false;
        seen.push(...urls);
        return true;
      });

    const imageItems = keptImages
      .map((e) => {
        // Sizes go into the picker's labels ("1200px wide", "1200 × 800").
        const candidates = e.candidates.map(({ w, h, ...c }) => ({ ...c, width: w || c.width, height: h || c.height }));
        const item = e.img ? imageItem(e.img, candidates) : urlItem(e.url, 'Page preview image', 'image');
        if (!item) return null;
        const top = item.variants[0];
        if (top && !e.img && e.w && e.h) top.detail = [`${e.w} × ${e.h}`, top.detail].filter(Boolean).join(' · ');
        return { item, og: !!e.og };
      })
      .filter(Boolean);

    // The same file in two players (or og:video and a player) is one item.
    for (let i = avs.length - 1; i >= 0; i--) {
      const url = avs[i].item.variants[0].url;
      if (avs.some((other, j) => j < i && other.item.variants.some((v) => v.url === url))) {
        if (mainVideo === avs[i]) mainVideo = avs.find((other) => other.item.variants.some((v) => v.url === url));
        avs.splice(i, 1);
      }
    }

    const videos = avs.filter((a) => !a.audio).sort((a, b) => (b === mainVideo ? 1 : 0) - (a === mainVideo ? 1 : 0) || (a.decorative ? 1 : 0) - (b.decorative ? 1 : 0) || b.area - a.area);
    const audios = avs.filter((a) => a.audio);
    const items = [...videos.map((a) => a.item), ...audios.map((a) => a.item)];
    const mediaCount = items.length;
    items.push(...imageItems.map((e) => e.item));

    // Focus the page's main media: its og:video, else a real (not decorative) video, else og:image.
    let focus = -1;
    if (mainVideo) focus = items.indexOf(mainVideo.item);
    if (focus < 0 && videos.length && !videos[0].decorative) focus = 0;
    if (focus < 0 && !videos.length && audios.length) focus = 0;
    if (focus < 0 && ogImage) {
      const i = imageItems.findIndex((e) => e.og);
      if (i >= 0) focus = mediaCount + i;
    }
    return { items: items.slice(0, PAGE_MAX_ITEMS), focus: Math.max(0, Math.min(focus, PAGE_MAX_ITEMS - 1)), streamError, domCount: avs.filter((a) => a.el).length + keptImages.filter((e) => e.img).length };
  }

  async function resolveWholePage() {
    if (pageScanDeferred()) return null;
    let scan = await scanPage();
    // Pages that build themselves with scripts may not have their media yet.
    if (!scan.domCount) {
      const nav = performance.getEntriesByType('navigation')[0];
      const sinceLoad = nav && nav.loadEventEnd ? performance.now() - nav.loadEventEnd : 0;
      const wait = Math.min(2500, 2500 - sinceLoad);
      if (wait > 100) {
        await new Promise((r) => setTimeout(r, wait));
        scan = await scanPage();
      }
    }
    if (!scan.items.length) {
      if (scan.streamError) throw scan.streamError;
      return null;
    }
    const title = (document.title || '').replace(/\s+/g, ' ').trim() || hostLabel();
    return {
      site: '',
      title,
      notice: scan.streamError ? 'This page’s video streams in small pieces, so it can’t be saved as a file. Here’s what can be.' : undefined,
      focus: scan.focus,
      items: scan.items,
    };
  }

  async function resolve(ctx) {
    if (ctx.page) return resolveWholePage();
    const site = hostLabel();
    const base = { site, title: site };

    const media = JDI.dom.findMediaAt(ctx.stack, ctx.x, ctx.y);
    // Players often lay a poster <img> over the <video>; prefer the real media.
    const av = media.find((m) => m.tagName === 'VIDEO' || m.tagName === 'AUDIO');
    const img = media.find((m) => m.tagName === 'IMG');

    const info = ctx.info || {};
    // Chrome recorded the media URL at the moment of the right-click. If the
    // page has swapped the element since (slideshows, hover previews), trust
    // Chrome's record over what the element shows now.
    const recorded = usable(info.srcUrl) ? absolute(info.srcUrl) : '';
    const agrees = (item) => !recorded || item.variants.some((v) => v.url === recorded);

    let streamError = null;
    if (av) {
      try {
        const item = mediaItem(av);
        if (item && agrees(item)) return { ...base, items: [item], focus: 0 };
      } catch (err) {
        streamError = err;
      }
    }
    if (img) {
      const item = imageItem(img);
      if (item && agrees(item)) return { ...base, items: [item], focus: 0 };
    }

    // Chrome knows the media URL (e.g. the content script arrived after the right-click).
    if (usable(info.srcUrl)) {
      const kind = info.mediaType === 'video' || info.mediaType === 'audio' ? info.mediaType : 'image';
      return { ...base, items: [urlItem(info.srcUrl, kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : 'Audio', kind)], focus: 0 };
    }
    if (usable(info.linkUrl) && util.extFromUrl(info.linkUrl)) {
      return { ...base, items: [urlItem(info.linkUrl, 'Linked file')], focus: 0 };
    }

    if (streamError) throw streamError;

    const bg = JDI.dom.findBackgroundImage(ctx.stack);
    if (bg && usable(bg)) return { ...base, items: [urlItem(bg, 'Background image', 'image')], focus: 0 };

    const ogVideo = JDI.dom.metaContent('og:video:secure_url', 'og:video:url', 'og:video');
    const ogImage = JDI.dom.metaContent('og:image:secure_url', 'og:image', 'twitter:image');
    const items = [];
    if (ogVideo && util.extFromUrl(ogVideo)) items.push(urlItem(ogVideo, 'Page video', 'video'));
    if (ogImage) items.push(urlItem(ogImage, 'Page preview image', 'image'));
    const clean = items.filter(Boolean);
    if (clean.length) {
      return { ...base, notice: "Nothing downloadable right under your cursor, but this page has:", items: clean, focus: 0 };
    }
    return null;
  }

  util.registerHandler({
    id: 'generic',
    name: 'Any site',
    priority: 0,
    matches: () => true,
    resolve,
  });

  // Exposed for other handlers that fall back to plain DOM extraction.
  JDI.generic = { imageItem, mediaItem, urlItem, resolve, pageOnce, scanPage };
})();
