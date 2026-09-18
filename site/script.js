// Just download it: homepage. Small progressive enhancements; the page works without them.
(() => {
  'use strict';

  // A hairline under the header once the page has scrolled.
  const header = document.querySelector('.site-header');
  if (header) {
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // Copy buttons ("chrome://extensions" can't be opened by a link, so offer to copy it).
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
      if (status) status.textContent = ok ? 'Copied chrome://extensions' : 'Selected. Press Ctrl+C to copy.';
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
