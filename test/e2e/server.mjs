// A local HTTPS server that plays several hosts, told apart by the Host header:
//   www.instagram.com               - feed/post pages and the web API
//   scontent-test.cdninstagram.com  - the media CDN
//   www.youtube.com                 - a watch page and the InnerTube player API
//   rr1---sn-test.googlevideo.com   - YouTube's stream servers
//   i.ytimg.com                     - YouTube thumbnails
//   generic.test                    - an ordinary site for the generic handler
// Chrome is started with --host-resolver-rules pointing those names here.
import { createReadStream, readFileSync, statSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import { carousel, photo, reel } from '../fixtures/instagram.js';
import { player as youtubePlayer } from '../fixtures/youtube.js';

export const IG_HOST = 'www.instagram.com';
export const CDN_HOST = 'scontent-test.cdninstagram.com';
export const GENERIC_HOST = 'generic.test';
export const YT_HOST = 'www.youtube.com';
export const GVS_HOST = 'rr1---sn-test.googlevideo.com';
export const YTIMG_HOST = 'i.ytimg.com';
export const YT_VIDEOS = {
  dQw4w9WgXcQ: 'Never Gonna Give You Up',
  jNQXAC9IVRw: 'Me at the zoo',
};
// itag -> [local file, content type]. The "AV1" itags serve H.264 bytes; the
// picker never chooses AV1 when H.264 or VP9 is available.
const GVS_FILES = {
  137: ['yt-video-avc.mp4', 'video/mp4'],
  136: ['yt-video-avc.mp4', 'video/mp4'],
  134: ['yt-video-avc.mp4', 'video/mp4'],
  401: ['yt-video-avc.mp4', 'video/mp4'],
  399: ['yt-video-avc.mp4', 'video/mp4'],
  313: ['yt-video-vp9.webm', 'video/webm'],
  271: ['yt-video-vp9.webm', 'video/webm'],
  248: ['yt-video-vp9.webm', 'video/webm'],
  247: ['yt-video-vp9.webm', 'video/webm'],
  140: ['yt-audio-aac.mp4', 'audio/mp4'],
  139: ['yt-audio-aac.mp4', 'audio/mp4'],
  251: ['yt-audio-opus.webm', 'audio/webm'],
};
export const APP_ID = '936619743392459';

export const CODES = {
  photo: 'DdW9NvLJmhn',
  reel: 'DdUtqbFMQvn',
  carousel: 'DdRzldIALvw',
  rateLimited: 'DcRateLimit',
};
export const PKS = {
  photo: '3987643744926460007',
  reel: '3987012397518883815',
  carousel: '3986194019465083888',
  story: '3990000000000000001',
  highlight1: '3990000000000000101',
  highlight2: '3990000000000000102',
};
export const HIGHLIGHT_ID = '17900000000000000';

function storyItem(cdn, pk, file, takenAt) {
  const item = photo(cdn, { pk, file });
  delete item.code;
  item.product_type = 'story';
  item.taken_at = takenAt;
  return item;
}

const CDN_FILES = {
  '550001_4961394081366993_n.jpg': 'photo.jpg',
  '770000_0818699158354293_n.jpg': 'slide0.jpg',
  '770001_0818699158354293_n.jpg': 'slide1.jpg',
  '770002_0818699158354293_n.jpg': 'slide2.jpg',
  '812133324_18191130355397912_3084360459491823383_n.jpg': 'cover.jpg',
  '770009_video_cover_n.jpg': 'video-cover.jpg',
  'pic_n.jpg': 'avatar.jpg',
  'ratelimited_n.jpg': 'ratelimited.jpg',
  'story_n.jpg': 'slide0.jpg',
  'hl1_n.jpg': 'slide1.jpg',
  'hl2_n.jpg': 'slide2.jpg',
  'video-1080.mp4': 'video-1080.mp4',
  'video-720.mp4': 'video-720.mp4',
  'video-360.mp4': 'video-360.mp4',
  'audio.mp4': 'audio.mp4',
  'progressive-720.mp4': 'progressive-720.mp4',
};

const MIME = { jpg: 'image/jpeg', mp4: 'video/mp4', webm: 'video/webm', json: 'application/json', html: 'text/html; charset=utf-8' };

export function startServer({ media, key, cert }) {
  const requests = [];
  const state = { port: 0 };

  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    const url = new URL(req.url, `https://${host}`);
    requests.push({ host, path: url.pathname, search: url.search, method: req.method, headers: req.headers });
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    try {
      if (host === IG_HOST) return instagram(req, res, url);
      if (host === CDN_HOST) return cdn(req, res, url);
      if (host === GENERIC_HOST) return generic(req, res, url);
      if (host === YT_HOST) return youtube(req, res, url);
      if (host === GVS_HOST) return googlevideo(req, res, url);
      if (host === YTIMG_HOST) return file(req, res, join(media, 'poster.jpg'), MIME.jpg);
      send(res, 404, 'text/plain', 'unknown host');
    } catch (err) {
      send(res, 500, 'text/plain', String(err.stack || err));
    }
  });

  const cdnBase = () => `https://${CDN_HOST}:${state.port}`;

  function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  function json(res, status, data) {
    send(res, status, MIME.json, JSON.stringify(data));
  }

  function file(req, res, path, type, extraHeaders = {}) {
    const size = statSync(path).size;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...extraHeaders };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(path, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).pipe(res);
  }

  // --------------------------------------------------------------------------
  // www.instagram.com
  // --------------------------------------------------------------------------

  function instagram(req, res, url) {
    const p = url.pathname;
    if (p.startsWith('/api/') || p.startsWith('/web/')) {
      if (req.headers['x-ig-app-id'] !== APP_ID) {
        return json(res, 400, { message: 'useragent mismatch', status: 'fail' });
      }
      const media = /^\/api\/v1\/media\/(\d+)\/info\/$/.exec(p);
      if (media) {
        const cdn = cdnBase();
        const byPk = {
          [PKS.photo]: () => photo(cdn),
          [PKS.reel]: () => reel(cdn),
          [PKS.carousel]: () => carousel(cdn),
          [PKS.story]: () => storyItem(cdn, PKS.story, 'story_n.jpg', 1789600000),
        };
        // Instagram's usual throttle: HTTP 401 that also says require_login.
        if (!byPk[media[1]]) return json(res, 401, { message: 'Please wait a few minutes before you try again.', require_login: true, status: 'fail' });
        return json(res, 200, { items: [byPk[media[1]]()], num_results: 1, status: 'ok' });
      }
      if (p === '/api/v1/feed/reels_media/' && url.searchParams.get('reel_ids') === `highlight:${HIGHLIGHT_ID}`) {
        const cdn = cdnBase();
        const reelId = `highlight:${HIGHLIGHT_ID}`;
        const items = [
          storyItem(cdn, PKS.highlight1, 'hl1_n.jpg', 1780000000),
          storyItem(cdn, PKS.highlight2, 'hl2_n.jpg', 1780003600),
        ];
        return json(res, 200, {
          reels: { [reelId]: { id: reelId, title: 'Summer', user: { pk: '1234', username: 'some.user' }, items } },
          reels_media: [],
          status: 'ok',
        });
      }
      if (p === '/web/search/topsearch/') {
        return json(res, 200, { users: [{ position: 0, user: { pk: '1234', pk_id: '1234', username: 'some.user' } }], status: 'ok' });
      }
      if (p === '/api/v1/users/1234/info/') {
        const pic = (s, oh) => ({ url: `${cdnBase()}/v/t51.2885-19/pic_n.jpg?stp=dst-jpg_s${s}x${s}&oh=${oh}&oe=68D0`, width: s, height: s });
        return json(res, 200, {
          user: { pk: '1234', username: 'some.user', hd_profile_pic_url_info: pic(1080, 'a'), hd_profile_pic_versions: [pic(320, 'b'), pic(640, 'c')] },
          status: 'ok',
        });
      }
      return json(res, 404, { message: 'not found', status: 'fail' });
    }
    if (p === '/' || p === '/feed/') return send(res, 200, MIME.html, feedPage(cdnBase()));
    // The feed with a post open as a pop-up on top (the URL changes to the post).
    if (p === `/p/${CODES.photo}/` && url.searchParams.has('modal')) {
      return send(res, 200, MIME.html, feedPage(cdnBase()).replace('</main>', `</main>${modalOverlay(cdnBase())}`));
    }
    if (p === `/p/${CODES.photo}/`) return send(res, 200, MIME.html, postPage(cdnBase()));
    if (p === `/stories/some.user/${PKS.story}/`) return send(res, 200, MIME.html, storyPage(cdnBase(), 'story_n.jpg', '2026-09-16T23:06:40.000Z'));
    // A highlight's URL doesn't say which item is showing; this page shows the second one.
    if (p === `/stories/highlights/${HIGHLIGHT_ID}/`) return send(res, 200, MIME.html, storyPage(cdnBase(), 'hl2_n.jpg', '2026-05-28T00:26:40.000Z'));
    return send(res, 404, MIME.html, '<h1>Not found</h1>');
  }

  // --------------------------------------------------------------------------
  // CDN
  // --------------------------------------------------------------------------

  function cdn(req, res, url) {
    const name = url.pathname.split('/').pop();
    const local = CDN_FILES[name];
    if (!local) return send(res, 404, 'text/plain', 'no such media');
    const ext = name.split('.').pop();
    // Like Instagram's CDN: readable from instagram.com pages.
    return file(req, res, join(media, local), MIME[ext], { 'Access-Control-Allow-Origin': `https://${IG_HOST}:${state.port}` });
  }

  // --------------------------------------------------------------------------
  // YouTube
  // --------------------------------------------------------------------------

  function youtube(req, res, url) {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v') || '';
      return send(res, 200, MIME.html, watchPage(id, YT_VIDEOS[id] || 'Unknown video', state.port));
    }
    if (url.pathname === '/youtubei/v1/player' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'bad json' });
        }
        requests.push({ host: YT_HOST, path: '/youtubei/v1/player#body', method: 'POST', headers: req.headers, body });
        const id = body.videoId;
        const client = body.context && body.context.client;
        if (!YT_VIDEOS[id]) return json(res, 200, { playabilityStatus: { status: 'ERROR', reason: 'Video unavailable' } });
        if (!client || client.clientName !== 'VISIONOS' || req.headers['x-youtube-client-name'] !== '101') {
          // Like the real web clients today: SABR only, no usable URLs.
          return json(res, 200, { playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [], serverAbrStreamingUrl: 'x' } });
        }
        const data = youtubePlayer(`https://${GVS_HOST}:${state.port}`, { videoId: id, title: YT_VIDEOS[id], length: 3 });
        const text = JSON.stringify(data).replaceAll('https://i.ytimg.com/', `https://${YTIMG_HOST}:${state.port}/`);
        return send(res, 200, MIME.json, text);
      });
      return undefined;
    }
    return send(res, 404, MIME.html, '<h1>Not found</h1>');
  }

  function googlevideo(req, res, url) {
    const entry = GVS_FILES[url.searchParams.get('itag')];
    if (url.pathname !== '/videoplayback' || !entry) return send(res, 403, 'text/plain', 'forbidden');
    // A little latency so jobs take long enough to report progress, like the real thing.
    setTimeout(() => file(req, res, join(media, entry[0]), entry[1], { 'Access-Control-Allow-Origin': '*' }), 400);
    return undefined;
  }

  // --------------------------------------------------------------------------
  // generic.test
  // --------------------------------------------------------------------------

  function generic(req, res, url) {
    const p = url.pathname;
    if (p === '/') return send(res, 200, MIME.html, genericPage());
    if (p === '/strict-csp') {
      return send(res, 200, MIME.html, strictCspPage(), {
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'none'",
      });
    }
    const m = /^\/(img|media)\/([\w.-]+)$/.exec(p);
    if (m) {
      const ext = m[2].split('.').pop();
      try {
        return file(req, res, join(media, m[2]), MIME[ext] || 'application/octet-stream');
      } catch {
        return send(res, 404, 'text/plain', 'missing');
      }
    }
    return send(res, 404, 'text/plain', 'not found');
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      resolve({ port: state.port, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ----------------------------------------------------------------------------
// Pages
// ----------------------------------------------------------------------------

const IG_STYLE = `
  body { margin: 0; background: #000; color: #f5f5f5; font: 14px system-ui, sans-serif; }
  main { width: 470px; margin: 0 auto; padding: 16px 0 400px; }
  article { margin: 0 0 32px; }
  header { display: flex; gap: 8px; align-items: center; height: 48px; }
  header img { width: 32px; height: 32px; border-radius: 50%; display: block; }
  a { color: inherit; }
  .media { position: relative; width: 468px; height: 585px; overflow: hidden; }
  .media img, .media video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .overlay { position: absolute; inset: 0; }
  .viewport { position: relative; width: 468px; height: 585px; overflow: hidden; }
  .viewport ul { list-style: none; margin: 0; padding: 0; position: relative; height: 585px; transform: translateX(-1404px); }
  .viewport li { position: absolute; top: 0; left: 0; width: 468px; height: 585px; }
`;

function feedPage(cdn) {
  const img = (file, s = 1080) => `${cdn}/v/t51.82787-15/${file}?stp=dst-jpg_e35_p${s}x${s}&amp;oh=abc&amp;oe=68D0`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Instagram</title>
<script type="application/json" data-sjs>{"require":[["ScheduledServerJS",{"__bbox":{"define":[["PolarisConfig",[],{"APP_ID":"${APP_ID}"}]]}}]]}</script>
<style>${IG_STYLE}</style></head>
<body><main>
  <article id="photo">
    <header>
      <a href="/some.user/"><img id="avatar" alt="" src="${cdn}/v/t51.2885-19/pic_n.jpg?stp=dst-jpg_s150x150&amp;oh=z&amp;oe=68D0"></a>
      <a href="/some.user/">some.user</a>
    </header>
    <div class="media"><div><img alt="" src="${img('550001_4961394081366993_n.jpg')}"></div><div class="overlay"></div></div>
    ${actionRow()}
    <div><a href="/p/${CODES.photo}/"><span><time datetime="2026-09-15T19:20:00.000Z">2d</time></span></a>
      <a href="/p/${CODES.photo}/liked_by/">Liked by others</a></div>
  </article>

  <article id="carousel">
    <div class="head-row" style="display:flex;gap:8px;align-items:center;height:48px">
      <div role="button" tabindex="0"><span role="link" tabindex="-1"><img id="avatar-nolink" alt="Profilbild" src="${cdn}/v/t51.2885-19/pic_n.jpg?stp=dst-jpg_s150x150&amp;oh=y&amp;oe=68D0" style="width:32px;height:32px;border-radius:50%;display:block"></span></div>
      <a href="/some.user/" role="link">some.user</a>
    </div>
    <div class="viewport" role="presentation">
      <ul>
        <li style="transform: translateX(936px)"><div class="media"><div><img alt="" src="${img('770001_0818699158354293_n.jpg')}"></div><div class="overlay"></div></div></li>
        <li style="transform: translateX(1404px)"><div class="media"><div><img alt="" src="${img('770002_0818699158354293_n.jpg')}"></div><div class="overlay"></div></div></li>
        <li style="transform: translateX(1872px)"></li>
      </ul>
    </div>
    <button aria-label="Go back">‹</button>
    ${actionRow()}
    <div><a href="/p/${CODES.carousel}/"><span><time datetime="2026-09-13T11:46:40.000Z">4d</time></span></a></div>
  </article>

  <article id="reel">
    <header><a href="/reel_maker/">reel_maker</a></header>
    <div class="media">
      <div role="group" aria-label="Video player"><video playsinline muted></video></div>
      <img alt="" src="${cdn}/v/t51.71878-15/812133324_18191130355397912_3084360459491823383_n.jpg?stp=dst-jpg_e35_p720x720&amp;oh=c&amp;oe=68D0">
      <div class="overlay" role="presentation"></div>
    </div>
    <div><a href="/reels/audio/1107660630498769/">Original audio</a> <a href="/reels/${CODES.reel}/">reel</a>
      <a href="/p/${CODES.reel}/"><span><time datetime="2026-09-14T15:33:20.000Z">3d</time></span></a></div>
  </article>

  <article id="ratelimited">
    <header><a href="/limited.user/">limited.user</a></header>
    <div class="media"><div><img alt="" src="${img('ratelimited_n.jpg')}"></div><div class="overlay"></div></div>
    <div><a href="/p/${CODES.rateLimited}/"><span><time datetime="2026-09-15T19:20:00.000Z">2d</time></span></a></div>
  </article>
</main>
<script>
  // Instagram plays reels through MediaSource, so the <video> only has a blob: URL.
  for (const v of document.querySelectorAll('video')) v.src = URL.createObjectURL(new MediaSource());
</script>
</body></html>`;
}

const ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v16H4z"/></svg>';

/** Instagram's post action row: [like, comment, repost, share] [save]. */
function actionRow() {
  const btn = (label) =>
    `<div role="button" tabindex="0" style="padding:8px;display:flex">${ICON.replace('<svg', `<svg aria-label="${label}"`)}</div>`;
  return `<section class="actions" style="display:grid;grid-template-columns:1fr auto;align-items:center;height:40px;color:#f5f5f5">
      <div style="display:flex;align-items:center"><span>${btn('Like')}</span><span>${btn('Comment')}</span>${btn('Repost')}${btn('Share')}</div>
      <div style="padding-right:8px">${btn('Save')}</div>
    </section>`;
}

function modalOverlay(cdn) {
  return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.65)"></div>
  <div role="dialog" id="modal" style="position:fixed;left:120px;top:60px;width:900px;height:600px;display:flex;background:#000">
    <div class="media" style="width:480px;height:600px"><div><img alt="" src="${cdn}/v/t51.82787-15/550001_4961394081366993_n.jpg?stp=dst-jpg_e35_p1080x1080&amp;oh=abc&amp;oe=68D0"></div><div class="overlay"></div></div>
    <div id="modal-comments" style="flex:1;padding:16px;color:#fff"><p id="modal-caption" style="margin:0;height:400px">Great photo, what a day.</p></div>
  </div>`;
}

function watchPage(id, title, port) {
  return `<!doctype html>
<html lang="en" dark><head><meta charset="utf-8"><title>${title} - YouTube</title>
<script>var ytcfg = { d: {}, set(o) { Object.assign(this.d, o); } }; ytcfg.set({"VISITOR_DATA":"CgtUZXN0VmlzaXRvchIEGgAgKw%3D%3D","INNERTUBE_API_KEY":"test-key"});</script>
<style>
  body { margin: 0; background: #0f0f0f; color: #f1f1f1; font-family: Roboto, Arial, sans-serif; }
  ytd-watch-flexy, ytd-watch-metadata, ytd-app { display: block; }
  #movie_player { width: 640px; height: 360px; background: #000; }
  #movie_player video { width: 100%; height: 100%; display: block; }
  #actions { padding: 12px 0; }
  #top-level-buttons-computed { display: flex; align-items: center; }
  segmented-like-dislike-button-view-model, yt-button-view-model { display: block; }
  .pill { height: 36px; border-radius: 18px; border: 0; padding: 0 16px; background: rgba(255,255,255,.1); color: #f1f1f1; font: 500 14px Roboto, Arial; }
  yt-button-view-model { margin-left: 8px; }
  #related { padding: 16px 0 400px; }
</style></head>
<body><ytd-app><ytd-watch-flexy video-id="${id}">
  <div id="player"><div id="movie_player" class="html5-video-player"><video muted></video></div></div>
  <ytd-watch-metadata>
    <h1 id="title">${title}</h1>
    <div id="actions"><div id="top-level-buttons-computed">
      <segmented-like-dislike-button-view-model><button class="pill">Like 2M</button></segmented-like-dislike-button-view-model>
      <yt-button-view-model><button class="pill">Share</button></yt-button-view-model>
    </div></div>
  </ytd-watch-metadata>
  <div id="related"><a id="thumbnail" href="/watch?v=jNQXAC9IVRw"><img alt="" src="https://i.ytimg.com:${port}/vi/jNQXAC9IVRw/hqdefault.jpg" width="168" height="94"></a></div>
</ytd-watch-flexy></ytd-app>
<script>
  // Like YouTube: the player swallows right-clicks.
  document.getElementById('movie_player').addEventListener('contextmenu', (e) => e.preventDefault());
  // Like YouTube's single-page navigation: new URL, freshly rendered actions row.
  window.spaNavigate = (videoId, newTitle) => {
    history.pushState({}, '', '/watch?v=' + videoId);
    document.querySelector('ytd-watch-flexy').setAttribute('video-id', videoId);
    document.getElementById('title').textContent = newTitle;
    const old = document.getElementById('top-level-buttons-computed');
    const row = old.cloneNode(false);
    row.innerHTML = '<segmented-like-dislike-button-view-model><button class="pill">Like 1K</button></segmented-like-dislike-button-view-model><yt-button-view-model><button class="pill">Share</button></yt-button-view-model>';
    old.replaceWith(row);
    document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
  };
</script>
</body></html>`;
}

function postPage(cdn) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Instagram</title><style>${IG_STYLE}</style></head>
<body><main>
  <div id="post">
    <div class="media"><div><img alt="" src="${cdn}/v/t51.82787-15/550001_4961394081366993_n.jpg?stp=dst-jpg_e35_p1080x1080&amp;oh=abc&amp;oe=68D0"></div><div class="overlay"></div></div>
    <a href="/p/${CODES.photo}/c/17988679980101802/"><time datetime="2026-09-16T00:00:00.000Z">1d</time></a>
  </div>
</main></body></html>`;
}

function storyPage(cdn, file, datetime) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stories • Instagram</title><style>${IG_STYLE}
  section { width: 420px; margin: 0 auto; }
  .story { position: relative; width: 420px; height: 746px; }
  .story img { width: 100%; height: 100%; object-fit: cover; display: block; }
</style></head>
<body><section>
  <header><a href="/some.user/">some.user</a> <time datetime="${datetime}">5h</time></header>
  <div class="story" id="story"><img alt="" decoding="sync" src="${cdn}/v/t51.2885-15/${file}?stp=dst-jpg_e15_p1080x1080&amp;oh=s&amp;oe=68D0"><div class="overlay"></div></div>
</section></body></html>`;
}

function genericPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Generic test page</title>
<meta property="og:image" content="/img/poster.jpg">
<style>
  body { margin: 0; font: 14px system-ui, sans-serif; padding: 16px 16px 400px; }
  section { margin: 0 0 24px; }
  .cover { position: relative; width: 400px; height: 300px; }
  .cover img { width: 400px; height: 300px; display: block; }
  .cover .shield { position: absolute; inset: 0; }
  #text { width: 400px; height: 60px; }
</style></head>
<body>
  <section id="picture">
    <picture>
      <source type="image/jpeg" srcset="/img/pic-1600.jpg 1600w, /img/pic-1200.jpg 1200w">
      <img alt="Test picture" src="/img/pic-400.jpg" srcset="/img/pic-400.jpg 400w" sizes="400px" width="400" height="300">
    </picture>
  </section>
  <section id="covered"><div class="cover"><a href="/img/linked-full.jpg"><img alt="" src="/img/pic-400.jpg"></a><div class="shield"></div></div></section>
  <section id="video"><video id="direct" src="/media/clip.mp4" poster="/img/poster.jpg" width="320" height="180" muted></video></section>
  <section id="stream"><video id="blob" width="320" height="180" muted></video></section>
  <section id="text"><p>Just some text with nothing to download under it.</p></section>
  <section id="fullscreen"><button id="go-fs" type="button">Fullscreen</button>
    <div id="fs-box" style="background:#222"><img id="fs-img" alt="" src="/img/pic-1200.jpg" width="400" height="300"></div></section>
  <script>
    document.getElementById('blob').src = URL.createObjectURL(new MediaSource());
    document.getElementById('go-fs').addEventListener('click', () => document.getElementById('fs-box').requestFullscreen());
  </script>
</body></html>`;
}

function strictCspPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Strict CSP</title></head>
<body style="margin:0">
  <img id="pic" alt="" src="/img/pic-1200.jpg" width="400" height="300">
</body></html>`;
}
