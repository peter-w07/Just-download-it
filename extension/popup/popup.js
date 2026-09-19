/*
 * Just download it: toolbar popup.
 *
 * Paste a link (or use the current tab) → the service worker resolves it,
 * directly for sites with public APIs or in a muted background tab otherwise →
 * pick what to save → the service worker downloads it and reports progress
 * here and on the toolbar badge, so the popup can be closed at any time.
 * The popup also starts "Save this web page" (PNG / GIF) on the current tab.
 * The extension's website can hand it a link too (content/site-bridge.js): the
 * service worker leaves it in session storage and opens the popup, or opens
 * this page in a small window of its own (?window=1) where it can't.
 *
 * Access to websites: Firefox lets people install an extension without its
 * host permissions (or take them back later), and Chrome's site access can be
 * limited too. Without them nothing works (no page buttons, no link lookups),
 * so the popup says so and asks for them with one click.
 */
const { util } = globalThis.JDI;

const $ = (id) => document.getElementById(id);
const form = $('form');
const input = $('link');
const go = $('go');
const thisTab = $('this-tab');
const result = $('result');
const downloads = $('downloads');
const captureError = $('capture-error');
const access = $('access');

// While this port is open the service worker keeps background tabs it opened
// for us; when the popup closes it closes the ones nothing is downloading from.
chrome.runtime.connect({ name: 'jdi-popup' });

const LAST_KEY = 'popupLast';
const PENDING_KEY = 'popupPending'; // a link from the website, waiting to be looked up
const PENDING_MS = 60 * 1000;
// In a window of its own there's no "current tab" to save as a PNG or GIF.
const OWN_WINDOW = new URLSearchParams(location.search).has('window');
const BUNDLES_KEY = 'popupBundles';
const REMEMBER_MS = 30 * 60 * 1000;

let current = null; // { url, resolution, tabId }
let lookup = 0;
let batchCounter = 0;
const rowsByBatch = new Map(); // batch -> row elements waiting for a result
const statuses = new Map(); // batch -> { batch, text, kind, final, percent, time }
const bundles = new Map(); // batch -> { type: 'zip' | 'mix', count }, for friendlier progress text

