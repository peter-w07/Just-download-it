/*
 * Just download it: runs in Facebook's own page (MAIN world).
 *
 * Facebook loads feed and reel videos through its GraphQL requests, so their
 * download links never appear in the page's HTML. This watches those responses
 * and hands any that mention video links to the extension's Facebook handler
 * (which runs in its own isolated world) as a DOM event. It reads responses
 * only; it never changes or blocks a request.
 */
(() => {
  'use strict';

  if (window.__jdiFacebookHook) return;
  window.__jdiFacebookHook = true;

  const INTERESTING = /browser_native_(hd|sd)_url|playable_url|"base_url"/;
  const MAX_LENGTH = 8 * 1024 * 1024;

  function share(text) {
    if (typeof text !== 'string' || text.length > MAX_LENGTH || !INTERESTING.test(text)) return;
    document.dispatchEvent(new CustomEvent('jdi:facebook-data', { detail: text }));
  }

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    if (/\/api\/graphql|\/ajax\//.test(String(url))) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') share(this.responseText);
        } catch {
          /* ignore */
        }
      });
    }
    return open.call(this, method, url, ...rest);
  };

  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(...args) {
    const result = originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
      if (/\/api\/graphql/.test(String(url || ''))) {
        result.then((res) => res.clone().text().then(share, () => {}), () => {});
      }
    } catch {
      /* ignore */
    }
    return result;
  };
})();
