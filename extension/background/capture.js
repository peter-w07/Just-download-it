/*
 * Just download it: "Just download web page" in the service worker (the
 * background event page in Firefox).
 *
 * content/capture.js (top frame only) asks for:
 *   { type: 'jdi:capture-visible', rect }
 *       -> { ok: true, dataUrl, cropped?, gapMs? } a PNG screenshot of what the tab shows now
 *       `rect` is the layout viewport in document CSS px ({ x: scrollX, y: scrollY,
 *       width, height }). Where the browser can capture a rect (Firefox), the
 *       image is exactly that area, without scrollbars, and the answer says
 *       cropped: true. Otherwise (Chrome) it is the whole visible tab.
 *       gapMs: how long to wait before the next screenshot (Chrome allows two
 *       per second; left out, the page waits its own default).
 *   { type: 'jdi:record-start', crop, viewport, batch, base }
 *       -> { ok: true, recId } | { ok: false, error }
 *       Starts a GIF recording of `crop` (CSS px, relative to the viewport)
 *       in the job runner (offscreen/recorder.js: an offscreen document in
 *       Chrome, this page in Firefox). The recording is a job like any other:
 *       when it's done the service worker saves the GIF and tells the tab
 *       (jdi:job-progress / jdi:download-finished with `batch`).
 *   { type: 'jdi:record-stop', recId, cancel }
 *       -> { ok } Stop and save, or cancel.
 *
 * How the tab is recorded depends on the browser, by feature:
 *  - chrome.tabCapture (Chrome): a stream ID for the tab goes to the runner,
 *    which opens the tab's video stream.
 *  - tabs.captureTab (Firefox, which has no tabCapture): the runner gets the
 *    tab's ID and takes screenshots of it in a loop (recorder.js). The runner
 *    lives in this very page there, so it can call the tabs API itself.
 *
 * handleCaptureMessage returns true when it will answer asynchronously and
 * undefined for messages it doesn't handle. `deps.toOffscreen(message)` sends
 * a message to the job runner (offscreen-host.js).
 */

// Firefox renders a screenshot of any tab (or a rect of it) on demand, with no rate limit.
const CAN_CAPTURE_TAB = !!(chrome.tabs && typeof chrome.tabs.captureTab === 'function');
const CAN_STREAM_TAB = !!(chrome.tabCapture && typeof chrome.tabCapture.getMediaStreamId === 'function');
const BROWSER = /\bFirefox\//.test(String(globalThis.navigator && navigator.userAgent)) ? 'Firefox' : 'Chrome';

// Chrome allows two captureVisibleTab calls per second.
const CAPTURE_GAP_MS = CAN_CAPTURE_TAB ? 0 : 510;
const GIF_FPS = 10;
const GIF_MAX_WIDTH = 800;
const GIF_MAX_SECONDS = 60;

let captureQueue = Promise.resolve();
let lastCaptureAt = 0;

export function handleCaptureMessage(message, sender, sendResponse, deps) {
  const tab = sender && sender.tab;
  if (!message || !tab || tab.id == null || tab.id < 0) return undefined;
  let work;
  if (message.type === 'jdi:capture-visible') work = captureVisible(message, sender);
  else if (message.type === 'jdi:record-start') work = startRecording(message, sender, deps);
  else if (message.type === 'jdi:record-stop') work = stopRecording(message, sender, deps);
  else return undefined;
  work.then(sendResponse, (err) => sendResponse({ ok: false, error: describe(err) }));
  return true;
}

function userError(text) {
  return Object.assign(new Error(text), { userMessage: text });
}

function describe(err) {
  if (err && err.userMessage) return String(err.userMessage);
  const text = String((err && err.message) || err || 'Something went wrong.');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The message a runner call gets, whichever way the runner is reached. */
function toRunner(deps, message) {
  if (deps && typeof deps.toOffscreen === 'function') return deps.toOffscreen(message);
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/** A rect in document CSS px, or null. */
function cleanRect(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  if (!r) return null;
  const values = [r.x, r.y, r.width, r.height].map(Number);
  if (!values.every(Number.isFinite) || values[2] < 1 || values[3] < 1 || values[2] > 20000 || values[3] > 20000) return null;
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function captureVisible(message, sender) {
  if (sender.frameId) return Promise.resolve({ ok: false, error: 'Only the page itself can take screenshots.' });
  const tabId = sender.tab.id;
  const rect = CAN_CAPTURE_TAB ? cleanRect(message.rect) : null;
  const run = captureQueue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw userError('The tab was closed.');
      // captureVisibleTab shows whichever tab is in front: never save another one.
      if (!tab.active) throw userError('Keep the tab in front while it’s being captured, then try again.');
      lastCaptureAt = Date.now();
      try {
        // Firefox's captureVisibleTab takes a rect (and needs only activeTab, unlike captureTab).
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, rect ? { format: 'png', rect } : { format: 'png' });
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) throw new Error('empty capture');
        return rect ? { ok: true, dataUrl, cropped: true, gapMs: CAPTURE_GAP_MS } : { ok: true, dataUrl };
      } catch (err) {
        const text = String((err && err.message) || err);
        if (attempt < 4 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(text)) {
          await sleep(600);
          continue;
        }
        if (/minimi[sz]ed|not visible|hidden/i.test(text)) throw userError('Keep the window open while the page is being captured, then try again.');
        throw userError(`${BROWSER} didn’t let Just download it take a screenshot of this page.`);
      }
    }
  });
  captureQueue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// GIF recordings