// Settings decide which song format is listed first and what the mix will be.
let settings = util.cleanSettings({});
const settingsReady = chrome.storage.sync
  .get(util.DEFAULT_SETTINGS)
  .then((stored) => {
    settings = util.cleanSettings(stored);
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  download: ['M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5', 'M5 19.5h14'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  error: ['M12 7.5v6', 'M12 16.8v.2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'],
  chevron: ['m9 6 6 6-6 6'],
  zip: ['M4 8 6 4.5h12L20 8', 'M4 8h16v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z', 'M10 12h4'],
  mix: ['M4 11v2', 'M8 8v8', 'M12 5v14', 'M16 8v8', 'M20 11v2'],
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  ],
};

function icon(name, size = 16) {
  if (name === 'spinner') return el('span', { class: 'spinner', 'aria-hidden': 'true' });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  if (name === 'chevron') svg.classList.add('chevron');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  return svg;
}

function image(src, className) {
  const img = el('img', { class: className, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  if (/^https:/i.test(String(src || ''))) img.src = src;
  img.addEventListener('error', () => img.removeAttribute('src'));
  return img;
}

// ---------------------------------------------------------------------------
// Looking up a link
// ---------------------------------------------------------------------------

function showState(text, { error = false } = {}) {
  result.replaceChildren(el('div', { class: `state${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, error ? icon('error') : icon('spinner'), el('span', {}, text)));
}

function forgetTab() {
  if (current && current.tabId != null) {
    chrome.runtime.sendMessage({ type: 'jdi:popup-forget-tab', tabId: current.tabId }).catch(() => {});
  }
}

async function lookUp(url, { tabId = null } = {}) {
  const id = ++lookup;
  forgetTab();
  current = null;
  showState(tabId != null ? 'Looking at this page…' : 'Looking up the link…');
  const slow = setTimeout(() => {
    if (id === lookup) showState('Still looking… some sites take a few seconds to open.');
  }, 3000);
  go.disabled = true;
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'jdi:resolve-link', url, tabId });
  } catch {
    res = { ok: false, error: 'Couldn’t reach Just download it. Try again.' };
  }
  clearTimeout(slow);
  await settingsReady;
  if (id !== lookup) return;
  go.disabled = false;
  if (res && res.needsAccess) access.hidden = false;
  if (!res || !res.ok || !res.resolution || !Array.isArray(res.resolution.items) || !res.resolution.items.length) {
    showState((res && res.error) || 'Couldn’t find anything to download at that link.', { error: true });
    return;
  }
  current = { url, resolution: util.preferAudioFormat(res.resolution, settings.audioFormat), tabId: Number.isInteger(res.tabId) ? res.tabId : null };
  remember();
  render();
}

function remember() {
  const value = { url: current.url, time: Date.now(), resolution: current.tabId == null ? current.resolution : null };
  chrome.storage.session.set({ [LAST_KEY]: value }).catch(() => {});
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) {
    input.focus();
    return;
  }
  lookUp(url);
});

// Pasting a link is the whole point: look it up straight away.
input.addEventListener('paste', () => {
  setTimeout(() => {
    if (/https?:\/\/\S+|^\s*(www\.\S+|spotify:\w+:\w+)/i.test(input.value)) form.requestSubmit();
  }, 0);
});

// ---------------------------------------------------------------------------
// Showing what can be saved
// ---------------------------------------------------------------------------

function sizeText(variant) {
  return variant.size ? util.formatBytes(variant.size) : '';
}

function variantRow(item, variant, { best }) {
  const row = el(
    'button',
    { class: 'row', type: 'button', title: variant.hint ? String(variant.hint) : `Download ${variant.label}` },
    el('span', { class: 'text' }, el('div', { class: 'label' }, variant.label), el('div', { class: 'detail' }, [variant.detail, sizeText(variant)].filter(Boolean).join(' · '))),
    best ? el('span', { class: 'badge' }, 'Best') : null,
    el('span', { class: 'go' }, icon('download')),
  );
  row.addEventListener('click', () => download([variant], [row]));
  return row;
}

function variantList(item, { focused }) {
  const nodes = [];
  let group = null;
  item.variants.forEach((variant, i) => {
    const heading = variant.group || null;
    if (heading && heading !== group) nodes.push(el('div', { class: 'section' }, heading));
    group = heading;
    nodes.push(variantRow(item, variant, { best: focused && i === 0 }));
  });
  return nodes;
}

function render() {
  const { resolution } = current;
  const items = resolution.items;
  const focus = Math.min(Math.max(Number(resolution.focus) || 0, 0), items.length - 1);
  let host = '';
  try {
    host = new URL(current.url.includes('://') ? current.url : `https://${current.url}`).hostname.replace(/^www\./, '');
  } catch {
    /* shown without a host */
  }

  const head = el(
    'div',
    { class: 'head' },
    image(items[focus].thumbnail || (items[focus].variants.find((v) => v.kind === 'image') || {}).url, 'thumb'),
    el('div', { class: 'titles' }, el('div', { class: 'site' }, resolution.site || host), el('div', { class: 'title', title: resolution.title || '' }, resolution.title || 'Download')),
  );
  const nodes = [head];
  if (resolution.notice) nodes.push(el('div', { class: 'notice' }, resolution.notice));

  const list = el('div', { class: 'list' });
  if (items.length === 1) {
    list.append(...variantList(items[0], { focused: true }));
  } else {
    nodes.push(downloadAll(resolution));
    items.forEach((item, index) => {
      const expanded = index === focus;
      const box = el('div', { class: 'item-variants', hidden: !expanded });
      const first = item.variants[0];
      const toggle = el(
        'button',
        { class: 'row', type: 'button', 'aria-expanded': String(expanded) },
        image(item.thumbnail || (first.kind === 'image' ? first.url : ''), 'mini'),
        el('span', { class: 'text' }, el('div', { class: 'label' }, item.label || `Item ${index + 1}`), el('div', { class: 'detail' }, `${first.label}${item.variants.length > 1 ? ` + ${item.variants.length - 1} more` : ''}`)),
        el('span', { class: 'go' }, icon('chevron')),
      );
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(open));
        if (open && !box.childElementCount) box.append(...variantList(item, { focused: false }));
        box.hidden = !open;
      });
      if (expanded) box.append(...variantList(item, { focused: true }));
      list.append(toggle, box);
    });
  }
  nodes.push(list);
  result.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------------
// Download all: a split button with a menu (ZIP, one mix, Settings)
// ---------------------------------------------------------------------------

/** "MP3 · 6 s crossfade · even volume", from the mix settings. */
function mixSummary() {
  const fade = Math.round(Number(settings.mixCrossfade) || 0);
  return [
    settings.mixFormat === 'm4a' ? 'M4A' : 'MP3',
    fade > 0 ? `${fade} s crossfade` : 'no crossfade',
    settings.mixNormalize ? 'even volume' : 'original volume',
  ].join(' · ');
}

function isSong(variant) {
  return !!(variant && variant.job && (variant.job.type === 'song' || (variant.job.tags && variant.job.tags.title)));
}

/**
 * "Download all N" saves every item's first choice as its own file; the right
 * arrow next to it opens a menu to get them as one ZIP or one mix instead.
 * Arrow keys move through the menu, Enter picks, Escape closes it.
 */
function downloadAll(resolution) {
  const { items } = resolution;
  const firsts = items.map((item) => item.variants[0]);
  const firstLabels = new Set(firsts.map((v) => v.label));
  const label = `Download all ${items.length}${firstLabels.size === 1 ? ` as ${firsts[0].label}` : ''}`;
  const collection = util.collectionOf(resolution);

  const main = el('button', { class: 'primary all', type: 'button', title: 'Save each one as its own file' }, label);
  const more = el(
    'button',
    { class: 'primary more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More ways to download all', title: 'More ways to download all' },
    icon('chevron'),
  );
  const menu = el('div', { class: 'menu', role: 'menu', 'aria-label': 'Download all', hidden: true });
  const split = el('div', { class: 'split' }, main, more, menu);
  const box = el('div', { class: 'split-box' }, split);

  const menuItems = [];
  const addItem = (iconName, text, detail, onPick) => {
    const item = el(
      'button',
      { class: 'menu-item', type: 'button', role: 'menuitem', tabindex: '-1', title: detail || null },
      el('span', { class: 'icon' }, icon(iconName)),
      el('span', { class: 'text' }, el('div', { class: 'label' }, text), detail ? el('div', { class: 'detail' }, detail) : null),
    );
    item.addEventListener('click', onPick);
    menuItems.push(item);
    menu.append(item);
  };

  // A ZIP is made by the extension, so it can't hold files only the site's own page may fetch.
  const zippable = !firsts.some((v) => v.via === 'page' && !v.job);
  if (zippable) {
    const songs = firsts.every(isSong);
    const formats = new Set(firsts.map((v) => String(util.normalizeExt(v.ext) || '').toUpperCase()));
    const format = formats.size === 1 && !formats.has('') ? ` as ${Array.from(formats)[0]}` : '';
    addItem('zip', 'Download as ZIP', songs ? `${items.length} songs${format} in one file` : `All ${items.length} in one file`, () => {
      closeMenu(false);
      download([util.bundleVariant(resolution, 'zip', settings)], [box], { collection, bundle: { type: 'zip', count: items.length } });
    });
  }
  if (util.canMix(resolution)) {
    addItem('mix', 'Combine into one mix', mixSummary(), () => {
      closeMenu(false);
      download([util.bundleVariant(resolution, 'mix', settings)], [box], { collection, bundle: { type: 'mix', count: items.length } });
    });
  }
  if (menuItems.length) menu.append(el('div', { class: 'menu-sep', role: 'separator' }));
  addItem('gear', 'Settings…', '', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  let index = 0;
  const focusItem = (i) => {
    index = ((i % menuItems.length) + menuItems.length) % menuItems.length;
    menuItems[index].focus();
  };
  menuItems.forEach((item, i) => item.addEventListener('focus', () => (index = i)));

  function openMenu(focusIndex = 0) {
    if (!menu.hidden || more.disabled) return;
    menu.hidden = false;
    more.setAttribute('aria-expanded', 'true');
    focusItem(focusIndex);
    document.addEventListener('pointerdown', onOutside, true);
  }

  function closeMenu(focusMore) {
    if (menu.hidden) return;
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (focusMore) more.focus();
  }

  function onOutside(event) {
    if (!split.contains(event.target)) closeMenu(false);
  }

  main.addEventListener('click', () =>
    download(
      items.map((item, i) => ({ ...item.variants[0], position: i + 1 })),
      [box],
      { collection },
    ),
  );
  main.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      more.focus();
    }
  });
  more.addEventListener('click', () => (menu.hidden ? openMenu(0) : closeMenu(true)));
  more.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(event.key === 'ArrowUp' ? -1 : 0);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      closeMenu(false);
      main.focus();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, PageUp: 0, End: -1, PageDown: -1 };
    if (event.key in moves) {
      event.preventDefault();
      focusItem(moves[event.key]);
    } else if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Tab') {
      // Escape would otherwise close the whole popup.
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  });

  return box;
}

