/*
 * Just download it: the bridge to the extension's own website.
 *
 * Runs only on justdownloadit.peterwild.pw. It tells the page the extension is
 * installed (the data-jdi-extension attribute on <html>, and a
 * "jdi-extension-ready" event), and passes on a link the page asks to open:
 *   window.postMessage({ jdi: 'open-link', url }, location.origin)
 * The service worker then opens the toolbar popup with that link looked up.
 * Nothing is downloaded until the person picks something there. The answer
 * comes back as { jdi: 'open-link-result', ok, opened: 'popup' | 'window' | 'tab', error? }.
 */
(() => {
  const version = chrome.runtime.getManifest().version;

  function announce() {
    if (!document.documentElement) return false;
    document.documentElement.dataset.jdiExtension = version;
    window.dispatchEvent(new Event('jdi-extension-ready'));
    return true;
  }
  if (!announce()) document.addEventListener('readystatechange', announce, { once: true });

  const answer = (result) => window.postMessage({ jdi: 'open-link-result', ...result }, location.origin);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.jdi !== 'open-link' || typeof data.url !== 'string' || data.url.length > 4096) return;
    chrome.runtime
      .sendMessage({ type: 'jdi:site-open-link', url: data.url })
      .then((res) => answer({ ok: !!(res && res.ok), opened: (res && res.opened) || '', error: (res && res.error) || '' }))
      .catch(() => answer({ ok: false, error: 'Couldn’t reach Just download it. Try reloading this page.' }));
  });
})();
