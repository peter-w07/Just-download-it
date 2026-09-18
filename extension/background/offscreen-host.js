/*
 * Just download it: where jobs run (combining tracks, MP3s, HLS, ZIPs, mixes,
 * GIF recordings), for the service worker.
 *
 * The job runner is offscreen/offscreen.js. Where it lives depends on the browser:
 *  - Chrome: a service worker has no DOM, so the runner lives in an offscreen
 *    document (offscreen/offscreen.html). Messages go to it through
 *    chrome.runtime with target: 'offscreen', and its reports come back as
 *    runtime messages sent from that document.
 *  - Firefox has no chrome.offscreen, but its background script runs in an
 *    event page, which does have a DOM. The runner is imported into this page
 *    instead, and messages become direct calls both ways, in the same shapes.
 *    An event page is put to sleep after ~30 s without extension events, which
 *    would throw away running jobs and their blob: URLs, so while the runner
 *    has work the page calls a cheap extension API now and then to stay awake.
 *
 * Exports:
 *   RUNS_IN_PAGE              true when the runner lives in this page (Firefox)
 *   ensureOffscreen()         resolves once the runner answers messages
 *   toOffscreen(message)      a runner message ({ type: 'jdi:job-start' | 'jdi:job-release' |
 *                             'jdi:record-start' | 'jdi:record-stop' | 'jdi:ping', … });
 *                             resolves to its answer, rejects when there is no runner
 *   closeOffscreen()          close the offscreen document (a no-op in Firefox)
 *   onOffscreenReport(fn)     fn(message) handles the runner's reports (jdi:job-progress,
 *                             jdi:job-done, jdi:job-failed) and requests (jdi:resolve-song,
 *                             answered with fn's return value or promise)
 *   isOffscreenSender(sender) a runtime message came from the offscreen document
 */

export const OFFSCREEN_PATH = 'offscreen/offscreen.html';
export const RUNS_IN_PAGE = !(globalThis.chrome && chrome.offscreen) && typeof document !== 'undefined';

// Firefox's idle timeout is 30 s; any extension API call resets it.
const KEEP_AWAKE_MS = 10000;

let ready = null;
let report = () => undefined;
let runner = null; // the imported module, in Firefox

export function onOffscreenReport(fn) {
  report = fn;
}

export function isOffscreenSender(sender) {
  return !!sender && !sender.tab && sender.url === chrome.runtime.getURL(OFFSCREEN_PATH);
}

export function ensureOffscreen() {
  if (!ready) {
    ready = (RUNS_IN_PAGE ? startInPage() : startDocument()).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

export async function toOffscreen(message) {
  if (!RUNS_IN_PAGE) return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  if (!runner) throw new Error('Could not establish connection. Receiving end does not exist.');
  // A copy, as a message would be: the runner must not share objects with the caller.
  const answer = await runner.handleMessage(structuredClone({ ...message, target: 'offscreen' }));
  if (message.type === 'jdi:job-start' || message.type === 'jdi:record-start') keepAwake();
  return answer;
}

export async function closeOffscreen() {
  ready = null;
  if (RUNS_IN_PAGE) return; // the runner stays loaded; the page sleeps once it's idle
  await chrome.offscreen.closeDocument().catch(() => {});
}

// ---------------------------------------------------------------------------
// Chrome: the offscreen document
// ---------------------------------------------------------------------------

async function startDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (!contexts.length) {
    await chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS', 'WORKERS', 'USER_MEDIA'],
        justification: 'Combine video and audio tracks, convert audio and record GIFs of a tab on this computer, then hand the file to the downloads API.',
      })
      .catch((err) => {
        if (!/single offscreen/i.test(String(err && err.message))) throw err;
      });
  }
  // The document exists before its script has registered a listener
  // (it loads a large module first). Wait until it answers.
  for (let attempt = 0; attempt < 50; attempt++) {
    const pong = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'jdi:ping' }).catch(() => null);
    if (pong && pong.ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Couldn't start the converter. Try again.");
}

// ---------------------------------------------------------------------------
// Firefox: the runner in this page
// ---------------------------------------------------------------------------

async function startInPage() {
  if (!runner) {
    try {
      runner = await import('../offscreen/offscreen.js');
    } catch (err) {
      console.warn('[Just download it] converter', err);
      throw new Error("Couldn't start the converter. Try again.");
    }
    // Reports are handled after the current task, like a message would be.
    runner.connect((message) => Promise.resolve().then(() => report(structuredClone(message))));
  }
}

let awakeTimer = 0;

/** Keep the event page awake while the runner has jobs, recordings or finished files. */
function keepAwake() {
  if (awakeTimer) return;
  awakeTimer = setInterval(async () => {
    const state = runner ? await runner.handleMessage({ target: 'offscreen', type: 'jdi:ping' }).catch(() => null) : null;
    const busy = state && (state.running || state.queued || state.finished || state.recording);
    if (!busy) {
      clearInterval(awakeTimer);
      awakeTimer = 0;
      return;
    }
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, KEEP_AWAKE_MS);
}