/** "Preparing your ZIP… 42%", "Mixing 12 songs… 42%" for a batch this popup started as one ZIP or mix. */
function statusText(entry) {
  const bundle = bundles.get(entry.batch);
  if (!bundle || entry.final || entry.kind !== 'info') return entry.text;
  // Once the file is made, the service worker says "Downloading…" while Chrome saves it.
  if (/^(Downloading|Saving)/.test(entry.text)) return bundle.type === 'zip' ? 'Saving your ZIP…' : 'Saving your mix…';
  const percent = entry.percent > 0 ? ` ${entry.percent}%` : '';
  return bundle.type === 'zip' ? `Preparing your ZIP…${percent}` : `Mixing ${bundle.count} songs…${percent}`;
}

function rememberBundle(batch, bundle) {
  bundles.set(batch, bundle);
  while (bundles.size > 10) bundles.delete(bundles.keys().next().value);
  chrome.storage.session.set({ [BUNDLES_KEY]: Object.fromEntries(bundles) }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

function setRowState(row, state, message) {
  if (row.classList.contains('split-box')) {
    // Download all: both halves wait together; errors show under them.
    for (const button of row.querySelectorAll('.split > button')) button.disabled = state === 'busy';
    let error = row.querySelector('.split-error');
    if (state === 'failed' && message) {
      if (!error) row.append((error = el('p', { class: 'error split-error', role: 'alert' })));
      error.textContent = message;
    } else if (error) {
      error.remove();
    }
    return;
  }
  if (row.classList.contains('primary')) {
    row.disabled = state === 'busy';
    if (state === 'failed') row.textContent = 'Try again';
    return;
  }
  row.classList.remove('busy', 'done', 'failed');
  if (state) row.classList.add(state);
  const goIcon = row.querySelector('.go');
  if (goIcon) goIcon.replaceChildren(icon(state === 'busy' ? 'spinner' : state === 'done' ? 'check' : state === 'failed' ? 'error' : 'download'));
  if (state === 'failed' && message) {
    const detail = row.querySelector('.detail');
    if (detail) detail.textContent = message;
  }
}

/**
 * @param variants  what to save; "Download all" variants carry their position
 * @param rows      the buttons that show busy / done / failed
 * @param options.collection  { name, total } for Download all, a ZIP or a mix
 * @param options.bundle      { type: 'zip' | 'mix', count } for one ZIP or mix
 */
async function download(variants, rows, { collection = null, bundle = null } = {}) {
  if (!current) return;
  const batch = `p${Date.now().toString(36)}-${batchCounter++}`;
  rows.forEach((row) => setRowState(row, 'busy'));
  rowsByBatch.set(batch, rows);
  if (bundle) rememberBundle(batch, bundle);
  const clean = variants.map((v) => {
    const variant = { kind: v.kind, label: v.label, url: v.url, ext: v.ext, filename: v.filename, job: v.job, via: v.via, size: v.size };
    if (Number.isInteger(v.position) && v.position > 0) variant.position = v.position;
    return variant;
  });
  const message = { type: 'jdi:popup-download', site: current.resolution.site || '', variants: clean, tabId: current.tabId, batch };
  if (collection) message.collection = collection;
  let res;
  try {
    res = await chrome.runtime.sendMessage(message);
  } catch {
    res = { ok: false, error: 'Couldn’t reach Just download it. Try again.' };
  }
  if (!res || !res.ok) {
    rowsByBatch.delete(batch);
    // Refusals the service worker already listed under the downloads aren't repeated.
    const error = statuses.has(batch) ? '' : (res && res.error) || 'Download failed.';
    rows.forEach((row) => setRowState(row, 'failed', row.classList.contains('split-box') ? error : (res && res.error) || 'Download failed.'));
    if (res && /closed/i.test(String(res.error)) && current) current.tabId = null;
  }
}

function onStatus(entry) {
  statuses.set(entry.batch, entry);
  const rows = rowsByBatch.get(entry.batch);
  if (rows && entry.final) {
    rowsByBatch.delete(entry.batch);
    // Download all's own error line stays empty: the status below already says it.
    rows.forEach((row) => setRowState(row, entry.kind === 'error' ? 'failed' : 'done', entry.kind === 'error' && !row.classList.contains('split-box') ? entry.text : ''));
  }
  renderDownloads();
}

function renderDownloads() {
  const recent = Array.from(statuses.values())
    .filter((s) => !s.final || Date.now() - s.time < 10 * 60 * 1000)
    .sort((a, b) => b.time - a.time)
    .slice(0, 3);
  downloads.hidden = !recent.length;
  downloads.replaceChildren(
    ...recent.map((s) => {
      const text = el('div', { class: 'text' }, el('span', {}, statusText(s)));
      if (s.final && s.kind === 'success') {
        text.append(el('button', { class: 'linkish', type: 'button', onclick: () => chrome.downloads.showDefaultFolder() }, 'Show folder'));
      }
      const node = el('div', { class: `status ${s.kind}` }, text);
      if (!s.final) node.append(el('div', { class: 'bar' }, el('i', { style: `width: ${Math.max(3, s.percent)}%` })));
      return node;
    }),
  );
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || !message || message.type !== 'jdi:popup-status') return;
  onStatus(message);
});

