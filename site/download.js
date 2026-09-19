// Just download it: the "Paste a link" page.
//
// The link comes from the box, or from ?url= (the 404 page sends
// "justdownloadit.peterwild.pw/<a link>" here).
//  - With the extension installed, its content script on this site
//    (content/site-bridge.js) marks <html data-jdi-extension="0.4.1">, and the
//    link goes to the extension, which opens its popup with it looked up.
//  - Without it, the page downloads what it can by itself (web-download.js:
//    X, Twitch clips, cover art, thumbnails…) and says what only the
//    extension can get, with the store buttons, and offers a screenshot or GIF.
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

  const form = document.getElementById('link-form');
  const input = document.getElementById('link');
  const summary = document.getElementById('link-summary');
  if (!form || !input || !summary) return;
  const $ = (selector) => summary.querySelector(selector);
  const states = {
    extension: $('[data-state="extension"]'),
    web: $('[data-state="web"]'),
    noExtension: $('[data-state="no-extension"]'),
    capture: $('[data-state="capture"]'),
  };
  const webBox = $('[data-web-results]');

  let current = null; // { url, site, host, known }
  let web = null; // web-download.js, loaded when first needed

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
    return { url: url.href, host, site: known ? known[1] : '', known: !!known };
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // ---------------------------------------------------------------------------
  // The extension
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Without the extension: what this page downloads by itself
  // ---------------------------------------------------------------------------

  const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19.5h14"/></svg>';
  const DONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  function setRow(row, state, text, fraction) {
    row.dataset.state = state;
    const go = row.querySelector('.go');
    const detail = row.querySelector('.detail');
    const bar = row.querySelector('.bar');
    if (state === 'busy') {
      go.textContent = fraction >= 0 ? `${Math.round(fraction * 100)}%` : '…';
      bar.style.width = `${Math.max(3, Math.round((fraction >= 0 ? fraction : 0.1) * 100))}%`;
      if (text) detail.textContent = text;
      return;
    }
    bar.style.width = '0';
    go.innerHTML = state === 'done' ? DONE_ICON : state === 'failed' ? '!' : DOWNLOAD_ICON;
    detail.textContent = text || row.dataset.detail;
  }

  async function saveRow(row, variant) {
    if (row.dataset.state === 'busy') return false;
    setRow(row, 'busy', 'Downloading…', -1);
    try {
      const out = await web.save(variant, (fraction, bytes) => setRow(row, 'busy', `Downloading… ${formatBytes(bytes)}`, fraction));
      setRow(row, 'done', out.opened ? 'Opened in a new tab: save it from there' : `Saved to your Downloads · ${formatBytes(out.size)}`);
      return true;
    } catch (err) {
      setRow(row, 'failed', (err && err.userMessage) || 'The download failed. Try again.');
      return false;
    }
  }

  function variantRow(variant, { best }) {
    const detail = variant.detail || '';
    const row = el(
      'button',
      { class: 'web-row', type: 'button', 'data-detail': detail, title: `Download ${variant.label}` },
      el('span', { class: 'text' }, el('span', { class: 'label' }, variant.label), el('span', { class: 'detail' }, detail)),
      best ? el('span', { class: 'badge' }, 'Best') : null,
      el('span', { class: 'go', 'aria-hidden': 'true' }),
      el('span', { class: 'bar', 'aria-hidden': 'true' }),
    );
    row.querySelector('.go').innerHTML = DOWNLOAD_ICON;
    row.addEventListener('click', () => saveRow(row, variant));
    return row;
  }

  function renderWeb(res) {
    if (res.error) {
      webBox.replaceChildren(el('p', { class: 'tool-error', role: 'alert' }, res.error));
      return;
    }
    const head = el(
      'div',
      { class: 'web-head' },
      res.thumbnail ? el('img', { class: 'web-thumb', src: res.thumbnail, alt: '', width: 88, height: 58, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
      el('div', { class: 'web-titles' }, el('p', { class: 'web-site' }, res.site), el('h2', { class: 'web-title' }, res.title)),
    );
    const img = head.querySelector('img');
    if (img) img.addEventListener('error', () => img.remove());
    const nodes = [head];
    const firstRows = [];
    const many = res.items.length > 1;
    if (many) {
      const all = el('button', { class: 'btn btn-primary btn-md web-all', type: 'button' }, `Download all ${res.items.length}`);
      all.addEventListener('click', async () => {
        all.disabled = true;
        // One after another: the browser may ask once to allow several downloads.
        for (const [row, variant] of firstRows) await saveRow(row, variant);
        all.disabled = false;
      });
      nodes.push(all);
    }
    for (const item of res.items) {
      const group = el('div', { class: 'web-item' });
      if (many || item.variants.length > 1) group.append(el('h3', { class: 'web-item-label' }, item.label));
      item.variants.forEach((variant, i) => {
        const row = variantRow(variant, { best: i === 0 && item.variants.length > 1 });
        if (i === 0) firstRows.push([row, variant]);
        group.append(row);
      });
      nodes.push(group);
    }
    webBox.replaceChildren(...nodes);
  }

  const noExtTitle = $('[data-noext-title]');
  const noExtText = $('[data-noext-text]');

  /** "the video", "the full song", "this post"… → the extension card's words. */
  function explainNeeds(res) {
    const site = res.site || 'That site';
    if (res.items && res.items.length) {
      noExtTitle.textContent = `To get ${res.needs}, add the free extension`;
      noExtText.textContent = `${site} doesn’t let other websites fetch ${res.needs}, so this page can’t without sending it through a server. The Just download it extension gets it inside your browser, with nothing uploaded.`;
    } else {
      noExtTitle.textContent = 'Downloading this needs the free extension';
      noExtText.textContent = `${site} doesn’t let other websites fetch ${res.needs}, so no website can download it without sending it through a server. The Just download it extension gets it inside your browser, on your computer, with nothing uploaded.`;
    }
    states.noExtension.classList.toggle('after-web', !!(res.items && res.items.length));
  }

  async function showOnWeb(link) {
    states.web.hidden = false;
    webBox.replaceChildren(el('p', { class: 'web-state', role: 'status' }, el('span', { class: 'web-spinner', 'aria-hidden': 'true' }), 'Looking it up…'));
    let res;
    try {
      web = web || (await import('./web-download.js'));
      res = await web.resolveOnWeb(link.url);
    } catch (err) {
      res = { error: (err && err.userMessage) || 'Couldn’t look that up. Check the link and try again.' };
    }
    if (current !== link) return;
    if (!res.error && !(res.items && res.items.length)) states.web.hidden = true;
    else renderWeb(res);
    states.noExtension.hidden = !res.needs;
    if (res.needs) explainNeeds(res);
    states.capture.hidden = !!res.complete;
  }

  // ---------------------------------------------------------------------------
  // A link
  // ---------------------------------------------------------------------------

  /** Show what can be done with a link. `auto`: it came in the address, so start right away. */
  async function show(link, { auto }) {
    current = link;
    summary.hidden = false;
    $('[data-link-site]').textContent = link.site || link.host;
    $('[data-link-url]').textContent = link.url.replace(/^https?:\/\/(www\.)?/, '');
    $('[data-link-url]').title = link.url;
    $('[data-capture-link]').href = `capture.html?url=${encodeURIComponent(link.url)}`;
    for (const state of Object.values(states)) state.hidden = true;

    const hasExtension = await waitForExtension(auto ? 800 : 300);
    if (current !== link) return;
    if (!hasExtension) return showOnWeb(link);

    states.extension.hidden = false;
    states.capture.hidden = false;
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
    if (!link) return showError('That doesn’t look like a link. Paste the whole address, like https://x.com/…/status/…');
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
