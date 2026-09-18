/*
 * Just download it: Download buttons on supported sites.
 *
 * Site handlers register an `install(api)` function; this file gives them:
 *  - api.create({ look, label, title, onClick, theme }): a button in its own
 *    closed shadow root, styled to match the site without depending on the
 *    site's (often renamed) CSS classes. Each `look` is one site's own button
 *    in one place (YouTube's action row, Twitch's player controls, ...), with
 *    the sizes, radii, colours and hover/press states measured on that site.
 *    `theme` is 'auto' (follow the page's light/dark), 'light', 'dark', or a
 *    function of the host element for sites that theme a page at a time.
 *  - api.onChange(fn): fn runs (at most once per frame) whenever the page's
 *    DOM changes or the site navigates without a page load, so buttons can be
 *    re-added after the site re-renders.
 *  - api.hoverVideos({ onClick, look, size, inset, gap, minWidth, minHeight }):
 *    a small Download button that floats over the top-right corner of whichever
 *    video the pointer is on. Used where a site's own controls change too often
 *    to attach to. `inset` is the distance from the video's edges and `gap`
 *    leaves room for the site's own corner control (TikTok's "...", say).
 *  - api.theme(): 'light' or 'dark' for the page, from the theme registry.
 *
 * Colours are taken from the site's own custom properties where it has them
 * (they inherit into shadow roots), with the measured value as the fallback,
 * so a button keeps up when the site switches theme on its own.
 *
 * Buttons can be turned off in settings ("pageButtons").
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});
  if (JDI.buttons && typeof JDI.buttons.teardown === 'function') {
    try {
      JDI.buttons.teardown();
    } catch {
      /* ignore */
    }
  }

  const TAG = 'jdi-button';
  const FLOAT_TAG = 'jdi-float';
  const THEME = Symbol('jdi-theme');
  const installers = [];
  let started = false;
  let enabled = true;
  let observer = null;
  let frame = 0;
  let cachedTheme = '';
  const listeners = [];
  const cleanups = [];

  const ICON_PATH = 'M12 4.5v10.25m0 0 4.25-4.25M12 14.75 7.75 10.5M5.5 19.5h13';

  // ---------------------------------------------------------------------------
  // Looks: one per site and placement, measured on the site itself
  // ---------------------------------------------------------------------------

  const LOOKS = {
    // YouTube watch page, in the row with Like, Share and Save. A 40px tonal
    // pill with YouTube's touch-response overlay while pressed. The
    // --yt-sys-color-baseline--* properties switch with html[dark] by
    // themselves; data-theme is only a safety net.
    'youtube-pill': {
      text: true,
      stroke: '1.9',
      css: `
        :host { display: inline-flex; flex: none; margin-right: 8px; vertical-align: middle; }
        button {
          position: relative; display: inline-flex; align-items: center; justify-content: center;
          height: 40px; padding: 0 16px; border: 0; border-radius: 20px; cursor: pointer; white-space: nowrap;
          font: 500 14px/40px "Roboto", "Arial", sans-serif; -webkit-font-smoothing: antialiased;
          color: var(--yt-sys-color-baseline--text-primary, #0f0f0f);
          background: var(--yt-sys-color-baseline--additive-background, rgba(0, 0, 0, .05));
        }
        button:hover { background: var(--yt-sys-color-baseline--mono-tonal-hover, rgba(0, 0, 0, .1)); }
        button::after {
          content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
          background: var(--yt-sys-color-baseline--touch-response, #000);
          opacity: 0; transition: opacity .3s cubic-bezier(.05, 0, 0, 1);
        }
        button:active::after { opacity: .1; }
        button:focus-visible { outline: none; background: transparent; box-shadow: inset 0 0 0 2px currentColor; }
        svg { width: 24px; height: 24px; flex: none; margin-right: 6px; }
        :host([data-theme="dark"]) button { color: #f1f1f1; background: rgba(255, 255, 255, .1); }
        :host([data-theme="dark"]) button:hover { background: rgba(255, 255, 255, .2); }
        :host([data-theme="dark"]) button::after { background: #fff; }
        :host([data-size="36"]) button { height: 36px; line-height: 36px; border-radius: 18px; }
      `,
    },

    // YouTube Music player bar, between Dislike and the ⋮ menu: a 36px round
    // text button, like Like and Dislike beside it.
    'ytmusic-icon': {
      stroke: '1.9',
      css: `
        :host { display: inline-flex; flex: none; align-items: center; margin: 0; }
        button {
          position: relative; display: inline-flex; align-items: center; justify-content: center;
          width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%;
          background: transparent; color: #f1f1f1; cursor: pointer; -webkit-tap-highlight-color: transparent;
        }
        button:hover { background: var(--yt-sys-color-baseline--mono-tonal-hover, rgba(255, 255, 255, .2)); }
        button::after {
          content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
          background: #fff; opacity: 0; transition: opacity .3s cubic-bezier(.05, 0, 0, 1);
        }
        button:active::after { opacity: .1; }
        button:focus-visible { outline: none; box-shadow: inset 0 0 0 2px #f1f1f1; }
        svg { width: 24px; height: 24px; flex: none; }
      `,
    },

    // YouTube Music album and playlist headers: a 40px circle with the same
    // faint ring as Save and the ⋮ menu, and a brighter fill inside on hover.
    'ytmusic-header-icon': {
      stroke: '1.9',
      css: `
        :host { display: inline-flex; flex: none; align-items: center; margin-right: 16px; }
        :host([data-after-play]) { margin-right: 32px; }
        button {
          position: relative; display: inline-flex; align-items: center; justify-content: center;
          width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%;
          background: rgba(255, 255, 255, .1); color: #fff; cursor: pointer; -webkit-tap-highlight-color: transparent;
        }
        button::before {
          content: ''; position: absolute; inset: 2px; border-radius: 50%; background: transparent; pointer-events: none;
        }
        button:hover::before { background: rgba(255, 255, 255, .2); }
        button::after {
          content: ''; position: absolute; inset: 2px; border-radius: 50%; pointer-events: none;
          background: #fff; opacity: 0; transition: opacity .3s cubic-bezier(.05, 0, 0, 1);
        }
        button:active::after { opacity: .1; }
        button:focus-visible { outline: none; box-shadow: 0 0 0 2px #3ea6ff; }
        svg { position: relative; width: 24px; height: 24px; flex: none; }
      `,
    },

    // Spotify entity pages, in the action bar after Play: the outline pill
    // Spotify uses for Follow, its only text button in that row.
    'spotify-pill': {
      text: true,
      stroke: '2.2',
      css: `
        :host { display: inline-flex; flex: none; align-items: center; margin-right: 24px; }
        button {
          display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box;
          height: 32px; min-height: 32px; padding: 4px 16px 4px 12px;
          border: 1px solid var(--essential-subdued, #7c7c7c); border-radius: 9999px; background: transparent;
          color: var(--text-base, #fff); cursor: pointer; white-space: nowrap; -webkit-font-smoothing: antialiased;
          font: 700 14px/20px var(--encore-body-font-stack, SpotifyMixUI, "Helvetica Neue", helvetica, arial, sans-serif);
          transition: border-color .15s cubic-bezier(.3, 0, 0, 1), transform .15s cubic-bezier(.3, 0, 0, 1);
        }
        button:hover { border-color: var(--essential-base, #fff); transform: scale(1.04); transition-duration: .05s; }
        button:active { opacity: .7; transform: none; border-color: var(--essential-subdued, #7c7c7c); }
        button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        svg { width: 16px; height: 16px; flex: none; }
      `,
    },

    // Spotify now-playing bar, beside Add to Liked Songs: a 32px tertiary icon.
    'spotify-icon': {
      stroke: '2.2',
      css: `
        :host { display: inline-flex; flex: none; align-items: center; }
        button {
          display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
          width: 32px; height: 32px; padding: 8px; border: 0; border-radius: 9999px;
          background: transparent; color: var(--text-subdued, #b3b3b3); cursor: pointer;
          transition: color .15s cubic-bezier(.3, 0, 0, 1), transform .15s cubic-bezier(.3, 0, 0, 1);
        }
        button:hover { color: var(--text-base, #fff); transform: scale(1.04); transition-duration: .05s; }
        button:active { opacity: .7; transform: none; }
        button:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
        svg { width: 16px; height: 16px; flex: none; }
      `,
    },

    // Apple Music album and playlist headers, next to Play and Shuffle. The
    // header is tinted by the artwork, so data-theme follows the page's own
    // light/dark layout class rather than the OS setting.
    'apple-music-pill': {
      text: true,
      stroke: '2.2',
      css: `
        :host { display: inline-flex; flex: none; align-items: center; }
        button {
          display: inline-flex; align-items: center; justify-content: center; gap: 5px; box-sizing: border-box;
          height: 36px; padding: 0 14px 0 12px;
          border: .75px solid rgba(0, 0, 0, .04); border-radius: 24px;
          background: rgba(0, 0, 0, .06); color: var(--systemPrimary, rgba(0, 0, 0, .88));
          font: 600 15px/20px -apple-system, BlinkMacSystemFont, "Apple Color Emoji", "SF Pro", "SF Pro Icons", "Helvetica Neue", Helvetica, Arial, sans-serif;
          cursor: pointer; white-space: nowrap; transition: background-color .1s ease-in;
        }
        button:hover { background: rgba(0, 0, 0, .1); }
        button:active { background: rgba(0, 0, 0, .15); }
        button:focus-visible { outline: none; box-shadow: 0 0 0 4px rgba(var(--keyColor-rgb, 214, 0, 23), .6); }
        svg { width: 15px; height: 15px; flex: none; }
        :host([data-theme="dark"]) button {
          background: rgba(255, 255, 255, .04); border-color: rgba(255, 255, 255, .08);
          color: var(--systemPrimary, rgba(255, 255, 255, .92));
        }
        :host([data-theme="dark"]) button:hover { background: rgba(255, 255, 255, .1); }
        :host([data-theme="dark"]) button:active { background: rgba(255, 255, 255, .15); }
      `,
    },

    // Instagram post action row, after Share: a bare 40px hit area around a
    // 24px icon that grows a little on hover, as Instagram's own do.
    'instagram-icon': {
      css: `
        :host { display: inline-flex; flex: none; color: inherit; }
        button {
          display: inline-flex; align-items: center; justify-content: center;
          width: 40px; height: 40px; padding: 8px; border: 0; background: none; cursor: pointer;
          color: rgb(var(--ig-primary-icon, 38, 38, 38)); transition: transform .15s ease-out;
        }
        button:hover { transform: scale(1.05); }
        button:active { transform: scale(.95); }
        button:focus-visible { outline: 2px solid #d24294; outline-offset: -2px; }
        svg { width: 24px; height: 24px; }
        :host-context(.__fb-dark-mode) button { color: rgb(var(--ig-primary-icon, 245, 245, 245)); }
        :host([data-theme="dark"]) button { color: rgb(var(--ig-primary-icon, 245, 245, 245)); }
      `,
    },

    // Instagram reels viewer, in the column beside the video. The column is a
    // flex-end stack whose icon-only items (Share, More) are 24px tall with a
    // 28px bottom margin; matching that keeps the column's own rhythm instead
    // of crowding the item below us.
    'instagram-column': {
      css: `
        :host { display: flex; flex: none; justify-content: center; margin-bottom: 28px; color: inherit; }
        button {
          display: inline-flex; flex-direction: column; align-items: center; gap: 4px;
          width: 40px; padding: 0; border: 0; background: none; cursor: pointer;
          color: rgb(var(--ig-primary-icon, 245, 245, 245)); transition: transform .15s ease-out;
        }
        button:hover { transform: scale(1.05); }
        button:active { transform: scale(.95); }
        button:focus-visible { outline: 2px solid #d24294; outline-offset: 2px; }
        svg { width: 24px; height: 24px; }
        :host([data-theme="light"]) button { color: rgb(var(--ig-primary-icon, 38, 38, 38)); }
      `,
    },

    // X post action bar, before Share: a pill that fills with a blue tint on
    // hover, the way Reply and Bookmark do. data-size="large" is the focal
    // post on a /status/ page, where the row is bigger.
    'x-icon': {
      css: `
        :host { display: inline-flex; flex: none; align-items: center; justify-content: flex-start; }
        button {
          position: relative; isolation: isolate; display: inline-flex; align-items: center; justify-content: center;
          height: 36px; min-width: 38px; padding: 0 10px; margin: -8px 0; border: 0; border-radius: 9999px;
          background: transparent; color: var(--x-fg-secondary, rgb(83, 100, 113)); cursor: pointer;
          transition: color .15s cubic-bezier(.4, 0, .2, 1);
        }
        button::before {
          content: ''; position: absolute; inset: 0; z-index: -1; border-radius: 9999px; pointer-events: none;
          background: rgba(29, 155, 240, .1); opacity: 0; scale: .88;
          transition: opacity 140ms ease-out, scale 140ms ease-out;
        }
        button:hover, :host([data-open]) button { color: #1d9bf0; }
        button:hover::before, :host([data-open]) button::before { opacity: 1; scale: 1; }
        button:active::before { background: rgba(29, 155, 240, .2); }
        button:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; }
        svg { width: 18px; height: 18px; flex: none; }
        :host([data-theme="dark"]) button { color: var(--x-fg-secondary, rgb(113, 118, 123)); }
        :host([data-theme="dark"]) button:hover { color: #1d9bf0; }
        :host([data-size="large"]) button { height: 40px; min-width: 44px; padding: 0 12px; }
        :host([data-size="large"]) svg { width: 20px; height: 20px; }
        @media (prefers-reduced-motion: reduce) { button::before { transition: none; } }
      `,
    },

    // Twitch player controls, before the settings gear: a 32px circle that
    // stays white on the video whatever theme the page is in.
    'twitch-control': {
      css: `
        :host { display: inline-flex; flex: none; align-items: center; }
        button {
          display: inline-flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; padding: 0; margin: 0; border: 0;
          border-radius: 9000px; background: transparent; color: #fff; cursor: pointer;
          font: 600 14px/1.4 Inter, "Noto Sans Arabic", Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
          -webkit-tap-highlight-color: transparent;
        }
        button:hover { background: rgba(255, 255, 255, .13); }
        button:active, :host([data-open]) button { background: rgba(255, 255, 255, .16); }
        button:focus { outline: none; }
        button:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 6px 0 rgba(255, 255, 255, .28); }
        svg { width: 20px; height: 20px; display: block; }
      `,
    },

    // Medal's action row under a clip: a 32px filled circle like Share and the
    // ⋮ menu beside it, which turn Medal green while their menu is open.
    'medal-action': {
      css: `
        :host { display: inline-flex; flex: none; align-items: center; }
        button {
          display: flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; padding: 0; margin: 0; border: 0;
          border-radius: 9999px; background: rgba(255, 255, 255, .16); color: #fff; cursor: pointer; outline: none;
          font: 500 14px/20px Inter, "Inter Fallback", ui-sans-serif, system-ui, sans-serif;
          transition: color .2s cubic-bezier(.4, 0, .2, 1), background-color .2s cubic-bezier(.4, 0, .2, 1);
        }
        button:hover { background: rgba(255, 255, 255, .24); }
        :host([data-open]) button { background: #3d5914; color: #bff83e; }
        button:focus-visible { box-shadow: 0 0 0 3px rgba(94, 92, 97, .5); }
        svg { width: 18px; height: 18px; display: block; }
      `,
    },

    // The floating button over a video: neutral dark, for sites with no
    // button of their own to copy.
    overlay: {
      css: `
        :host { all: initial; }
        button {
          display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; padding: 0;
          border: 1px solid rgba(255, 255, 255, .25); border-radius: 50%; cursor: pointer;
          color: #fff; background: rgba(15, 15, 18, .62); backdrop-filter: blur(8px);
          box-shadow: 0 4px 14px rgba(0, 0, 0, .35);
          transition: background .12s ease, transform .12s ease, opacity .12s ease;
        }
        button:hover { background: rgba(15, 15, 18, .85); transform: scale(1.06); }
        button:active { transform: scale(.94); }
        button:focus-visible { outline: 2px solid #5b8cff; outline-offset: 2px; }
        svg { width: 20px; height: 20px; }
      `,
    },

    // TikTok: the same 48px capsule as the volume and "..." controls on the
    // player, which stay dark whatever theme the site is in.
    'tiktok-overlay': {
      css: `
        :host { all: initial; }
        button {
          display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; padding: 0; margin: 0;
          border: 0; border-radius: 999px; cursor: pointer; color: #f6f6f6;
          background: rgba(37, 37, 37, .34);
          font-family: "TikTokFont", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          transition: background-color .2s ease-in-out; -webkit-tap-highlight-color: transparent;
        }
        button:hover, :host([data-open]) button { background: rgba(255, 255, 255, .19); }
        button:active { background: rgba(255, 255, 255, .32); }
        button:focus-visible { outline: 2px solid #fafafa; outline-offset: 2px; }
        svg { width: 24px; height: 24px; filter: drop-shadow(0 0 1px rgba(0, 0, 0, .35)); }
      `,
    },

    // Facebook: the on-media overlay tokens its own player buttons use.
    'facebook-overlay': {
      css: `
        :host { all: initial; }
        button {
          display: inline-flex; align-items: center; justify-content: center;
          width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
          color: #fff; background: rgba(0, 0, 0, .4);
          box-shadow: 0 2px 4px 0 rgba(0, 0, 0, .1);
          transition: background-color .2s ease, transform .12s ease;
        }
        button:hover, :host([data-open]) button { background: rgba(0, 0, 0, .6); }
        button:active { background: rgba(0, 0, 0, .6); transform: scale(.96); }
        button:focus-visible { outline: 2px solid #0866ff; outline-offset: 2px; }
        svg { width: 20px; height: 20px; }
      `,
    },

    // Snapchat: one more control in the Spotlight player's top-right cluster.
    'snapchat-overlay': {
      css: `
        :host { all: initial; }
        button {
          display: inline-flex; align-items: center; justify-content: center;
          width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
          color: #fff; background: rgba(0, 0, 0, .5);
          transition: background-color .3s ease-out, transform .12s ease;
        }
        button:hover, :host([data-open]) button { background: rgba(0, 0, 0, .7); transition: background-color .1s ease; }
        button:active { transform: scale(.94); }
        button:focus-visible { outline: 2px solid #fffc00; outline-offset: 2px; }
        svg { width: 20px; height: 20px; }
      `,
    },

    // Twitch: over thumbnails and players that have no control bar to join.
    'twitch-overlay': {
      css: `
        :host { all: initial; }
        button {
          display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0;
          border: 0; border-radius: 9000px; cursor: pointer; color: #fff;
          background: rgba(14, 14, 16, .72);
          box-shadow: 0 4px 8px rgba(0, 0, 0, .6), 0 0 4px rgba(0, 0, 0, .4);
          transition: background-color .1s ease;
        }
        button:hover, :host([data-open]) button { background: #772ce8; }
        button:active { background: #5c16c5; }
        button:focus-visible { outline: none; box-shadow: 0 0 0 2px #a970ff, 0 0 6px 0 #772ce8; }
        svg { width: 20px; height: 20px; }
      `,
    },

    // Medal: the clip player's own chrome, in Medal's green on hover.
    'medal-overlay': {
      css: `
        :host { all: initial; }
        button {
          display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0;
          border: 1px solid rgba(255, 255, 255, .16); border-radius: 9999px; cursor: pointer; color: #fff;
          background: rgba(31, 31, 32, .8); backdrop-filter: blur(8px);
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, .1), 0 2px 4px -2px rgba(0, 0, 0, .1);
          transition: color .2s cubic-bezier(.4, 0, .2, 1), background-color .2s cubic-bezier(.4, 0, .2, 1);
        }
        button:hover, :host([data-open]) button { background: #3d5914; color: #bff83e; border-color: rgba(191, 248, 62, .24); }
        button:active { background: #486a0f; }
        button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(94, 92, 97, .5); }
        svg { width: 18px; height: 18px; }
      `,
    },

    // X: over a video card, clear of the player's own control row.
    'x-overlay': {
      css: `
        :host { all: initial; }
        button {
          display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0;
          border: 1px solid transparent; border-radius: 9999px; cursor: pointer; color: #fff;
          background: rgba(0, 0, 0, .6); backdrop-filter: blur(4px);
          transition: background-color .15s cubic-bezier(.4, 0, .2, 1);
        }
        button:hover, :host([data-open]) button { background: rgba(0, 0, 0, .77); }
        button:active { background: rgba(0, 0, 0, .85); }
        button:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; }
        svg { width: 20px; height: 20px; }
      `,
    },
  };

  // ---------------------------------------------------------------------------
  // Light or dark
  // ---------------------------------------------------------------------------

  /**
   * 'light' or 'dark' for the page. The theme registry knows each site's own
   * signal; the fallback reads the signals sites share, for the moment before
   * it has loaded. The answer is kept for the rest of the frame, so a page
   * full of buttons only works it out once.
   */
  function pageTheme() {
    if (!cachedTheme) cachedTheme = readPageTheme();
    return cachedTheme;
  }

  function readPageTheme() {
    try {
      const theme = JDI.themes && typeof JDI.themes.forLocation === 'function' ? JDI.themes.forLocation(window.location) : null;
      const mode = theme && typeof theme.detect === 'function' ? theme.detect() : '';
      if (mode === 'light' || mode === 'dark') return mode;
    } catch {
      /* fall through to the page's own signals */
    }
    const html = document.documentElement;
    if (html.hasAttribute('dark')) return 'dark'; // YouTube
    const attr = html.getAttribute('data-theme'); // X, TikTok, Snapchat
    if (attr === 'dark' || attr === 'light') return attr;
    const classes = html.classList;
    if (classes.contains('__fb-dark-mode') || classes.contains('tw-root--theme-dark')) return 'dark';
    if (classes.contains('__fb-light-mode') || classes.contains('tw-root--theme-light')) return 'light';
    if (classes.contains('encore-light-theme')) return 'light';
    const parts = (/rgba?\(([^)]+)\)/.exec(getComputedStyle(document.body || html).backgroundColor || '') || [])[1];
    const rgb = parts ? parts.split(',').map(Number) : null;
    if (rgb && rgb.length >= 3 && !rgb.some(Number.isNaN) && (rgb.length < 4 || rgb[3] > 0.2)) {
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128 ? 'dark' : 'light';
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /** Re-read one button's theme, if it was created with one. */
  function applyTheme(hostEl) {
    const resolve = hostEl[THEME];
    if (!resolve) return;
    let mode = '';
    try {
      mode = resolve(hostEl) || '';
    } catch {
      return;
    }
    if (mode !== 'light' && mode !== 'dark') return;
    if (hostEl.getAttribute('data-theme') !== mode) hostEl.setAttribute('data-theme', mode);
  }

  /** Keep every button in step when the site switches theme. */
  function refreshThemes() {
    cachedTheme = '';
    for (const hostEl of document.querySelectorAll(`${TAG}, ${FLOAT_TAG}`)) applyTheme(hostEl);
  }

  // ---------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------

  function create({ look, label = 'Download', title, onClick, theme }) {
    const hostEl = document.createElement(TAG);
    hostEl.setAttribute('data-look', look);
    const button = buildButton(hostEl, look, label, title);
    if (theme) {
      hostEl[THEME] = typeof theme === 'function' ? theme : theme === 'auto' ? pageTheme : () => theme;
      applyTheme(hostEl);
    }
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.isTrusted) return;
      // Clicking the button while its picker is open closes the picker
      // (on pointerdown); don't reopen it on the click that follows.
      if (JDI.picker && JDI.picker.closedByClickOn(hostEl)) return;
      onClick(hostEl);
    });
    return hostEl;
  }

  function buildButton(hostEl, look, label, title) {
    const style = LOOKS[look] || LOOKS.overlay;
    const root = hostEl.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(style.css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const element = document.createElement('style');
      element.textContent = style.css;
      root.appendChild(element);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.title = title || label;
    button.setAttribute('aria-label', title || label);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PATH);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', style.stroke || '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    button.appendChild(svg);
    if (style.text) {
      const text = document.createElement('span');
      text.textContent = label;
      button.appendChild(text);
    }
    // Keep the site from treating clicks on our button as clicks on its own UI
    // (a click on a TikTok or Twitch video would otherwise pause it).
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'keydown', 'touchstart']) {
      button.addEventListener(type, (e) => e.stopPropagation());
    }
    root.appendChild(button);
    return button;
  }

  // ---------------------------------------------------------------------------
  // Floating button over videos
  // ---------------------------------------------------------------------------

  function hoverVideos({ onClick, minWidth = 200, minHeight = 150, look = 'overlay', size = 38, inset = 12, gap = 0, theme }) {
    const hostEl = document.createElement(FLOAT_TAG);
    hostEl.style.cssText =
      'all: initial !important; position: fixed !important; z-index: 2147483646 !important; display: none !important; ' +
      `width: ${size}px !important; height: ${size}px !important; top: 0; left: 0;`;
    const button = buildButton(hostEl, look, 'Download', 'Download');
    if (theme) {
      hostEl[THEME] = typeof theme === 'function' ? theme : theme === 'auto' ? pageTheme : () => theme;
      applyTheme(hostEl);
    }
    let video = null;
    let hideTimer = 0;
    let pending = null;
    let raf = 0;

    /** The player around a video: the nearest ancestor that isn't much bigger. */
    const playerOf = (v) => {
      const r = v.getBoundingClientRect();
      let node = v;
      for (let depth = 0; depth < 5 && node.parentElement; depth++) {
        const b = node.parentElement.getBoundingClientRect();
        if (b.width > r.width * 2 + 200 || b.height > r.height * 2 + 200) break;
        node = node.parentElement;
      }
      return node === v ? v.parentElement || v : node;
    };

    /**
     * `gap` is measured per site, but a player can show one control more than
     * it did when it was measured (Snapchat adds a subtitle button to snaps
     * with captions), and covering the site's own button is the one placement
     * we can't live with. Step left past whatever is in that corner. Only the
     * player's own subtree is searched, and only when the video moves, so this
     * costs nothing while the pointer wanders.
     */
    let placed = null;
    const clearOfControls = (v, left, top) => {
      const r = v.getBoundingClientRect();
      if (placed && placed.video === v && placed.right === r.right && placed.top === r.top) return placed.left;
      const player = playerOf(v);
      for (let step = 0; step < 4 && left > 0; step++) {
        let hit = null;
        for (const node of player.querySelectorAll('button, [role="button"], a[href], input, select')) {
          if (node === hostEl || hostEl.contains(node)) continue;
          const b = node.getBoundingClientRect();
          // A control, not the player surface or a link wrapped round the video.
          if (b.width <= 0 || b.height <= 0 || b.width > 120 || b.height > 120) continue;
          if (b.right <= left || b.left >= left + size || b.bottom <= top || b.top >= top + size) continue;
          if (!hit || b.left < hit.left) hit = b;
        }
        if (!hit) break;
        left = Math.min(left, hit.left - size - 8);
      }
      left = Math.max(left, 0);
      placed = { video: v, right: r.right, top: r.top, left };
      return left;
    };

    const show = (v) => {
      clearTimeout(hideTimer);
      video = v;
      const r = v.getBoundingClientRect();
      // In the video's top-right corner, leaving room for the site's own
      // control there (TikTok's "...", Snapchat's mute).
      const top = Math.max(r.top, 0) + inset;
      const left = clearOfControls(v, Math.min(r.right, window.innerWidth) - size - inset - gap, top);
      const parent = document.fullscreenElement && document.fullscreenElement.tagName !== 'VIDEO' ? document.fullscreenElement : document.documentElement;
      if (hostEl.parentNode !== parent) parent.appendChild(hostEl);
      hostEl.style.setProperty('left', `${Math.round(left)}px`, 'important');
      hostEl.style.setProperty('top', `${Math.round(top)}px`, 'important');
      hostEl.style.setProperty('display', 'block', 'important');
    };
    const hide = () => {
      video = null;
      hostEl.style.setProperty('display', 'none', 'important');
    };
    const hideSoon = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 500);
    };

    /**
     * Some players already carry one of our buttons in their own controls
     * (Twitch's control bar, Instagram's reel column). Two Download buttons on
     * one video is one too many, so the floating one stays away.
     */
    const alreadyServed = (v) => {
      let node = v;
      for (let depth = 0; depth < 6 && node; depth++) {
        if (node.querySelector && node.querySelector(TAG)) return true;
        node = node.parentElement;
      }
      return false;
    };

    const check = () => {
      raf = 0;
      if (!enabled || !pending) return;
      const { x, y, path } = pending;
      pending = null;
      if (path.includes(hostEl)) {
        clearTimeout(hideTimer); // on the button itself
        return;
      }
      const stack = JDI.dom.deepElementsFromPoint(x, y);
      const found = JDI.dom
        .findMediaAt(stack, x, y)
        .find((m) => m.tagName === 'VIDEO' && m.getBoundingClientRect().width >= minWidth && m.getBoundingClientRect().height >= minHeight);
      if (found && !alreadyServed(found)) show(found);
      else hideSoon();
    };

    const onMove = (e) => {
      if (!e.isTrusted) return;
      pending = { x: e.clientX, y: e.clientY, path: e.composedPath() };
      if (!raf) raf = requestAnimationFrame(check);
    };
    const onScroll = () => {
      if (video) hide();
    };

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.isTrusted || !video) return;
      if (JDI.picker && JDI.picker.closedByClickOn(hostEl)) return;
      onClick(video, hostEl);
    });

    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    cleanups.push(() => {
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('scroll', onScroll, { capture: true });
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(hideTimer);
      hostEl.remove();
    });
  }

  /** A hit-test snapshot at the centre of an element, for handlers' snapshot(). */
  function centreOf(element) {
    const r = element.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
    return { x, y, stack: JDI.dom.deepElementsFromPoint(x, y), target: element };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function schedule() {
    if (frame || !enabled) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      cachedTheme = '';
      for (const fn of listeners) {
        try {
          fn();
        } catch (err) {
          console.warn('[Just download it] button placement failed', err);
        }
      }
      refreshThemes();
    });
  }

  function onChange(fn) {
    listeners.push(fn);
    schedule();
  }

  /** Remove every button this copy of the extension added. */
  function removeAll() {
    for (const node of document.querySelectorAll(`${TAG}, ${FLOAT_TAG}`)) {
      if (node.tagName.toLowerCase() === FLOAT_TAG) node.style.setProperty('display', 'none', 'important');
      else node.remove();
    }
  }

  function start(settings) {
    if (started || window.top !== window) return; // buttons only in the top frame
    started = true;
    enabled = settings.pageButtons !== false;

    const api = { create, onChange, hoverVideos, centreOf, theme: pageTheme, TAG };
    for (const install of installers) {
      try {
        install(api);
      } catch (err) {
        console.warn('[Just download it] button setup failed', err);
      }
    }

    observer = new MutationObserver(schedule);
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });

    // Single-page-app navigations (YouTube fires its own events; others use history).
    for (const type of ['yt-navigate-finish', 'yt-page-data-updated', 'popstate', 'load']) {
      const handler = () => schedule();
      window.addEventListener(type, handler, true);
      document.addEventListener(type, handler, true);
      cleanups.push(() => {
        window.removeEventListener(type, handler, true);
        document.removeEventListener(type, handler, true);
      });
    }

    // Sites that follow the operating system's setting switch theme without
    // touching the DOM.
    try {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onScheme = () => refreshThemes();
      media.addEventListener('change', onScheme);
      cleanups.push(() => media.removeEventListener('change', onScheme));
    } catch {
      /* ignore */
    }

    const onSettings = (changes, area) => {
      if (area !== 'sync' || !changes.pageButtons) return;
      enabled = changes.pageButtons.newValue !== false;
      if (enabled) schedule();
      else removeAll();
    };
    try {
      chrome.storage.onChanged.addListener(onSettings);
      cleanups.push(() => chrome.storage.onChanged.removeListener(onSettings));
    } catch {
      /* ignore */
    }
    if (!enabled) removeAll();
  }

  function teardown() {
    if (observer) observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    listeners.length = 0;
    for (const node of document.querySelectorAll(`${TAG}, ${FLOAT_TAG}`)) node.remove();
    started = false;
  }

  JDI.buttons = {
    /** Called by site handlers at load: register(api => { ... }). */
    register(install) {
      installers.push(install);
    },
    start,
    teardown,
    get enabled() {
      return enabled;
    },
  };
})();
