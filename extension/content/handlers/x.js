/*
 * Just download it: X (Twitter) handler.
 *
 *  - The post id comes from the photo link (/status/<id>/photo/<n>), the
 *    post's timestamp permalink, or the address bar.
 *  - Media comes from X's public embed endpoint (cdn.syndication.twimg.com,
 *    the same data embedded posts use). It needs no login and returns every
 *    MP4 bitrate for videos and GIFs. The service worker fetches it because
 *    the page isn't allowed to read it directly.
 *  - Photos: the original upload via pbs.twimg.com's name=orig.
 *  - Buttons: an icon in each post's action bar (posts with media only) and a
 *    hover button on videos.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  const { util } = JDI;

  const STATUS = /\/status(?:es)?\/(\d{5,25})(?:\/(photo|video)\/(\d))?/;
  const MEDIA_SELECTOR = '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"], video';

  function isX(loc) {
    return /^(www\.|mobile\.)?(x|twitter)\.com$/i.test(loc.hostname);
  }

  /** The post an element belongs to, and which of its media (0-based) if known. */
  function postFrom(element) {
    const start = element && element.nodeType === 1 ? element : null;
    // A photo link names both the post and the photo number.
    const photoLink = start && start.closest('a[href*="/status/"]');
    const pm = photoLink ? STATUS.exec(photoLink.getAttribute('href')) : null;
    if (pm && pm[3]) return { id: pm[1], index: Number(pm[3]) - 1 };

    const article = start && start.closest('article');
    if (article) {
      const time = article.querySelector('a[href*="/status/"] time');
      const tm = time ? STATUS.exec(time.closest('a').getAttribute('href')) : null;
      if (tm) {
        // Which media inside the post, by position.
        const media = Array.from(article.querySelectorAll(MEDIA_SELECTOR)).filter((m) => !m.parentElement.closest(MEDIA_SELECTOR));
        const index = media.findIndex((m) => m === start || m.contains(start) || start.contains(m));
        return { id: tm[1], index: index >= 0 ? index : 0 };
      }
    }
    const um = STATUS.exec(window.location.pathname);
    return um ? { id: um[1], index: um[3] ? Number(um[3]) - 1 : 0 } : { id: '', index: 0 };
  }

  function snapshot({ stack, target }) {
    for (const node of (stack && stack.length ? stack : [target]).filter(Boolean).slice(0, 12)) {
      const post = postFrom(node);
      if (post.id) return post;
    }
    return { id: '', index: 0 };
  }

  /** The token the embed endpoint expects, derived from the post id. */
  function syndicationToken(id) {
    return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
  }

  function dateOf(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }

  /**
   * Turn an embed-endpoint response into a Resolution.
   * @param options.withQuoted  also offer a quoted post's media after the post's own
   */
  function buildResolution(data, id, focusIndex = 0, options = {}) {
    if (!data || data.__typename === 'TweetTombstone') {
      throw Object.assign(new Error('unavailable'), { userMessage: 'X doesn’t share this post publicly (it may be protected, deleted or age-restricted).' });
    }
    let source = data;
    let media = data.mediaDetails || [];
    const quoted = data.quoted_tweet && data.quoted_tweet.__typename !== 'TweetTombstone' && (data.quoted_tweet.mediaDetails || []).length ? data.quoted_tweet : null;
    if (!media.length && quoted) {
      source = quoted;
      media = source.mediaDetails;
    }
    if (!media.length) return null;

    const user = (source.user && source.user.screen_name) || '';
    const items = mediaItems(source, media, id);
    if (options.withQuoted && quoted && source !== quoted) {
      const quotedUser = (quoted.user && quoted.user.screen_name) || '';
      for (const item of mediaItems(quoted, quoted.mediaDetails, quoted.id_str)) {
        items.push({ ...item, label: `Quoted${quotedUser ? ` @${quotedUser}` : ' post'}: ${item.label}` });
      }
    }

    return {
      site: 'X',
      title: user ? `@${user}` : 'X',
      focus: Math.min(Math.max(focusIndex, 0), items.length - 1),
      items,
    };
  }

  /** One picker item per photo/video/GIF of a post. */
  function mediaItems(source, media, id) {
    const user = (source.user && source.user.screen_name) || '';
    const base = [user, dateOf(source.created_at), source.id_str || id].filter(Boolean).join('_');
    const multi = media.length > 1;

    return media.map((m, i) => {
      const filename = multi ? `${base}_${i + 1}` : base;
      const noun = m.type === 'photo' ? 'Photo' : m.type === 'animated_gif' ? 'GIF' : 'Video';
      const label = multi ? `${noun} ${i + 1} of ${media.length}` : noun;
      const info = m.original_info || {};
      let variants = [];

      if (m.type === 'photo') {
        let u;
        try {
          u = new URL(m.media_url_https);
        } catch {
          return { label, variants: [] };
        }
        const ext = util.normalizeExt(u.pathname.split('.').pop()) || 'jpg';
        const stem = u.pathname.replace(/\.[a-z0-9]+$/i, '');
        const at = (name) => `https://pbs.twimg.com${stem}?format=${ext === 'jpg' ? 'jpg' : ext}&name=${name}`;
        variants = [
          { label: 'Original', detail: [info.width && info.height ? `${info.width} × ${info.height}` : '', ext.toUpperCase()].filter(Boolean).join(' · '), url: at('orig'), ext, filename },
          { label: 'Large', detail: 'Up to 2048 px', url: at('large'), ext, filename: `${filename}_large` },
          { label: 'Medium', detail: 'Up to 1200 px', url: at('medium'), ext, filename: `${filename}_medium` },
        ].map((v) => ({ kind: 'image', ...v }));
        return { label, thumbnail: at('small'), variants };
      }

      const mp4s = ((m.video_info && m.video_info.variants) || [])
        .filter((v) => v && v.content_type === 'video/mp4' && /^https:/i.test(v.url || ''))
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
      variants = mp4s.map((v, j) => {
        const dims = /\/(\d{2,5})x(\d{2,5})\//.exec(v.url);
        const w = dims ? Number(dims[1]) : 0;
        const h = dims ? Number(dims[2]) : 0;
        const kbps = Math.round((Number(v.bitrate) || 0) / 1000);
        return {
          kind: 'video',
          label: w && h ? `${Math.min(w, h)}p MP4` : j === 0 ? 'Best MP4' : 'MP4',
          detail: [w && h ? `${w} × ${h}` : '', kbps ? `${kbps} kbps` : '', m.type === 'animated_gif' ? 'GIF as video' : 'with sound'].filter(Boolean).join(' · '),
          url: v.url,
          ext: 'mp4',
          filename: j === 0 ? filename : `${filename}_${w && h ? `${Math.min(w, h)}p` : j}`,
          width: w,
          height: h,
        };
      });
      if (m.media_url_https) {
        variants.push({
          kind: 'image',
          group: 'Other',
          label: 'Thumbnail',
          detail: info.width && info.height ? `${info.width} × ${info.height}` : '',
          url: m.media_url_https,
          ext: util.extFromUrl(m.media_url_https) || 'jpg',
          filename: `${filename}_thumbnail`,
        });
      }
      return { label, thumbnail: m.media_url_https || '', variants };
    });
  }

  const cache = new Map();

  async function fetchPost(id) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.time < 10 * 60 * 1000) return hit.promise;
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=${syndicationToken(id)}&lang=en`;
    const promise = chrome.runtime.sendMessage({ type: 'jdi:fetch-json', url }).then((res) => {
      if (!res || !res.ok) {
        const status = res && res.status;
        throw Object.assign(new Error(`embed ${status}`), {
          userMessage:
            status === 404
              ? 'X doesn’t share this post publicly (it may be protected, deleted or age-restricted).'
              : 'X didn’t answer. Try again in a moment.',
        });
      }
      return res.data;
    });
    cache.set(id, { time: Date.now(), promise });
    promise.catch(() => cache.delete(id));
    return promise;
  }

  /** The post this page shows (a pasted link), or an error saying what to paste instead. */
  function pageSnapshot() {
    const loc = window.location;
    let m = STATUS.exec(loc.pathname);
    // Logged out, X may show its login flow with the post in redirect_after_login.
    const next = new URLSearchParams(loc.search).get('redirect_after_login');
    if (!m && next) m = STATUS.exec(next);
    if (!m) throw Object.assign(new Error('not a post'), { final: true, userMessage: 'That X page isn’t a single post. Paste the link to a post (it has /status/ in it).' });
    return { id: m[1], index: m[3] ? Number(m[3]) - 1 : 0, page: true };
  }

  async function resolve(ctx) {
    const snap = ctx.snapshot || snapshot(ctx);
    if (!snap.id) return null;
    if (ctx.page) {
      // Asked again until the page answers: one request per post is enough.
      const once = (JDI.generic && JDI.generic.pageOnce) || ((k, fn) => fn());
      const data = await once(`x:${snap.id}`, () => fetchPost(snap.id), 60000);
      const resolution = buildResolution(data, snap.id, snap.index, { withQuoted: true });
      if (!resolution) throw Object.assign(new Error('no media'), { userMessage: 'This post has no photos, videos or GIFs.' });
      return resolution;
    }
    const data = await fetchPost(snap.id);
    return buildResolution(data, snap.id, snap.index);
  }

  util.registerHandler({ id: 'x', name: 'X', priority: 100, matches: isX, snapshot, pageSnapshot, pageGeneric: false, resolve });

  // ---------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------

  /**
   * A post's action bar: reply, repost, like, views, bookmark, share. The app
   * X serves to signed-in readers marks it with role="group"; the lighter
   * pages signed-out readers get have a plain row of aria-labelled buttons, so
   * fall back to the row that holds both Like and Share.
   */
  function actionBar(article) {
    const tagged = article.querySelector('[role="group"] [data-testid="like"], [role="group"] [data-testid="unlike"]');
    const group = tagged && tagged.closest('[role="group"]');
    if (group) return { row: group, like: tagged, share: group.lastElementChild };
    const like = article.querySelector('button[aria-label="Like"], button[aria-label="Unlike"]');
    const share = article.querySelector('button[aria-label="Share"], button[aria-label="Share post"]');
    if (!like || !share) return null;
    for (let row = like.parentElement, depth = 0; row && depth < 6; row = row.parentElement, depth++) {
      if (!row.contains(share)) continue;
      const slot = Array.from(row.children).find((c) => c.contains(share));
      return { row, like, share: slot || share };
    }
    return null;
  }

  if (JDI.buttons && isX(window.location)) {
    JDI.buttons.register((api) => {
      api.onChange(() => {
        for (const article of document.querySelectorAll('article')) {
          if (!article.querySelector(MEDIA_SELECTOR)) continue;
          const bar = actionBar(article);
          if (!bar || bar.row.closest('article') !== article || bar.row.querySelector(`:scope > ${api.TAG}`)) continue;
          const button = api.create({
            look: 'x-icon',
            label: 'Download',
            title: 'Download',
            theme: 'auto',
            onClick: (hostEl) => {
              const post = postFrom(hostEl.closest('article') || hostEl);
              JDI.core.openPicker({ handlerId: 'x', snapshot: { id: post.id, index: 0 }, anchor: hostEl });
            },
          });
          // The post a page is about has a taller action bar than the ones in
          // a timeline; follow Like rather than read the address.
          if (bar.like.getBoundingClientRect().height >= 38) button.setAttribute('data-size', 'large');
          bar.row.insertBefore(button, bar.share);
        }
      });
      api.hoverVideos({
        look: 'x-overlay',
        size: 36,
        inset: 8,
        onClick: (video, hostEl) => JDI.core.openPicker({ handlerId: 'x', snapshot: snapshot(api.centreOf(video)), anchor: hostEl }),
      });
    });
  }

  JDI.x = { postFrom, syndicationToken, buildResolution, snapshot };
})();
