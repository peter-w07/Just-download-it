// Just download it: the "Paste a link" page.
//
// The link comes from the box, from ?url= (the 404 page sends
// "justdownloadit.peterwild.pw/<a link>" here), and goes to the extension if
// it's installed: its content script on this site (content/site-bridge.js)
// marks <html data-jdi-extension="0.4.1"> and opens its popup with the link.
// Without the extension, the page explains how to get it and offers what works
// without it: opening a direct file, and a screenshot or GIF of the page.
(() => {
  'use strict';

  const SITES = [
    [/(^|\.)music\.youtube\.com$/, 'YouTube Music'],
    [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/, 'YouTube'],
    [/(^|\.)open\.spotify\.com$|(^|\.)spotify\.link$/, 'Spotify'],
    [/(^|\.)music\.apple\.com$/, 'Apple Music'],
    [/(^|\.)instagram\.com$/, 'Instagram'],
    [/(^|\.)tiktok\.com$/, 'TikTok'],
    [/(^|\.)(x\.com|twitter\.com)$/, 'X'],
    [/(^|\.)twitch\.tv$/, 'Twitch'],
    [/(^|\.)(facebook\.com|fb\.watch)$/, 'Facebook'],
    [/(^|\.)snapchat\.com$/, 'Snapchat'],
    [/(^|\.)medal\.tv$/, 'Medal'],
  ];
  const FILE_EXT = /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|aac|wav|ogg|opus|flac|jpe?g|png|gif|webp|avif|svg|pdf|zip)$/i;

  const form = document.getElementById('link-form');
  const input = document.getElementById('link');
  const summary = document.getElementById('link-summary');
  if (!form || !input || !summary) return;
  const $ = (selector) => summary.querySelector(selector);
  const states = {
    extension: $('[data-state="extension"]'),
    noExtension: $('[data-state="no-extension"]'),
    file: $('[data-state="file"]'),
    capture: $('[data-state="capture"]'),
  };

  let current = null; // { url, site, host }

  /** A link as typed or pasted: "youtu.be/x", "https:/x" (a path lost a slash), or a whole shortcut address. */
  function normalize(text) {
    let link = String(text || '').trim();
    if (!link) return null;
    link = link.replace(/^(https?:\/\/)?justdownloadit\.peterwild\.pw\/+/i, '');
    link = link.replace(/^(https?):\/*/i, '$1://');
    if (!/^https?:\/\//i.test(link)) link = `https://${link}`;
    let url;
    try {
      url = new URL(link);
    } catch {
      return null;
    }
    if (!/\./.test(url.hostname) || url.hostname === location.hostname) return null;
    const host = url.hostname.replace(/^www\./, '');
    const known = SITES.find(([pattern]) => pattern.test(url.hostname));
    return { url: url.href, host, site: known ? known[1] : '', known: !!known, file: FILE_EXT.test(url.pathname) };
  }

  function extensionVersion() {
    return document.documentElement.dataset.jdiExtension || '';
  }

  /** The extension's content script marks the page at document_start; give it a moment in case it's slow. */
  function waitForExtension(ms) {
    return new Promise((resolve) => {
      if (extensionVersion()) return resolve(true);
      const timer = setTimeout(() => resolve(!!extensionVersion()), ms);
      window.addEventListener('jdi-extension-ready', () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    });
  }

  function openInExtension(url) {
    return new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.source !== window || !event.data || event.data.jdi !== 'open-link-result') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(event.data);
      };
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ ok: false, error: 'Just download it didn’t answer. Reload this page and try again.' });
      }, 8000);
      window.addEventListener('message', onMessage);
      window.postMessage({ jdi: 'open-link', url }, '/');
    });
  }

  const extTitle = $('[data-ext-title]');
  const extText = $('[data-ext-text]');
  const openButton = $('[data-open-ext]');

  async function sendToExtension() {
    if (!current) return;
    openButton.disabled = true;
    extTitle.textContent = 'Opening it in Just download it…';
    extText.textContent = 'Pick what to save in the menu that opens.';
    const res = await openInExtension(current.url);
    openButton.disabled = false;
    if (res.ok) {
      extTitle.textContent = 'It’s open in Just download it';
      extText.textContent = {
        window: 'Pick what to save in the small window that opened. Closed it by accident? Open it again.',
        tab: 'Pick what to save in the tab that opened. Closed it by accident? Open it again.',
      }[res.opened] || 'Pick what to save in its menu, under the toolbar button. Closed it by accident? Open it again.';
    } else {
      extTitle.textContent = 'Couldn’t open Just download it';
      extText.textContent = res.error || 'Click Just download it in your toolbar and paste the link there.';
    }
  }
  openButton.addEventListener('click', sendToExtension);

  /** Show what can be done with a link. `auto`: it came in the address, so open it right away. */
  async function show(link, { auto }) {
    current = link;
    summary.hidden = false;
    $('[data-link-site]').textContent = link.site || link.host;
    $('[data-link-url]').textContent = link.url.replace(/^https?:\/\/(www\.)?/, '');
    $('[data-link-url]').title = link.url;
    $('[data-open-file]').href = link.url;
    $('[data-capture-link]').href = `capture.html?url=${encodeURIComponent(link.url)}`;
    states.file.hidden = !link.file;
    states.capture.hidden = false;

    const hasExtension = await waitForExtension(auto ? 800 : 300);
    if (current !== link) return;
    states.extension.hidden = !hasExtension;
    states.noExtension.hidden = hasExtension;
    if (!hasExtension) {
      extTitle.textContent = '';
      return;
    }
    // A link from the address bar opens by itself on the sites Just download it
    // knows; anything else waits for a click, so a link to this page can't make
    // the extension open some other website in the background.
    if (!auto || link.known) {
      sendToExtension();
    } else {
      extTitle.textContent = `Download from ${link.host}?`;
      extText.textContent = 'Just download it will open this page in a background tab to find what’s on it.';
    }
  }

  function showError(message) {
    current = null;
    summary.hidden = true;
    input.setCustomValidity(message);
    input.reportValidity();
  }
  input.addEventListener('input', () => input.setCustomValidity(''));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const link = normalize(input.value);
    if (!link) return showError('That doesn’t look like a link. Paste the whole address, like https://www.youtube.com/watch?v=…');
    input.value = link.url;
    history.replaceState(null, '', `?url=${encodeURIComponent(link.url)}`);
    show(link, { auto: false });
  });

  // Pasting a link is the whole point: go straight away.
  input.addEventListener('paste', () => setTimeout(() => {
    if (normalize(input.value)) form.requestSubmit();
  }, 0));

  const copy = $('[data-copy-link]');
  copy.addEventListener('click', async () => {
    if (!current) return;
    const label = copy.querySelector('.copy-label');
    try {
      await navigator.clipboard.writeText(current.url);
      label.textContent = 'Copied';
      copy.classList.add('is-copied');
    } catch {
      input.select();
      label.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => {
      label.textContent = 'Copy the link';
      copy.classList.remove('is-copied');
    }, 2000);
  });

  const fromAddress = new URLSearchParams(location.search).get('url');
  if (fromAddress) {
    const link = normalize(fromAddress);
    if (link) {
      input.value = link.url;
      show(link, { auto: true });
    } else {
      input.value = fromAddress;
    }
  }
})();