// ---------------------------------------------------------------------------

function cleanViewport(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const width = Number(v.width);
  const height = Number(v.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16 || width > 20000 || height > 20000) return null;
  const pixelRatio = Number(v.pixelRatio);
  // The window with its scrollbars (a screenshot of the tab covers that).
  const windowWidth = Number(v.windowWidth);
  const windowHeight = Number(v.windowHeight);
  const inWindow = (n, min) => Number.isFinite(n) && n >= min && n <= min + 200;
  return {
    width,
    height,
    pixelRatio: Number.isFinite(pixelRatio) && pixelRatio > 0 && pixelRatio <= 8 ? pixelRatio : 1,
    windowWidth: inWindow(windowWidth, width) ? windowWidth : width,
    windowHeight: inWindow(windowHeight, height) ? windowHeight : height,
  };
}

function cleanCrop(raw, viewport) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const values = [c.x, c.y, c.width, c.height].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const x = Math.min(Math.max(values[0], 0), viewport.width);
  const y = Math.min(Math.max(values[1], 0), viewport.height);
  const width = Math.min(values[2] - (x - values[0]), viewport.width - x);
  const height = Math.min(values[3] - (y - values[1]), viewport.height - y);
  if (width < 8 || height < 8) return null;
  return { x, y, width, height };
}

async function recordingsFor(tabId) {
  const all = await chrome.storage.session.get(null).catch(() => ({}));
  const staleBefore = Date.now() - 15 * 60 * 1000; // left behind if the recorder crashed
  return Object.entries(all).filter(
    ([key, value]) => key.startsWith('job:') && value && value.recording && value.tabId === tabId && value.startedAt > staleBefore,
  );
}

async function startRecording(message, sender, deps) {
  if (sender.frameId) return { ok: false, error: 'Only the page itself can be recorded.' };
  if (!CAN_STREAM_TAB && !CAN_CAPTURE_TAB) {
    return { ok: false, error: `This version of ${BROWSER} can’t record tabs. Update ${BROWSER} and try again.` };
  }
  const viewport = cleanViewport(message.viewport);
  const crop = viewport && cleanCrop(message.crop, viewport);
  if (!crop) return { ok: false, error: 'That part of the page is too small to record. Pick a bigger one.' };

  const tabId = sender.tab.id;
  if ((await recordingsFor(tabId)).length) return { ok: false, error: 'This tab is already being recorded.' };

  const recId = crypto.randomUUID();
  const key = `job:${recId}`;
  const batch = typeof message.batch === 'string' && message.batch ? message.batch.slice(0, 64) : `r${Date.now().toString(36)}`;
  const base = String(message.base || '').slice(0, 200) || 'Recording';

  await deps.withOffscreenLock(async () => {
    // Stored first: the runner may report back as soon as it starts.
    await chrome.storage.session.set({
      [key]: { tabId, frameId: 0, batch, site: 'Captures', base, ext: 'gif', recording: true, startedAt: Date.now() },
    });
    try {
      // The runner loads first: a stream ID is only valid for a few seconds.
      await deps.ensureOffscreen();
      const box = {
        ...crop,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        windowWidth: viewport.windowWidth,
        windowHeight: viewport.windowHeight,
        pixelRatio: viewport.pixelRatio,
      };
      // Chrome: the tab's video stream. Firefox: screenshots of the tab, taken by the runner.
      const source = CAN_STREAM_TAB ? { streamId: await tabStreamId(tabId) } : { tabId };
      const ack = await toRunner(deps, {
        type: 'jdi:record-start',
        recId,
        ...source,
        crop: box,
        fps: GIF_FPS,
        maxWidth: GIF_MAX_WIDTH,
        maxSeconds: GIF_MAX_SECONDS,
      });
      if (!ack || !ack.ok) throw userError((ack && ack.error) || 'Couldn’t start recording. Try again.');
    } catch (err) {
      await chrome.storage.session.remove(key);
      throw err;
    }
  });
  return { ok: true, recId };
}

/** Chrome: a tab-capture stream ID for the runner (valid for a few seconds). */
async function tabStreamId(tabId) {
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    console.warn('[Just download it] tabCapture.getMediaStreamId failed', err);
    throw userError(
      /invoked|activeTab|permission/i.test(String(err && err.message))
        ? 'Chrome only lets Just download it record a tab right after you pick it from the right-click menu or the toolbar button. Choose “Just download web page” again.'
        : 'Chrome didn’t let Just download it record this tab.',
    );
  }
  if (!streamId) throw userError('Chrome didn’t let Just download it record this tab.');
  return streamId;
}

async function stopRecording(message, sender, deps) {
  const recId = String(message.recId || '');
  const key = `job:${recId}`;
  const record = recId ? (await chrome.storage.session.get(key))[key] : null;
  if (!record || record.tabId !== sender.tab.id) return { ok: true, gone: true }; // already finished (or failed)
  const cancel = !!message.cancel;
  // Without its record, the job's "Canceled." report is dropped silently.
  if (cancel) await chrome.storage.session.remove(key);
  let res;
  try {
    res = await toRunner(deps, { type: 'jdi:record-stop', recId, cancel });
  } catch {
    res = undefined;
  }
  if (res === undefined && !cancel) {
    // The runner is gone (it crashed or was closed), so nothing will report back.
    await chrome.storage.session.remove(key);
    return { ok: false, error: 'The recording was lost. Try again.' };
  }
  return { ok: true };
}