// ---------------------------------------------------------------------------
// Access to websites
// ---------------------------------------------------------------------------

async function checkAccess() {
  if (!chrome.permissions) return;
  const granted = await chrome.permissions.contains(util.SITE_ACCESS).catch(() => true);
  access.hidden = granted;
}

// permissions.request only works straight from a click (no await before it).
$('grant-access').addEventListener('click', () => {
  chrome.permissions
    .request(util.SITE_ACCESS)
    .then((granted) => {
      if (granted) access.hidden = true;
    })
    .catch(() => {});
});
if (chrome.permissions) {
  chrome.permissions.onAdded.addListener(checkAccess);
  chrome.permissions.onRemoved.addListener(checkAccess);
}

// ---------------------------------------------------------------------------
// Save this web page
// ---------------------------------------------------------------------------

async function capture(mode) {
  captureError.hidden = true;
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'jdi:popup-capture', mode });
  } catch {
    res = { ok: false, error: 'Couldn’t reach Just download it. Try again.' };
  }
  if (res && res.ok) {
    window.close(); // the picker is on the page now
    return;
  }
  captureError.textContent = (res && res.error) || 'Couldn’t start the capture on this page.';
  captureError.hidden = false;
}

$('capture-png').addEventListener('click', () => capture('png'));
$('capture-gif').addEventListener('click', () => capture('gif'));
$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  checkAccess();
  if (OWN_WINDOW) document.querySelector('.capture').hidden = true;
  const [opened, stored, tabs] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'jdi:popup-open' }).catch(() => null),
    chrome.storage.session.get([LAST_KEY, BUNDLES_KEY, PENDING_KEY]).catch(() => ({})),
    chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
    settingsReady,
  ]);
  for (const [batch, bundle] of Object.entries((stored && stored[BUNDLES_KEY]) || {})) {
    if (bundle && (bundle.type === 'zip' || bundle.type === 'mix')) bundles.set(batch, { type: bundle.type, count: Number(bundle.count) || 0 });
  }
  for (const entry of (opened && opened.statuses) || []) statuses.set(entry.batch, entry);
  renderDownloads();

  const pending = stored && stored[PENDING_KEY];
  if (pending) chrome.storage.session.remove(PENDING_KEY).catch(() => {});
  if (pending && typeof pending.url === 'string' && Date.now() - pending.time < PENDING_MS) {
    input.value = pending.url;
    lookUp(pending.url);
  }

  const tab = OWN_WINDOW ? null : tabs[0];
  if (tab && /^https?:/i.test(tab.url || '')) {
    let host = '';
    try {
      host = new URL(tab.url).hostname.replace(/^www\./, '');
    } catch {
      /* no host */
    }
    thisTab.textContent = `Download from this tab · ${host}`;
    thisTab.title = tab.url;
    thisTab.hidden = false;
    thisTab.addEventListener('click', () => {
      input.value = tab.url;
      lookUp(tab.url, { tabId: tab.id });
    });
  }

  const last = stored && stored[LAST_KEY];
  if (last && Date.now() - last.time < REMEMBER_MS && !input.value) {
    input.value = last.url;
    if (last.resolution) {
      current = { url: last.url, resolution: util.preferAudioFormat(last.resolution, settings.audioFormat), tabId: null };
      render();
    }
    input.select();
  }
}

start();
