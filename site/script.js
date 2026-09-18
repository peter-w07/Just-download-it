// Just download it: homepage. Small progressive enhancements; the page works without them.
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Store and code links: the one place to change them.
  //
  // CHROME_STORE_URL  Empty while the Chrome Web Store reviews the extension. Once it's
  //                   approved, paste the listing's address here, for example
  //                   'https://chromewebstore.google.com/detail/just-download-it/abcdefghijklmnopabcdefghijklmnop'.
  //                   While it's empty, every "Add to Chrome" button shows "In review, coming soon"
  //                   and isn't a link.
  // FIREFOX_URL       The Firefox Add-ons listing. It only works after Mozilla's review, so
  // FIREFOX_LIVE      the "Add to Firefox" buttons stay "In review" until you set this to true.
  // GITHUB_URL        The source code. Links marked data-link="github" (and "license") in
  //                   index.html use it; their href in the HTML is the fallback without JS.
  //
  // The "In review" note under the buttons hides itself once both stores are live.
  // ---------------------------------------------------------------------------
  const LINKS = {
    CHROME_STORE_URL: '',
    FIREFOX_URL: 'https://addons.mozilla.org/firefox/addon/just-download-it/',
    FIREFOX_LIVE: false,
    GITHUB_URL: 'https://github.com/peter-w07/Just-download-it',
  };

  const stores = {
    chrome: {
      url: LINKS.CHROME_STORE_URL,
      live: Boolean(LINKS.CHROME_STORE_URL),
      name: 'Chrome Web Store',
    },
    firefox: {
      url: LINKS.FIREFOX_URL,
      live: Boolean(LINKS.FIREFOX_LIVE && LINKS.FIREFOX_URL),
      name: 'Firefox Add-ons',
    },
  };

  // Store buttons: a link to the listing when it's live, a quiet "In review" placeholder otherwise.
  document.querySelectorAll('[data-store]').forEach((button) => {
    const store = stores[button.getAttribute('data-store')];
    if (!store) return;
    const meta = button.querySelector('.store-meta');
    if (store.live) {
      button.setAttribute('href', store.url);
      button.classList.remove('is-review');
      if (meta) meta.textContent = store.name;
    } else {
      button.removeAttribute('href');
      button.classList.add('is-review');
      if (meta) meta.textContent = 'In review, coming soon';
    }
  });

  // The "listings are in review" note: say which one, or hide it once both are live.
  const inReview = Object.values(stores).filter((store) => !store.live);
  document.querySelectorAll('[data-review-note]').forEach((note) => {
    if (inReview.length === 0) {
      note.hidden = true;
      return;
    }
    const text = note.querySelector('[data-review-text]');
    if (text) {
      text.textContent = inReview.length === 1
        ? `The ${inReview[0].name} listing is in review right now.`
        : 'Both store listings are in review right now.';
    }
  });

  // Code links.
  document.querySelectorAll('[data-link="github"]').forEach((link) => {
    link.setAttribute('href', LINKS.GITHUB_URL);
  });
  document.querySelectorAll('[data-link="license"]').forEach((link) => {
    link.setAttribute('href', `${LINKS.GITHUB_URL}/blob/main/LICENSE`);
  });

  // "Install from source" is folded away: open it when something links to it.
  const source = document.getElementById('install-source');
  if (source) {
    const openIfTargeted = () => {
      if (window.location.hash === '#install-source') source.open = true;
    };
    openIfTargeted();
    window.addEventListener('hashchange', openIfTargeted);
    document.querySelectorAll('a[href="#install-source"]').forEach((link) => {
      link.addEventListener('click', () => { source.open = true; });
    });
  }

  // A hairline under the header once the page has scrolled.
  const header = document.querySelector('.site-header');
  if (header) {
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // Copy buttons (chrome:// and about: pages can't be opened by a link, so offer to copy them).
  const status = document.getElementById('copy-status');
  document.querySelectorAll('[data-copy]').forEach((button) => {
    const label = button.querySelector('.copy-label');
    let timer = 0;
    button.addEventListener('click', async () => {
      const text = button.getAttribute('data-copy');
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        // Fallback: select the text so it can be copied by hand.
        const code = button.parentElement && button.parentElement.querySelector('code');
        if (code) {
          const range = document.createRange();
          range.selectNodeContents(code);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      if (label) label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      if (status) status.textContent = ok ? `Copied ${text}` : 'Selected. Press Ctrl+C to copy.';
      button.classList.toggle('is-copied', ok);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (label) label.textContent = 'Copy';
        button.classList.remove('is-copied');
      }, 2000);
    });
  });

  // Keep the copyright year current.
  document.querySelectorAll('[data-year]').forEach((el) => {
    el.textContent = String(new Date().getFullYear());
  });
})();
