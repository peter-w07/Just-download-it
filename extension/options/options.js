/*
 * Just download it: settings page.
 *
 * Each control is tied to one key of DEFAULT_SETTINGS (shared/util.js):
 *   switches    <input type="checkbox" id="<key>">
 *   choices     radio groups <input type="radio" name="<key>">
 *   folder      text, saved a moment after you stop typing
 *   crossfade   range, shown while dragging and saved when you let go
 *
 * A change saves only the keys it touched, after util.cleanSettings has checked
 * them, so this page can never store a value the rest of the extension doesn't
 * understand. A bad value already in storage shows up here as its default.
 *
 * Settings can also change elsewhere (another copy of this page, Chrome sync),
 * so the page follows chrome.storage.onChanged, except for keys it is still
 * writing itself: their echoes could otherwise undo a newer edit.
 *
 * The example paths use the same helpers the service worker names files with
 * (buildDownloadPath, songBaseName, trackPrefix), so they match what lands in
 * Downloads.
 *
 * When the extension doesn't have its host permissions (Firefox lets people
 * install it without them), a card at the top asks for them.
 */
(() => {
  'use strict';

  const { DEFAULT_SETTINGS, SITE_ACCESS, BROWSER_NAME, cleanSettings, sanitizeSegment, buildDownloadPath, songBaseName, trackPrefix } = globalThis.JDI.util;
  const $ = (id) => document.getElementById(id);

  // The page is written for Chrome; name the browser it's actually in.
  for (const el of document.querySelectorAll('[data-browser]')) el.textContent = BROWSER_NAME;

  const SWITCHES = ['perSiteFolders', 'saveAs', 'skipPicker', 'pageButtons', 'embedTags', 'numberTracks', 'collectionFolders', 'mixNormalize', 'instagramApi'];
  const CHOICES = ['songFilename', 'audioFormat', 'mp3Bitrate', 'mixFormat'];
  const FOLDER_MAX = 60;
  const TYPING_DELAY_MS = 400;
  const CROSSFADE_MAX = 12;

  const folderInput = $('folder');
  const crossfade = $('mixCrossfade');
  const statusEl = $('status');
  const resetDialog = $('resetDialog');

  /** What the page shows, and believes is stored. Always clean. */
  let current = cleanSettings({});
  /** key -> writes still in flight. */
  const writing = new Map();
  let typingTimer = 0;

  const radios = (key) => Array.from(document.querySelectorAll(`input[type="radio"][name="${key}"]`));

  // ---------------------------------------------------------------------------
  // Examples (pure)
  // ---------------------------------------------------------------------------

  const EXAMPLE_PHOTO = { site: 'Instagram', base: 'username_2026-09-17_DdRzldIALvw', ext: 'jpg' };
  const EXAMPLE_SONG = { title: 'Blinding Lights', artist: 'The Weeknd' };
  const EXAMPLE_ALBUM = { site: 'Spotify', name: 'After Hours', total: 14, first: { title: 'Alone Again', artist: 'The Weeknd' } };

  /** Paths inside Downloads for each example, named the way the service worker names them. */
  function examplePaths(s) {
    const site = (name) => (s.perSiteFolders ? name : '');
    const numbered = s.numberTracks ? trackPrefix(1, EXAMPLE_ALBUM.total) : '';
    return {
      download: buildDownloadPath({ folder: s.folder, site: site(EXAMPLE_PHOTO.site), base: EXAMPLE_PHOTO.base, ext: EXAMPLE_PHOTO.ext }),
      song: buildDownloadPath({ folder: s.folder, site: site(EXAMPLE_ALBUM.site), base: songBaseName(EXAMPLE_SONG, s.songFilename), ext: s.audioFormat }),
      album: buildDownloadPath({
        folder: s.folder,
        site: site(EXAMPLE_ALBUM.site),
        subfolder: s.collectionFolders ? EXAMPLE_ALBUM.name : '',
        base: `${numbered}${songBaseName(EXAMPLE_ALBUM.first, s.songFilename)}`,
        ext: s.audioFormat,
      }),
      mix: buildDownloadPath({ folder: s.folder, site: site(EXAMPLE_ALBUM.site), base: `${EXAMPLE_ALBUM.name} (mix)`, ext: s.mixFormat }),
    };
  }

  /** "MP3 · 6 s crossfade · even volume", like the Combine into one mix menu item. */
  function mixSummary(s) {
    return [
      s.mixFormat.toUpperCase(),
      s.mixCrossfade ? `${s.mixCrossfade} s crossfade` : 'no crossfade',
      s.mixNormalize ? 'even volume' : 'original volume',
    ].join(' · ');
  }

  /**
   * The two songs' volume as SVG paths (viewBox 320 × 34): song 1 fades out
   * while song 2 fades in, overlapping by up to 140 units at 12 seconds.
   */
  function fadeShapes(seconds) {
    const half = ((Math.min(CROSSFADE_MAX, Math.max(0, seconds)) / CROSSFADE_MAX) * 140) / 2;
    const start = 160 - half;
    const end = 160 + half;
    return {
      a: `M0 2H${start}L${end} 32H0Z`,
      b: `M${start} 32L${end} 2H320V32Z`,
    };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /** Show "Downloads/…" with folders muted and the file name stressed. Flashes when it changes. */
  function renderPath(el, path) {
    const text = `Downloads/${path}`;
    if (el.dataset.path === text) return;
    const changed = el.dataset.path !== undefined;
    el.dataset.path = text;
    const parts = text.split('/');
    const nodes = [];
    parts.forEach((part, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '/';
        nodes.push(sep);
      }
      const span = document.createElement('span');
      span.className = i === parts.length - 1 ? 'file' : 'dir';
      span.textContent = part;
      nodes.push(span);
    });
    el.replaceChildren(...nodes);
    if (changed) {
      el.classList.remove('changed');
      void el.offsetWidth; // restart the animation
      el.classList.add('changed');
    }
  }

  function renderCrossfade(seconds) {
    $('mixCrossfadeValue').textContent = seconds ? `${seconds} s` : 'Off';
    crossfade.setAttribute('aria-valuetext', seconds ? `${seconds} second${seconds === 1 ? '' : 's'}` : 'Off, songs play back to back');
    crossfade.style.setProperty('--fill', `calc(9px + (100% - 18px) * ${seconds / CROSSFADE_MAX})`);
    const shapes = fadeShapes(seconds);
    for (const [id, d] of [['fadeA', shapes.a], ['fadeB', shapes.b]]) {
      const path = $(id);
      path.setAttribute('d', d);
      path.style.d = `path("${d}")`; // animates where CSS d is supported
    }
  }

  /** Everything that follows from the settings: examples, summaries, the fade picture. */
  function renderDerived(s) {
    const paths = examplePaths(s);
    renderPath($('downloadExample'), paths.download);
    renderPath($('songExample'), paths.song);
    renderPath($('albumExample'), paths.album);
    renderPath($('mixExample'), paths.mix);
    $('mixSummary').textContent = mixSummary(s);
    renderCrossfade(s.mixCrossfade);
  }

  /** Put settings into the controls. keepFolder leaves the text field alone while it's being typed in. */
  function render(s, { keepFolder = false } = {}) {
    if (!keepFolder) folderInput.value = s.folder;
    for (const key of SWITCHES) $(key).checked = s[key];
    for (const key of CHOICES) {
      for (const radio of radios(key)) radio.checked = radio.value === String(s[key]);
    }
    crossfade.value = String(s.mixCrossfade);
    renderDerived(keepFolder ? readForm() : s);
  }

  /** The settings the controls show right now, cleaned. */
  function readForm() {
    const raw = { ...current, folder: sanitizeSegment(folderInput.value, FOLDER_MAX), mixCrossfade: crossfade.value };
    for (const key of SWITCHES) raw[key] = $(key).checked;
    for (const key of CHOICES) {
      const on = radios(key).find((radio) => radio.checked);
      if (on) raw[key] = on.value;
    }
    return cleanSettings(raw);
  }

  // ---------------------------------------------------------------------------
  // "Saved"
  // ---------------------------------------------------------------------------

  let statusTimer = 0;
  let statusClearTimer = 0;

  function showStatus(text, kind = 'ok') {
    clearTimeout(statusTimer);
    clearTimeout(statusClearTimer);
    statusEl.textContent = text;
    statusEl.className = `status show ${kind}`;
    statusTimer = setTimeout(() => {
      statusEl.classList.remove('show');
      statusClearTimer = setTimeout(() => {
        statusEl.textContent = '';
      }, 200);
    }, kind === 'error' ? 6000 : 1500);
  }

  // ---------------------------------------------------------------------------
  // Load and save
  // ---------------------------------------------------------------------------

  const folderBusy = () => document.activeElement === folderInput;

  async function load() {
    let stored = {};
    try {
      stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    } catch {
      /* show the defaults */
    }
    current = cleanSettings(stored);
    render(current, { keepFolder: folderBusy() });
  }

  async function write(patch, message) {
    const keys = Object.keys(patch);
    current = cleanSettings({ ...current, ...patch });
    // Snap every control to what is being stored (a value that didn't pass the checks shows its default).
    render(current, { keepFolder: folderBusy() });
    for (const key of keys) writing.set(key, (writing.get(key) || 0) + 1);
    try {
      await chrome.storage.sync.set(patch);
      showStatus(message);
    } catch (error) {
      showStatus(`Couldn’t save: ${(error && error.message) || error}`, 'error');
      await load();
    } finally {
      for (const key of keys) {
        const left = (writing.get(key) || 1) - 1;
        if (left > 0) writing.set(key, left);
        else writing.delete(key);
      }
    }
  }

  function save(keys) {
    const next = readForm();
    const patch = {};
    for (const key of keys) patch[key] = next[key];
    return write(patch, 'Saved');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  folderInput.addEventListener('input', () => {
    renderDerived(readForm());
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingTimer = 0;
      save(['folder']);
    }, TYPING_DELAY_MS);
  });
  folderInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') folderInput.blur();
  });
  folderInput.addEventListener('blur', () => {
    folderInput.value = sanitizeSegment(folderInput.value, FOLDER_MAX);
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = 0;
      save(['folder']);
    }
  });

  for (const key of SWITCHES) $(key).addEventListener('change', () => save([key]));

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === 'radio' && CHOICES.includes(target.name)) save([target.name]);
  });

  crossfade.addEventListener('input', () => renderDerived(readForm()));
  crossfade.addEventListener('change', () => save(['mixCrossfade']));

  $('reset').addEventListener('click', () => {
    resetDialog.returnValue = ''; // Esc keeps the previous value otherwise
    resetDialog.showModal();
  });
  resetDialog.addEventListener('close', () => {
    if (resetDialog.returnValue !== 'reset') return;
    clearTimeout(typingTimer);
    typingTimer = 0;
    write({ ...DEFAULT_SETTINGS }, 'Settings are back to the defaults');
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const patch = {};
      for (const [key, change] of Object.entries(changes)) {
        if (!Object.hasOwn(DEFAULT_SETTINGS, key) || writing.has(key)) continue;
        patch[key] = change.newValue === undefined ? DEFAULT_SETTINGS[key] : change.newValue;
      }
      if (!Object.keys(patch).length) return;
      current = cleanSettings({ ...current, ...patch });
      render(current, { keepFolder: folderBusy() });
    });
  } catch {
    /* not running as an extension page */
  }

  // ---------------------------------------------------------------------------
  // Access to websites
  // ---------------------------------------------------------------------------

  async function checkAccess() {
    let granted = true;
    try {
      granted = await chrome.permissions.contains(SITE_ACCESS);
    } catch {
      /* not running as an extension page */
    }
    $('access').hidden = granted;
  }

  // permissions.request only works straight from a click (no await before it).
  $('grantAccess').addEventListener('click', () => {
    chrome.permissions
      .request(SITE_ACCESS)
      .then((granted) => {
        if (granted) $('access').hidden = true;
        else showStatus('Access wasn’t allowed. Just download it can’t work on websites without it.', 'error');
      })
      .catch((error) => showStatus(`Couldn’t ask for access: ${(error && error.message) || error}`, 'error'));
  });
  try {
    chrome.permissions.onAdded.addListener(checkAccess);
    chrome.permissions.onRemoved.addListener(checkAccess);
  } catch {
    /* not running as an extension page */
  }
  checkAccess();

  // ---------------------------------------------------------------------------
  // Section links: mark the section you're reading
  // ---------------------------------------------------------------------------

  const tocLinks = Array.from(document.querySelectorAll('.toc a'));
  const sections = tocLinks.map((a) => $(a.hash.slice(1))).filter(Boolean);
  let spyFrame = 0;

  function spy() {
    spyFrame = 0;
    const doc = document.documentElement;
    const atBottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
    let currentId = sections.length ? sections[0].id : '';
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 96) currentId = section.id;
    }
    if (atBottom && sections.length) currentId = sections[sections.length - 1].id;
    for (const a of tocLinks) {
      if (a.hash.slice(1) === currentId) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  }
  window.addEventListener(
    'scroll',
    () => {
      if (!spyFrame) spyFrame = requestAnimationFrame(spy);
    },
    { passive: true },
  );
  spy();

  load();
})();
