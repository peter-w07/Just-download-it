/*
 * Just download it: content-script core.
 *
 * 1. Remembers where the user right-clicked (Chrome's menu click doesn't say
 *    which element was under the cursor) and lets each site handler snapshot
 *    what was there at that moment.
 * 2. When the menu item or a page button is clicked, runs the site handlers,
 *    shows the picker (or downloads the best option straight away), and asks
 *    the service worker to download what the user chose.
 * 3. Shows progress toasts until every file of a download has finished.
 * 4. For the toolbar popup: resolves "the main thing on this page" in a tab
 *    the service worker opened in the background, downloads what the user
 *    picked in the popup, and relays progress back to it.
 *
 * Files made or fetched in the page (screenshots, TikTok videos) are announced
 * to the service worker under a placeholder name (jdi:expect-download) and
 * saved with a download link it renames. Where the browser can't rename a
 * page's downloads (Firefox), the answer says { bytes: true } and the file
 * itself is sent instead (jdi:page-bytes); see handOver().
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});

  // If an older copy is running in this page (the extension was updated or
  // reloaded), unhook it so there's only ever one set of listeners.
  if (JDI.core && typeof JDI.core.teardown === 'function') {
    try {
      JDI.core.teardown();
    } catch {
      /* ignore */
    }
  }

  // Right-click positions older than this are ignored.
  const CONTEXT_MAX_AGE_MS = 2 * 60 * 1000;

  let lastContext = null;

  function onContextMenu(event) {
    // Pages can dispatch fake contextmenu events to redirect what we save.
    if (!event.isTrusted) return;
    const x = event.clientX;
    const y = event.clientY;
    let stack = [];
    try {
      stack = JDI.dom.deepElementsFromPoint(x, y);
    } catch {
      /* ignore */
    }
    const target = (event.composedPath && event.composedPath()[0]) || event.target;

    // Let handlers record what was under the cursor right now. By the time the
    // user picks the menu item, a story may have advanced or a carousel may
    // have recycled its slides.
    const snapshots = {};
    for (const handler of JDI.util.handlersFor(window.location)) {
      if (typeof handler.snapshot !== 'function') continue;
      try {
        snapshots[handler.id] = handler.snapshot({ x, y, stack, target });
      } catch {
        /* a snapshot is an optimization; resolve() can work without it */
      }
    }
    lastContext = { x, y, target, stack, snapshots, time: Date.now() };
  }

  // Capture phase on window: runs before the page's own handlers, even if a
  // site stops the event from propagating.
  window.addEventListener('contextmenu', onContextMenu, true);

  function onMessage(message, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id || !message) return false;
    if (message.type === 'jdi:ping') {
      sendResponse({ ok: true }); // this page already runs the content scripts
    } else if (message.type === 'jdi:invoke') {
      sendResponse({ ok: true });
      run(message).catch(reportCrash);
    } else if (message.type === 'jdi:resolve-page') {
      if (window.top !== window) return false; // only the top frame answers
      resolvePage().then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.userMessage) || (err && err.message) || err) }));
      return true;
    } else if (message.type === 'jdi:download-variants') {
      if (window.top !== window) return false;
      const variants = Array.isArray(message.variants) ? message.variants : [];
      download({ site: String(message.site || '') }, variants, null, {
        batch: String(message.batch || ''),
        relay: true,
        collection: cleanCollection(message.collection),
      }).then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;
    } else if (message.type === 'jdi:download-finished') {
      onDownloadFinished(message);
    } else if (message.type === 'jdi:job-progress') {
      onJobProgress(message);
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function reportCrash(err) {
    console.warn('[Just download it]', err);
    JDI.picker.toast(`Just download it hit an error: ${err && err.message ? err.message : err}`, { kind: 'error' });
  }

  // ---------------------------------------------------------------------------
  // Resolve
  // ---------------------------------------------------------------------------

  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(JDI.util.DEFAULT_SETTINGS);
      return JDI.util.cleanSettings(stored);
    } catch {
      return JDI.util.cleanSettings({});
    }
  }

  function contextFromRightClick(message, settings) {
    const fresh = lastContext && Date.now() - lastContext.time < CONTEXT_MAX_AGE_MS ? lastContext : null;
    let stack = fresh ? fresh.stack : [];
    // If the page re-rendered since the right-click, hit-test again.
    if (fresh && (!stack.length || !stack[0].isConnected)) {
      stack = JDI.dom.deepElementsFromPoint(fresh.x, fresh.y);
    }
    return {
      x: fresh ? fresh.x : NaN,
      y: fresh ? fresh.y : NaN,
      target: fresh ? fresh.target : null,
      stack,
      snapshots: fresh ? fresh.snapshots : {},
      info: message.info || {},
      lateInjection: !!message.lateInjection,
      settings,
    };
  }

  async function run(message) {
    const settings = await loadSettings();
    const ctx = contextFromRightClick(message, settings);
    await present({
      ctx,
      handlers: JDI.util.handlersFor(window.location),
      mode: message.mode === 'best' ? 'best' : 'choose',
      anchor: { x: ctx.x, y: ctx.y },
    });
  }

  /**
   * Open the picker for a page button (e.g. YouTube's Download button).
   * @param handlerId  which handler resolves it
   * @param snapshot   what the handler's resolve() should work on
   * @param anchor     the button element; the picker opens next to it
   */
  async function openPicker({ handlerId, snapshot, anchor }) {
    const settings = await loadSettings();
    const handler = JDI.handlers.find((h) => h.id === handlerId);
    if (!handler) return;
    const ctx = {
      x: NaN,
      y: NaN,
      target: null,
      stack: [],
      snapshots: { [handlerId]: snapshot },
      info: {},
      lateInjection: false,
      settings,
    };
    await present({
      ctx,
      handlers: [handler],
      mode: settings.skipPicker ? 'best' : 'choose',
      anchor: anchor ? { element: anchor } : {},
    });
  }

  let invocationCounter = 0;

  async function present({ ctx, handlers, mode, anchor }) {
    const choose = mode !== 'best';
    const picker = choose ? JDI.picker.open(anchor) : null;
    const statusId = `jdi-resolve-${invocationCounter++}`;
    if (!choose) JDI.picker.toast('Finding the best quality…', { id: statusId });

    let resolution = null;
    let failure = null;
    for (const handler of handlers) {
      try {
        resolution = await handler.resolve({ ...ctx, snapshot: ctx.snapshots[handler.id] || null });
      } catch (err) {
        failure = failure || err;
        resolution = null;
      }
      if (picker && picker.closed) return;
      resolution = tidy(resolution, ctx.settings);
      if (resolution) break;
    }

    if (!resolution) {
      let text = (failure && failure.userMessage) || "Couldn't find a photo, video or audio file there.";
      if (!failure && ctx.lateInjection) {
        text = 'Just download it was just installed or updated. Reload this page, then try again.';
      }
      if (failure && !failure.userMessage) console.warn('[Just download it]', failure);
      if (picker) picker.showError(text);
      else JDI.picker.toast(text, { id: statusId, kind: 'error' });
      return;
    }

    if (picker) {
      picker.showResolution(resolution, {
        onDownload: (choice) => downloadChoice(resolution, choice, ctx.settings),
        onSizes: probeSizes,
        settings: ctx.settings,
      });
      return;
    }

    const item = resolution.items[resolution.focus];
    const best = item.variants[0];
    // A notice (e.g. "Instagram is limiting requests, this is the smaller page
    // version") matters more when nobody sees a picker.
    const res = await download(resolution, [best], statusId);
    if (res.ok && resolution.notice) JDI.picker.toast(resolution.notice, { kind: 'info', timeout: 8000 });
  }

  /**
   * The main thing on this page, for a link pasted into the toolbar popup.
   * Handlers say what that is with pageSnapshot(); the generic handler looks
   * at the whole page when ctx.page is set.
   */
  async function resolvePage() {
    const settings = await loadSettings();
    let failure = null;
    for (const handler of JDI.util.handlersFor(window.location)) {
      let snapshot = null;
      if (typeof handler.pageSnapshot === 'function') {
        try {
          snapshot = await handler.pageSnapshot();
        } catch (err) {
          failure = failure || err;
        }
      }
      if (!snapshot && handler.id !== 'generic') continue;
      try {
        const resolution = tidy(
          await handler.resolve({ x: NaN, y: NaN, target: null, stack: [], snapshots: {}, info: { pageUrl: window.location.href }, lateInjection: false, settings, snapshot, page: true }),
          settings,
        );
        if (resolution) return { ok: true, resolution };
      } catch (err) {
        failure = failure || err;
        if (!err || !err.userMessage) console.warn('[Just download it]', err);
      }
    }
    // final: a definite answer (log in, not a post, live stream) that waiting won't change.
    return { ok: false, final: !!(failure && failure.final), error: (failure && failure.userMessage) || 'Couldn’t find a photo, video or audio file on that page.' };
  }

  /**
   * Drop empty items/variants, clamp the focus index and list the preferred
   * song format (settings.audioFormat) first. Returns null if nothing is left.
   */
  function tidy(resolution, settings) {
    if (!resolution || !Array.isArray(resolution.items)) return null;
    const items = resolution.items
      .map((item) => withMp3Option({ ...item, variants: (item.variants || []).filter((v) => v && v.url) }))
      .filter((item) => item.variants.length);
    if (!items.length) return null;
    const focus = Math.min(Math.max(Number(resolution.focus) || 0, 0), items.length - 1);
    return JDI.util.preferAudioFormat({ ...resolution, items, focus }, settings && settings.audioFormat);
  }

  /** Videos saved as plain files also get an MP3 of their sound, unless the site already offers audio. */
  function withMp3Option(item) {
    const variants = item.variants;
    if (variants.some((v) => v.kind === 'audio')) return item;
    const video = variants.find(
      (v) => v.kind === 'video' && !v.job && v.via !== 'page' && /^https:/i.test(v.url) && /^(mp4|m4v|mov)$/.test(JDI.util.normalizeExt(v.ext) || JDI.util.extFromUrl(v.url)),
    );
    if (!video) return item;
    const mp3 = {
      kind: 'audio',
      group: 'Audio only',
      label: 'MP3',
      detail: 'The video’s sound · converted on your computer',
      url: video.url,
      ext: 'mp3',
      filename: video.filename,
      job: { type: 'mp3', audio: video.url },
    };
    const other = variants.findIndex((v) => v.group === 'Other');
    const next = variants.slice();
    next.splice(other < 0 ? next.length : other, 0, mp3);
    return { ...item, variants: next };
  }

  // ---------------------------------------------------------------------------
  // Download + progress toasts
  // ---------------------------------------------------------------------------

  const batches = new Map();
  const pendingBatches = new Set(); // sent, reply not back yet
  const earlyMessages = new Map(); // batch -> messages that arrived before the reply
  let batchCounter = 0;

  /**
   * What the picker asked for.
   *  - A single row: that one file.
   *  - "Download all" (all): every item's first variant as its own file, with
   *    the album or playlist (collection) and each file's place in it
   *    (position), so the service worker can number songs and put them in a folder.
   *  - The menu's ZIP or mix (mode): one file made from all of them.
   */
  function downloadChoice(resolution, { files = [], mode = 'files', all = false } = {}, settings) {
    if (mode === 'zip' || mode === 'mix') {
      const bundle = JDI.util.bundleVariant(resolution, mode, settings || JDI.util.cleanSettings({}));
      return download(resolution, [bundle], null, { collection: JDI.util.collectionOf(resolution) });
    }
    if (!all) return download(resolution, files);
    const positioned = files.map((v) => {
      const index = resolution.items.findIndex((item) => item.variants.includes(v));
      return index >= 0 ? { ...v, position: index + 1 } : v;
    });
    return download(resolution, positioned, null, { collection: JDI.util.collectionOf(resolution) });
  }

  /** { name, total } from a message, or null. */
  function cleanCollection(collection) {
    if (!collection || typeof collection !== 'object' || typeof collection.name !== 'string' || !collection.name.trim()) return null;
    return { name: collection.name.slice(0, 200), total: Math.max(0, Math.min(10000, Math.floor(Number(collection.total)) || 0)) };
  }

  /** { type: 'zip' | 'mix', count } when the download is one ZIP or one mix, else null. */
  function bundleOf(variants) {
    const job = variants.length === 1 && variants[0] && variants[0].job;
    if (!job || (job.type !== 'zip' && job.type !== 'mix')) return null;
    return { type: job.type, count: Array.isArray(job.entries) ? job.entries.length : 0 };
  }

  /** "Preparing your ZIP… 42%", "Mixing 12 songs… 42%"; percent null = the file is being saved. */
  function bundleProgressText(bundle, percent) {
    const counted = bundle.count ? `${bundle.count} ${bundle.count === 1 ? 'song' : 'songs'}` : 'the songs';
    if (percent == null) return bundle.type === 'zip' ? 'Saving your ZIP…' : 'Saving your mix…';
    const suffix = percent > 0 ? ` ${percent}%` : '';
    return bundle.type === 'zip' ? `Preparing your ZIP…${suffix}` : `Mixing ${counted}…${suffix}`;
  }

  /** util.batchStatus, worded for a ZIP or a mix while it's being made. */
  function statusOf(state) {
    const status = JDI.util.batchStatus(state);
    if (!state.bundle || status.final) return status;
    const working = Array.from(state.progress.values()).some((p) => p < 1);
    return { ...status, text: bundleProgressText(state.bundle, working ? status.percent : null) };
  }

  /**
   * @param options.batch       batch id to use (the popup's)
   * @param options.relay       also send progress to the service worker for the toolbar popup
   * @param options.collection  { name, total } for "Download all", a ZIP or a mix
   */
  async function download(resolution, variants, toastId, options = {}) {
    const batch = options.batch || `b${Date.now().toString(36)}-${batchCounter++}`;
    const relay = !!options.relay;
    const site = resolution.site || '';
    const collection = cleanCollection(options.collection);
    const bundle = bundleOf(variants);
    // "page" variants are fetched here, inside the site, because its CDN wants
    // the page's cookies or referrer (TikTok). Everything else goes to the service worker.
    const pageVariants = variants.filter((v) => v.via === 'page' && !v.job);
    const files = variants
      .filter((v) => !pageVariants.includes(v))
      .map((v) => {
        const file = { url: v.url, filename: v.filename, ext: v.ext, job: v.job };
        const position = Math.floor(Number(v.position));
        if (position > 0) file.position = position;
        return file;
      });
    const id = toastId || batch;
    const jobs = files.filter((f) => f.job).length + pageVariants.length;
    if (bundle) JDI.picker.toast(bundleProgressText(bundle, 0), { id });
    else if (jobs) JDI.picker.toast(jobs === 1 && variants.length === 1 ? 'Preparing your file…' : 'Preparing your files…', { id });

    pendingBatches.add(batch);
    let response = { results: [] };
    try {
      if (files.length) {
        const request = { type: 'jdi:download', site, batch, files };
        if (collection) request.collection = collection;
        response = await chrome.runtime.sendMessage(request);
      }
    } catch (err) {
      pendingBatches.delete(batch);
      earlyMessages.delete(batch);
      const text = /context invalidated|receiving end/i.test(String(err && err.message))
        ? 'Just download it was updated. Reload this page and try again.'
        : String((err && err.message) || err);
      if (toastId || jobs) JDI.picker.toast(text, { id, kind: 'error' });
      return { ok: false, error: text };
    }
    pendingBatches.delete(batch);

    const results = response && Array.isArray(response.results) ? response.results.slice() : [];
    const pageKeys = pageVariants.map((v, i) => `page-${i}`);
    for (const key of pageKeys) results.push({ ok: true, jobId: key });
    const started = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    if (!started.length) {
      earlyMessages.delete(batch);
      const text = (refused[0] && refused[0].error) || (response && response.error) || 'Download failed.';
      if (toastId || jobs) JDI.picker.toast(text, { id, kind: 'error' });
      return { ok: false, error: text };
    }

    const state = {
      id,
      batch,
      relay,
      started: started.length, // each reports back exactly once (download-finished)
      refused: refused.length, // rejected before starting; never report back
      done: 0,
      failed: 0,
      error: refused[0] ? refused[0].error : '',
      note: '', // e.g. songs a mix had to leave out (shown with the success text)
      bundle,
      progress: new Map(started.filter((r) => r.jobId).map((r) => [r.jobId, 0])),
    };
    batches.set(batch, state);
    renderProgress(state);

    for (const message of earlyMessages.get(batch) || []) {
      if (message.type === 'jdi:job-progress') onJobProgress(message);
      else onDownloadFinished(message);
    }
    earlyMessages.delete(batch);
    pageVariants.forEach((v, i) => downloadInPage(v, { site, batch, key: pageKeys[i] }));
    return { ok: true, started: started.length, refused: refused.length, error: state.error };
  }

  /**
   * Save a file made in this page (e.g. a screenshot) to the usual folder.
   * Shows progress/finished toasts like any other download.
   */
  async function saveBlob(blob, { site = '', base = 'download', ext }) {
    const batch = `b${Date.now().toString(36)}-${batchCounter++}`;
    const type = blob.type || '';
    const cleanExt = JDI.util.normalizeExt(ext) || JDI.util.extFromMime(type) || 'bin';
    const name = `jdi-${batch}-save.${cleanExt}`;
    const state = { id: batch, batch, relay: false, started: 1, refused: 0, done: 0, failed: 0, error: '', progress: new Map() };
    batches.set(batch, state);
    let answer;
    try {
      answer = await chrome.runtime.sendMessage({ type: 'jdi:expect-download', name, site, base, ext: cleanExt, batch });
    } catch (err) {
      batches.delete(batch);
      const text = /context invalidated|receiving end/i.test(String(err && err.message))
        ? 'Just download it was updated. Reload this page and try again.'
        : String((err && err.message) || err);
      JDI.picker.toast(text, { id: batch, kind: 'error' });
      return { ok: false, error: text };
    }
    renderProgress(state);
    try {
      await handOver(blob, name, answer);
    } catch (err) {
      onDownloadFinished({ batch, ok: false, error: String((err && err.message) || err) });
      return { ok: false, error: String((err && err.message) || err) };
    }
    return { ok: true, batch };
  }

  /**
   * Save a file announced with jdi:expect-download (`answer` is its reply):
   * a download link named `name`, which the service worker renames, or the
   * bytes themselves when it asks for them (it can't rename page downloads).
   */
  async function handOver(blob, name, answer) {
    if (answer && answer.bytes) {
      const res = await chrome.runtime.sendMessage({ type: 'jdi:page-bytes', name, blob });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Download failed.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  /**
   * Show progress for a job the service worker already started for this page
   * (e.g. a GIF recording), until it's saved.
   */
  function trackJob({ batch, jobId }) {
    const state = { id: batch, batch, relay: false, started: 1, refused: 0, done: 0, failed: 0, error: '', progress: new Map([[jobId, 0]]) };
    batches.set(batch, state);
    renderProgress(state);
    for (const message of earlyMessages.get(batch) || []) {
      if (message.type === 'jdi:job-progress') onJobProgress(message);
      else onDownloadFinished(message);
    }
    earlyMessages.delete(batch);
  }

  /** Resolve a link in the service worker (sites whose data comes from public APIs). */
  async function resolveLink(url) {
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'jdi:resolve-link', url: String(url) });
    } catch (err) {
      const text = /context invalidated|receiving end/i.test(String(err && err.message))
        ? 'Just download it was updated. Reload this page and try again.'
        : 'Couldn’t reach Just download it. Try again.';
      throw Object.assign(new Error('unreachable'), { userMessage: text });
    }
    if (res && res.ok) return res.resolution;
    if (res && res.needsTab) return null;
    throw Object.assign(new Error('resolve failed'), { userMessage: (res && res.error) || 'Couldn’t find anything to download there.' });
  }

  /** Fetch a file with the page's own cookies and referrer, then save it. */
  async function downloadInPage(variant, { site, batch, key }) {
    try {
      const res = await fetch(variant.url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || Number(variant.size) || 0;
      const chunks = [];
      let received = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) onJobProgress({ batch, jobId: key, progress: Math.min(0.99, received / total) });
      }
      const type = (res.headers.get('content-type') || '').split(';')[0];
      const ext = JDI.util.normalizeExt(variant.ext) || JDI.util.extFromMime(type) || 'mp4';
      const name = `jdi-${batch}-${key}.${ext}`;
      const answer = await chrome.runtime.sendMessage({ type: 'jdi:expect-download', name, site, base: variant.filename, ext, batch });
      await handOver(new Blob(chunks, { type }), name, answer);
      onJobProgress({ batch, jobId: key, progress: 1 });
    } catch (err) {
      // Blocked (CORS) or refused: let the browser try to download it directly.
      onJobProgress({ batch, jobId: key, progress: 1 });
      let response = null;
      try {
        response = await chrome.runtime.sendMessage({
          type: 'jdi:download',
          site,
          batch,
          files: [{ url: variant.url, filename: variant.filename, ext: variant.ext }],
        });
      } catch {
        /* handled below */
      }
      const result = response && response.results && response.results[0];
      if (!result || !result.ok) {
        onDownloadFinished({ batch, ok: false, error: (result && result.error) || String((err && err.message) || err) });
      }
    }
  }

  function park(message) {
    if (!pendingBatches.has(message.batch)) return; // unknown or stale batch
    if (!earlyMessages.has(message.batch)) earlyMessages.set(message.batch, []);
    earlyMessages.get(message.batch).push(message);
  }

  function renderProgress(state) {
    const status = statusOf(state);
    JDI.picker.toast(status.text, { id: state.id, kind: status.kind });
    if (state.relay) {
      chrome.runtime.sendMessage({ type: 'jdi:relay-status', batch: state.batch, ...status }).catch(() => {});
    }
  }

  function onJobProgress(message) {
    const state = batches.get(message.batch);
    if (!state) return park(message);
    if (!state.progress.has(message.jobId)) return;
    state.progress.set(message.jobId, Math.max(state.progress.get(message.jobId), Number(message.progress) || 0));
    renderProgress(state);
  }

  function onDownloadFinished(message) {
    const state = batches.get(message.batch);
    if (!state) return park(message);

    if (message.ok) state.done++;
    else {
      state.failed++;
      state.error = state.error || message.error || '';
    }
    if (typeof message.note === 'string' && message.note.trim()) {
      state.note = [state.note, message.note.trim().slice(0, 300)].filter(Boolean).join(' ');
    }

    if (state.done + state.failed >= state.started) batches.delete(message.batch);
    renderProgress(state);
  }

  // ---------------------------------------------------------------------------
  // File sizes for the picker
  // ---------------------------------------------------------------------------

  async function probeSizes(variants) {
    const urls = variants.map((v) => v.url).filter((u) => /^https?:/i.test(u));
    if (!urls.length) return new Map();
    try {
      const res = await chrome.runtime.sendMessage({ type: 'jdi:probe', urls });
      return new Map(Object.entries((res && res.sizes) || {}));
    } catch {
      return new Map();
    }
  }

  JDI.core = {
    openPicker: (options) => openPicker(options).catch(reportCrash),
    saveBlob,
    trackJob,
    resolveLink,
    teardown() {
      window.removeEventListener('contextmenu', onContextMenu, true);
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* the old extension context is gone */
      }
      if (JDI.buttons && typeof JDI.buttons.teardown === 'function') {
        try {
          JDI.buttons.teardown();
        } catch {
          /* ignore */
        }
      }
    },
  };

  // Page buttons (YouTube, Instagram) start once the core is ready.
  if (JDI.buttons && typeof JDI.buttons.start === 'function') {
    loadSettings().then((settings) => JDI.buttons.start(settings));
  }
})();
