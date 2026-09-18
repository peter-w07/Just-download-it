/*
 * Just download it: the per-site theme registry.
 *
 * Every site we support speaks its own menu language: YouTube's 12px sheet
 * with full-bleed rows, Spotify's tight 4px card, X's squircle, Instagram's
 * 48px rows, Twitch's 6px float. This file holds what was measured on each of
 * them so the picker, the page buttons and the capture UI can be drawn in the
 * language of the page they sit on instead of one house style. Sites we don't
 * know get the neutral "default" theme, which is the picker's own look.
 *
 * A theme is { id, font, fontSize, menu, tokens: { light, dark }, detect() }:
 *
 *   detect()  reads the site's own theme switch (html[dark] on YouTube,
 *             .tw-root--theme-dark on Twitch, __fb-dark-mode on Meta's sites,
 *             an attribute, a cookie) and falls back to the page's canvas
 *             colour, so it never guesses wrong on a site that ignores the OS
 *             setting.
 *   tokens    are plain CSS colours that lean on the site's own custom
 *             properties where the research found them. Custom properties
 *             inherit into closed shadow roots and `all: initial` does not
 *             reset them, so var(--yt-sys-color-baseline--menu-background) is
 *             live: the picker repaints itself when the site does. Every
 *             reference carries the measured value as its fallback, and
 *             resolve() drops the var() wrapper when the page does not
 *             actually define it -- an empty custom property makes the whole
 *             declaration invalid, which would leave the panel unpainted.
 *   menu      the metrics measured on that site's own menus: radii, row
 *             height, padding, weights, icon size, and its primary button.
 *
 * current(location) resolves a theme for the active light/dark mode;
 * varsFor() turns that into the --jdi-* custom properties the UI files use,
 * and observe() re-runs the whole thing when the site flips its theme.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});

  // ---------------------------------------------------------------------------
  // Reading the page
  // ---------------------------------------------------------------------------

  let colorCanvas = null;
  /** Any CSS color (rgb(), color(srgb …), oklch(), named…) -> [r, g, b, a]. */
  function parseColor(value) {
    if (!value) return null;
    try {
      colorCanvas = colorCanvas || document.createElement('canvas');
      colorCanvas.width = colorCanvas.height = 1;
      const ctx = colorCanvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    } catch {
      return null;
    }
  }

  function prefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
      return false;
    }
  }

  /**
   * The last resort: how dark the page paints its own canvas. Used by the
   * default theme and by every site whose own switch can't be read yet.
   */
  function canvasMode() {
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue;
      let background = '';
      try {
        background = getComputedStyle(node).backgroundColor;
      } catch {
        /* detached document */
      }
      const rgba = parseColor(background);
      if (rgba && rgba[3] > 0.5) {
        const luminance = (0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2]) / 255;
        return luminance < 0.5 ? 'dark' : 'light';
      }
    }
    let scheme = '';
    try {
      scheme = getComputedStyle(document.documentElement).colorScheme || '';
    } catch {
      /* detached document */
    }
    if (/^\s*dark\s*$/.test(scheme)) return 'dark';
    if (/^\s*light\s*$/.test(scheme)) return 'light';
    return prefersDark() ? 'dark' : 'light';
  }

  const root = () => document.documentElement;
  const hasClass = (name) => !!root() && root().classList.contains(name);
  const attr = (name) => (root() ? root().getAttribute(name) : null);

  /**
   * The mode the site's own background token says it is in. Detection and
   * colours have to agree: most of our tokens are that site's custom
   * properties, so calling a page dark while its properties are still light
   * would mix the two halves. Reading the property settles it. `wrap` is for
   * sites that store bare channels ("12, 16, 20") instead of a colour.
   */
  /**
   * Is this element part of a Twitch video player? Our own hosts are the
   * awkward case: the button in the control bar really is inside the player,
   * but the floating button over a video is appended to <html>, so ask where
   * it is on screen instead.
   */
  function inTwitchPlayer(element) {
    if (!element || typeof element.closest !== 'function') return false;
    if (element.closest('.video-player, .persistent-player, [data-a-target="video-player"], [data-a-target="player-overlay-click-handler"], .player-controls')) return true;
    if (element.tagName !== 'JDI-FLOAT') return false;
    let box = null;
    try {
      box = element.getBoundingClientRect();
    } catch {
      return false;
    }
    const centre = [box.left + box.width / 2, box.top + box.height / 2];
    for (const video of document.querySelectorAll('video')) {
      const r = video.getBoundingClientRect();
      if (centre[0] >= r.left && centre[0] <= r.right && centre[1] >= r.top && centre[1] <= r.bottom) return true;
    }
    return false;
  }

  function modeFromProperty(name, wrap) {
    let value = '';
    try {
      value = root() ? getComputedStyle(root()).getPropertyValue(name).trim() : '';
    } catch {
      return null;
    }
    if (!value) return null;
    const rgba = parseColor(wrap ? wrap.replace('*', value) : value);
    if (!rgba || rgba[3] < 0.5) return null;
    return (0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2]) / 255 < 0.5 ? 'dark' : 'light';
  }

  // ---------------------------------------------------------------------------
  // The sites
  // ---------------------------------------------------------------------------

  /**
   * Shared shapes. Colours are written as the site writes them: a var()
   * reference where the research confirmed the property exists on <html>,
   * with the measured value as the fallback, and a plain colour otherwise.
   */
  const THEMES = [
    {
      id: 'default',
      hosts: [],
      font: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      fontSize: 13,
      detect: canvasMode,
      menu: {
        radius: 12,
        itemRadius: 8,
        itemHeight: 36,
        itemPadX: 8,
        listPadY: 6,
        listPadX: 6,
        weight: 550,
        titleWeight: 600,
        iconSize: 16,
        width: 320,
        badgeRadius: 999,
        buttonRadius: 8,
        buttonHeight: 36,
        buttonWeight: 600,
        buttonFontSize: 13,
      },
      tokens: {
        light: {
          surface: '#ffffff',
          text: '#16181d',
          muted: '#646b78',
          hover: '#f2f4f7',
          pressed: 'rgba(15, 20, 30, .1)',
          divider: '#e6e8ec',
          border: '1px solid #e6e8ec',
          accent: '#2f6bff',
          accentText: '#ffffff',
          accentHover: '#2a5fe6',
          badgeBg: '#e8efff',
          badgeText: '#2f6bff',
          ok: '#12805c',
          err: '#c4323a',
          focus: '#2f6bff',
          shadow: '0 12px 32px rgba(15, 20, 30, .18), 0 2px 6px rgba(15, 20, 30, .08)',
          toastBg: '#ffffff',
          toastText: '#16181d',
        },
        dark: {
          surface: '#1c1f26',
          text: '#eef0f4',
          muted: '#9aa2b1',
          hover: '#262a33',
          pressed: 'rgba(255, 255, 255, .14)',
          divider: '#2e333d',
          border: '1px solid #2e333d',
          accent: '#5b8cff',
          accentText: '#0b0d12',
          accentHover: '#7aa1ff',
          badgeBg: '#232c44',
          badgeText: '#5b8cff',
          ok: '#3ccf91',
          err: '#ff6b73',
          focus: '#5b8cff',
          shadow: '0 12px 32px rgba(0, 0, 0, .5), 0 2px 6px rgba(0, 0, 0, .3)',
          toastBg: '#1c1f26',
          toastText: '#eef0f4',
        },
      },
    },

    {
      // The watch-page "More actions" sheet: 12px radius, no border, a wide
      // soft shadow, 8px of list padding and rows that fill the full width.
      // YouTube sets html{font-size:62.5%}, so everything here is px.
      id: 'youtube',
      hosts: ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com'],
      font: 'Roboto, Arial, sans-serif',
      fontSize: 14,
      detect: () => (root() && root().hasAttribute('dark') ? 'dark' : 'light'),
      menu: {
        radius: 12,
        itemRadius: 0,
        itemHeight: 40,
        itemPadX: 16,
        listPadY: 8,
        listPadX: 0,
        weight: 400,
        titleWeight: 500,
        iconSize: 24,
        width: 320,
        badgeRadius: 999,
        buttonRadius: 20,
        buttonHeight: 40,
        buttonWeight: 500,
        buttonFontSize: 14,
      },
      tokens: {
        light: {
          surface: 'var(--yt-sys-color-baseline--menu-background, #ffffff)',
          text: 'var(--yt-sys-color-baseline--text-primary, #0f0f0f)',
          muted: 'var(--yt-sys-color-baseline--text-secondary, #606060)',
          hover: 'var(--yt-sys-color-baseline--additive-background, rgba(0, 0, 0, .05))',
          pressed: 'var(--yt-sys-color-baseline--mono-tonal-hover, rgba(0, 0, 0, .1))',
          divider: 'var(--yt-sys-color-baseline--outline, rgba(0, 0, 0, .1))',
          border: 'none',
          accent: 'var(--yt-sys-color-baseline--inverted-background, #0f0f0f)',
          accentText: 'var(--yt-sys-color-baseline--text-primary-inverse, #ffffff)',
          accentHover: 'var(--yt-sys-color-baseline--mono-filled-hover, #272727)',
          badgeBg: 'var(--yt-sys-color-baseline--additive-background, rgba(0, 0, 0, .05))',
          badgeText: 'var(--yt-sys-color-baseline--text-primary, #0f0f0f)',
          ok: '#107516',
          err: 'var(--yt-sys-color-baseline--error-indicator, #c30027)',
          // YouTube rings a focused control in its text colour, not in blue.
          focus: 'var(--yt-sys-color-baseline--text-primary, #0f0f0f)',
          shadow: '0 4px 32px 0 rgba(0, 0, 0, .1)',
          toastBg: 'var(--yt-sys-color-baseline--inverted-background, #0f0f0f)',
          toastText: 'var(--yt-sys-color-baseline--text-primary-inverse, #ffffff)',
        },
        dark: {
          surface: 'var(--yt-sys-color-baseline--menu-background, #282828)',
          text: 'var(--yt-sys-color-baseline--text-primary, #f1f1f1)',
          muted: 'var(--yt-sys-color-baseline--text-secondary, #aaaaaa)',
          hover: 'var(--yt-sys-color-baseline--additive-background, rgba(255, 255, 255, .1))',
          pressed: 'var(--yt-sys-color-baseline--mono-tonal-hover, rgba(255, 255, 255, .2))',
          divider: 'var(--yt-sys-color-baseline--outline, rgba(255, 255, 255, .2))',
          border: 'none',
          accent: 'var(--yt-sys-color-baseline--inverted-background, #f1f1f1)',
          accentText: 'var(--yt-sys-color-baseline--text-primary-inverse, #0f0f0f)',
          accentHover: 'var(--yt-sys-color-baseline--mono-filled-hover, #d9d9d9)',
          badgeBg: 'var(--yt-sys-color-baseline--additive-background, rgba(255, 255, 255, .1))',
          badgeText: 'var(--yt-sys-color-baseline--text-primary, #f1f1f1)',
          ok: '#2ba640',
          err: 'var(--yt-sys-color-baseline--error-indicator, #ff5577)',
          focus: 'var(--yt-sys-color-baseline--text-primary, #f1f1f1)',
          shadow: '0 4px 32px 0 rgba(0, 0, 0, .1)',
          toastBg: 'var(--yt-sys-color-baseline--inverted-background, #f1f1f1)',
          toastText: 'var(--yt-sys-color-baseline--text-primary-inverse, #0f0f0f)',
        },
      },
    },

    {
      // YouTube Music has no light theme: <html dark="true"> is always set.
      // Its menus are a hairline-bordered 2px listbox with 48px rows and no
      // shadow at all.
      id: 'youtube-music',
      hosts: ['music.youtube.com'],
      font: 'Roboto, "Noto Naskh Arabic UI", Arial, sans-serif',
      fontSize: 14,
      detect: () => 'dark',
      menu: {
        radius: 2,
        itemRadius: 0,
        itemHeight: 48,
        itemPadX: 16,
        listPadY: 8,
        listPadX: 0,
        weight: 400,
        titleWeight: 500,
        iconSize: 18,
        width: 300,
        badgeRadius: 2,
        buttonRadius: 16,
        buttonHeight: 36,
        buttonWeight: 500,
        buttonFontSize: 14,
      },
      tokens: {
        light: null,
        dark: {
          surface: 'var(--ytmusic-brand-background-solid, #212121)',
          text: 'var(--ytmusic-text-primary, #ffffff)',
          muted: 'var(--ytmusic-text-secondary, #aaaaaa)',
          hover: 'var(--ytmusic-menu-item-hover-background-color, rgba(255, 255, 255, .05))',
          pressed: 'rgba(255, 255, 255, .1)',
          divider: 'var(--ytmusic-divider, rgba(255, 255, 255, .1))',
          border: '1px solid rgba(255, 255, 255, .1)',
          accent: '#ffffff',
          accentText: '#030303',
          accentHover: '#d9d9d9',
          badgeBg: 'var(--ytmusic-badge-chip-background, rgba(255, 255, 255, .1))',
          badgeText: '#ffffff',
          ok: 'var(--ytmusic-themed-green, #2ba640)',
          err: '#ff5577',
          focus: 'var(--ytmusic-focus-active, #3ea6ff)',
          shadow: 'none',
          toastBg: '#323232',
          toastText: '#f1f1f1',
        },
      },
    },

    {
      // Spotify's encore context menu: 4px card, 4px of padding, 40px rows
      // with a 2px radius, and the double drop shadow. The web player is
      // dark-only in practice, so there is one token set.
      id: 'spotify',
      hosts: ['open.spotify.com'],
      font: 'var(--encore-body-font-stack, SpotifyMixUI, "Helvetica Neue", Helvetica, Arial, sans-serif)',
      fontSize: 14,
      // The web player ships no light theme, and there are no light tokens to
      // render one with, so the encore-light-theme class is not consulted.
      detect: () => 'dark',
      menu: {
        radius: 4,
        itemRadius: 2,
        itemHeight: 40,
        itemPadX: 12,
        listPadY: 4,
        listPadX: 4,
        weight: 400,
        titleWeight: 700,
        iconSize: 16,
        width: 320,
        badgeRadius: 2,
        buttonRadius: 9999,
        buttonHeight: 40,
        buttonWeight: 700,
        buttonFontSize: 14,
      },
      tokens: {
        light: null,
        dark: {
          surface: '#282828',
          text: 'rgba(255, 255, 255, .9)',
          muted: 'var(--text-subdued, #b3b3b3)',
          hover: 'var(--background-tinted-base, rgba(255, 255, 255, .1))',
          pressed: 'var(--background-tinted-press, rgba(255, 255, 255, .21))',
          divider: 'rgba(255, 255, 255, .1)',
          border: 'none',
          accent: 'var(--essential-bright-accent, #1ed760)',
          accentText: '#000000',
          accentHover: '#3be477',
          badgeBg: 'var(--background-tinted-base, rgba(255, 255, 255, .1))',
          badgeText: 'var(--essential-bright-accent, #1ed760)',
          ok: '#1ed760',
          err: 'var(--text-negative, #f3727f)',
          focus: '#ffffff',
          shadow: '0 16px 24px rgba(0, 0, 0, .3), 0 6px 8px rgba(0, 0, 0, .2)',
          toastBg: '#ffffff',
          toastText: '#000000',
        },
      },
    },

    {
      // Apple Music's amp-contextual-menu is a glass platter: a translucent
      // material with a heavy backdrop blur, an inset hairline, 32px rows and
      // hairline dividers between them.
      id: 'apple-music',
      hosts: ['music.apple.com'],
      font: '-apple-system, BlinkMacSystemFont, "SF Pro", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif',
      fontSize: 13,
      detect: () => (prefersDark() ? 'dark' : 'light'),
      menu: {
        radius: 6,
        itemRadius: 0,
        itemHeight: 32,
        itemPadX: 10,
        listPadY: 0,
        listPadX: 0,
        weight: 400,
        titleWeight: 600,
        iconSize: 16,
        width: 300,
        badgeRadius: 4,
        buttonRadius: 1000,
        buttonHeight: 32,
        buttonWeight: 600,
        buttonFontSize: 13,
        blur: 'saturate(210%) blur(60px)',
      },
      tokens: {
        light: {
          surface: 'var(--systemStandardThickMaterialSover, rgba(246, 246, 246, .8))',
          surfaceSolid: '#f0f0f0', // what Apple Music itself falls back to without the blur
          text: 'var(--systemPrimary, rgba(0, 0, 0, .88))',
          muted: 'var(--systemSecondary, rgba(0, 0, 0, .56))',
          hover: 'var(--systemQuinary, rgba(0, 0, 0, .05))',
          pressed: 'var(--systemQuaternary, rgba(0, 0, 0, .1))',
          divider: 'var(--labelDivider, rgba(0, 0, 0, .15))',
          // Every item after the first carries a hairline on Apple Music: it is
          // half of what makes its menus recognisable, next to the glass.
          rowLine: '1px solid var(--labelDivider, rgba(0, 0, 0, .15))',
          border: 'none',
          accent: 'var(--keyColor, #d60017)',
          accentText: '#ffffff',
          accentHover: 'var(--keyColor-rollover, #a20000)',
          badgeBg: 'rgba(118, 118, 128, .12)',
          badgeText: 'var(--keyColor, #d60017)',
          ok: '#28cd41',
          err: '#ff3b30',
          // Apple rings a focused row in the key colour at 60%, never at full
          // strength -- solid red reads as an error.
          focus: 'rgba(var(--keyColor-rgb, 214, 0, 23), .6)',
          shadow: 'inset 0 0 0 1px rgba(255, 255, 255, .2), 0 8px 40px rgba(0, 0, 0, .25)',
          toastBg: 'rgba(245, 245, 247, .8)',
          toastText: 'var(--systemPrimary, rgba(0, 0, 0, .88))',
        },
        dark: {
          surface: 'var(--systemStandardThickMaterialSover, rgba(40, 40, 40, .8))',
          surfaceSolid: '#1e1e1e',
          text: 'var(--systemPrimary, rgba(255, 255, 255, .92))',
          muted: 'var(--systemSecondary, rgba(255, 255, 255, .64))',
          hover: 'var(--systemQuinary, rgba(255, 255, 255, .05))',
          pressed: 'var(--systemQuaternary, rgba(255, 255, 255, .1))',
          divider: 'var(--labelDivider, rgba(255, 255, 255, .1))',
          rowLine: '1px solid var(--labelDivider, rgba(255, 255, 255, .1))',
          border: 'none',
          accent: 'var(--keyColor, #fa586a)',
          accentText: '#ffffff',
          accentHover: '#ff7d8b',
          badgeBg: 'rgba(255, 255, 255, .1)',
          badgeText: 'var(--keyColor, #fa586a)',
          ok: '#30d158',
          err: '#ff453a',
          focus: 'rgba(var(--keyColor-rgb, 250, 88, 106), .6)',
          shadow: 'inset 0 0 0 1px rgba(255, 255, 255, .2), 0 8px 40px rgba(0, 0, 0, .55)',
          toastBg: 'rgba(38, 38, 40, .8)',
          toastText: 'var(--systemPrimary, rgba(255, 255, 255, .92))',
        },
      },
    },

    {
      // Twitch floats: no border, only a shadow, 6px radius, 8px of inner
      // padding and 32px rows with a 4px radius. Its primary is the purple
      // pill.
      id: 'twitch',
      hosts: ['www.twitch.tv', 'twitch.tv', 'clips.twitch.tv', 'm.twitch.tv'],
      font: 'Inter, "Noto Sans Arabic", Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif',
      fontSize: 14,
      detect: () => {
        if (hasClass('tw-root--theme-dark')) return 'dark';
        if (hasClass('tw-root--theme-light')) return 'light';
        return modeFromProperty('--color-background-float') || canvasMode();
      },
      // Twitch's player re-scopes --color-background-float to #323239 inside
      // its dialog layer, so the settings menu stays dark on a light page.
      // Anything we hang off the player (the control-bar button, the floating
      // button over the video) follows the player, not the page.
      forAnchor: (element) => (inTwitchPlayer(element) ? 'dark' : null),
      menu: {
        radius: 6,
        itemRadius: 4,
        itemHeight: 32,
        itemPadX: 6,
        listPadY: 8,
        listPadX: 8,
        weight: 400,
        titleWeight: 600,
        iconSize: 20,
        width: 320,
        badgeRadius: 4,
        buttonRadius: 9000,
        buttonHeight: 36,
        buttonWeight: 600,
        buttonFontSize: 14,
      },
      tokens: {
        light: {
          surface: 'var(--color-background-float, #ffffff)',
          text: 'var(--color-text-base, #0e0e10)',
          muted: 'var(--color-text-alt-2, #3b3b44)',
          hover: 'var(--color-background-interactable-hover, rgba(173, 173, 184, .35))',
          pressed: 'var(--color-background-interactable-active, rgba(173, 173, 184, .43))',
          divider: 'rgba(173, 173, 184, .35)',
          border: 'none',
          accent: 'var(--color-background-button-primary-default, #9147ff)',
          accentText: 'var(--color-text-button-primary, #ffffff)',
          accentHover: 'var(--color-background-button-primary-hover, #772ce8)',
          badgeBg: 'rgba(145, 71, 255, .14)',
          badgeText: '#772ce8',
          ok: '#0a5738',
          err: '#971311',
          focus: '#772ce8',
          shadow: '0 4px 8px rgba(0, 0, 0, .16), 0 0 4px rgba(0, 0, 0, .08)',
          toastBg: '#ffffff',
          toastText: '#0e0e10',
        },
        dark: {
          surface: 'var(--color-background-float, #323239)',
          text: 'var(--color-text-base, #efeff1)',
          muted: 'var(--color-text-alt-2, #d3d3d9)',
          hover: 'var(--color-background-interactable-hover, rgba(83, 83, 95, .48))',
          pressed: 'var(--color-background-interactable-active, rgba(83, 83, 95, .55))',
          divider: 'rgba(83, 83, 95, .48)',
          border: 'none',
          accent: 'var(--color-background-button-primary-default, #9147ff)',
          accentText: 'var(--color-text-button-primary, #ffffff)',
          accentHover: 'var(--color-background-button-primary-hover, #772ce8)',
          badgeBg: 'rgba(169, 112, 255, .2)',
          badgeText: '#a970ff',
          ok: '#00c274',
          err: '#ff8280',
          focus: '#a970ff',
          shadow: '0 6px 16px rgba(0, 0, 0, .6), 0 0 4px rgba(0, 0, 0, .4)',
          toastBg: '#323239',
          toastText: '#efeff1',
        },
      },
    },

    {
      // Medal is dark only: a near-black 6px popup with a 40%-alpha stroke,
      // 4px of padding, 32px rows and the acid-green brand button.
      id: 'medal',
      hosts: ['medal.tv', 'www.medal.tv'],
      font: 'var(--font-sans, Inter, "Inter Fallback", ui-sans-serif, system-ui, sans-serif)',
      fontSize: 13,
      detect: () => 'dark',
      menu: {
        radius: 6,
        itemRadius: 6,
        itemHeight: 32,
        itemPadX: 10,
        listPadY: 4,
        listPadX: 4,
        weight: 400,
        titleWeight: 500,
        iconSize: 14,
        width: 300,
        badgeRadius: 4,
        buttonRadius: 6,
        buttonHeight: 36,
        buttonWeight: 500,
        buttonFontSize: 14,
      },
      tokens: {
        light: null,
        dark: {
          surface: 'var(--color-neutral-950, #0d0d0e)',
          text: 'var(--color-foreground-0, #ffffff)',
          muted: 'var(--color-foreground-300, #b3b1b6)',
          hover: 'var(--color-neutral-900, #3f3f40)',
          pressed: 'var(--color-neutral-900, #3f3f40)',
          divider: 'rgba(94, 92, 97, .4)',
          border: '1px solid rgba(94, 92, 97, .4)',
          accent: 'var(--color-brand-primary-400, #bff83e)',
          accentText: '#000000',
          accentHover: 'var(--color-brand-primary-500, #98de00)',
          badgeBg: '#3d5914',
          badgeText: 'var(--color-brand-primary-400, #bff83e)',
          ok: 'var(--color-success-400, #26e19e)',
          err: 'var(--color-danger-400, #f6737a)',
          // Medal keeps the brand lime for fills and rings focus in stroke-500
          // at half strength, so a focused row stays quiet.
          focus: 'rgba(94, 92, 97, .5)',
          shadow: '0 4px 6px -1px rgba(0, 0, 0, .4), 0 2px 4px -2px rgba(0, 0, 0, .4)',
          toastBg: 'var(--color-third-layer, #1f1f20)',
          toastText: '#ffffff',
        },
      },
    },

    {
      // X's XDS menu: a squircle when the browser has corner-shape, a 16px
      // radius otherwise, a hairline border, 40px rows and the inverted
      // black/white pill for the primary action.
      id: 'x',
      hosts: ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'],
      font: 'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      fontSize: 15,
      detect: () => {
        const theme = attr('data-theme');
        if (theme === 'dark' || theme === 'light') return theme;
        return modeFromProperty('--x-bg-primary') || canvasMode();
      },
      menu: {
        radius: 16,
        itemRadius: 12,
        itemHeight: 40,
        itemPadX: 12,
        listPadY: 4,
        listPadX: 4,
        weight: 500,
        titleWeight: 700,
        iconSize: 20,
        width: 320,
        badgeRadius: 999,
        buttonRadius: 9999,
        buttonHeight: 36,
        buttonWeight: 700,
        buttonFontSize: 14,
        squircleRadius: 28.8,
        squircleItemRadius: 21.6,
      },
      tokens: {
        light: {
          surface: 'var(--x-bg-modal, #ffffff)',
          text: 'var(--x-fg-primary, #0f141a)',
          muted: 'var(--x-fg-secondary, rgba(0, 0, 0, .6))',
          hover: 'var(--x-hover-subtle, rgba(0, 0, 0, .04))',
          pressed: 'var(--x-btn-ghost-pressed, rgba(0, 0, 0, .15))',
          divider: 'var(--x-border-normal, rgba(0, 0, 0, .15))',
          border: '1px solid var(--x-border-normal, rgba(0, 0, 0, .15))',
          accent: 'var(--x-btn-primary, #0f141a)',
          accentText: 'var(--x-bg-primary, #ffffff)',
          accentHover: 'rgba(15, 20, 26, .8)',
          badgeBg: 'rgba(29, 155, 240, .1)',
          badgeText: 'var(--x-fg-brand, #1d9bf0)',
          ok: 'var(--x-fg-success, #00ba7c)',
          err: 'var(--x-fg-destructive, #f4212e)',
          focus: 'var(--x-ring, #1d9bf0)',
          shadow: 'var(--x-shadow-lg, 0 8px 24px rgba(0, 0, 0, .12))',
          toastBg: 'rgba(34, 34, 34, .85)',
          toastText: '#ffffff',
        },
        dark: {
          surface: 'var(--x-bg-modal, #141414)',
          text: 'var(--x-fg-primary, #e7e9ea)',
          muted: 'var(--x-fg-secondary, rgba(255, 255, 255, .6))',
          hover: 'var(--x-hover-subtle, rgba(255, 255, 255, .08))',
          pressed: 'var(--x-btn-ghost-pressed, rgba(255, 255, 255, .15))',
          divider: 'var(--x-border-normal, rgba(255, 255, 255, .15))',
          border: '1px solid var(--x-border-normal, rgba(255, 255, 255, .15))',
          accent: 'var(--x-btn-primary, #e6e9ea)',
          accentText: 'var(--x-bg-primary, #000000)',
          accentHover: 'rgba(230, 233, 234, .9)',
          badgeBg: 'rgba(29, 155, 240, .14)',
          badgeText: 'var(--x-fg-brand, #1d9bf0)',
          ok: 'var(--x-fg-success, #00ba7c)',
          err: 'var(--x-fg-destructive, #f4212e)',
          focus: 'var(--x-ring, #1d9bf0)',
          shadow: 'var(--x-shadow-lg, 0 8px 24px rgba(0, 0, 0, .6))',
          toastBg: 'rgba(34, 34, 34, .85)',
          toastText: '#ffffff',
        },
      },
    },

    {
      // TikTok's TUX popover: a 16px wrapper with a very soft, very large
      // shadow, 4px of padding, 8px rows and heavy 600-weight labels.
      id: 'tiktok',
      hosts: ['www.tiktok.com', 'tiktok.com', 'm.tiktok.com'],
      font: '"TikTokFont", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      fontSize: 16,
      detect: () => {
        const value = attr('data-theme') || attr('data-tux-color-scheme') || (document.cookie.match(/(?:^|;\s*)tiktok_webapp_theme=(light|dark)/) || [])[1];
        if (value === 'light' || value === 'dark') return value;
        return modeFromProperty('--tux-colorBGPrimary') || canvasMode();
      },
      menu: {
        radius: 16,
        itemRadius: 8,
        itemHeight: 48,
        itemPadX: 16,
        listPadY: 4,
        listPadX: 4,
        weight: 600,
        titleWeight: 700,
        iconSize: 20,
        width: 340,
        badgeRadius: 999,
        buttonRadius: 6,
        buttonHeight: 40,
        buttonWeight: 500,
        buttonFontSize: 15,
      },
      tokens: {
        light: {
          surface: 'var(--tux-colorBGSecondary, #ffffff)',
          text: 'var(--tux-colorTextPrimary, rgb(22, 24, 35))',
          muted: 'var(--ui-text-3, rgba(22, 24, 35, .75))',
          hover: 'var(--ui-shape-neutral-4, rgba(0, 0, 0, .05))',
          pressed: 'var(--ui-shape-neutral-3, rgba(0, 0, 0, .12))',
          divider: 'var(--tux-colorLineSecondary, rgba(22, 24, 35, .12))',
          border: 'none',
          accent: 'var(--ui-shape-primary, #fe2c55)',
          accentText: '#ffffff',
          accentHover: '#ea284e',
          badgeBg: 'rgba(254, 44, 85, .12)',
          badgeText: '#e10543',
          ok: '#008568',
          err: 'var(--ui-text-danger-display, #da3123)',
          focus: '#000000',
          shadow: '0 24px 60px rgba(0, 0, 0, .16)',
          toastBg: 'var(--tux-v2-color-misc-toast-background, #525252)',
          toastText: '#ffffff',
        },
        dark: {
          surface: 'var(--tux-colorBGSecondary, #252525)',
          text: 'var(--tux-colorTextPrimary, rgba(255, 255, 255, .9))',
          muted: 'var(--ui-text-3, rgba(255, 255, 255, .75))',
          hover: 'var(--ui-shape-neutral-4, rgba(255, 255, 255, .13))',
          pressed: 'var(--ui-shape-neutral-3, rgba(255, 255, 255, .19))',
          divider: 'var(--tux-colorLineSecondary, rgba(255, 255, 255, .12))',
          border: 'none',
          accent: 'var(--ui-shape-primary, #fe2c55)',
          accentText: '#ffffff',
          accentHover: '#ea284e',
          badgeBg: 'rgba(254, 44, 85, .34)',
          badgeText: '#ffcdce',
          ok: '#00c39b',
          err: 'var(--ui-text-danger-display, #ff5b48)',
          focus: '#fafafa',
          shadow: '0 24px 60px rgba(0, 0, 0, .16)',
          toastBg: 'var(--tux-v2-color-misc-toast-background, #525252)',
          toastText: '#ffffff',
        },
      },
    },

    {
      // Instagram's anchored popover: a 16px card, no border, a small soft
      // shadow, 8px of top and bottom padding and full-bleed rows with no
      // radius at all.
      id: 'instagram',
      hosts: ['www.instagram.com', 'instagram.com'],
      font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      fontSize: 14,
      detect: () => {
        if (hasClass('__fb-dark-mode')) return 'dark';
        if (hasClass('__fb-light-mode')) return 'light';
        return modeFromProperty('--ig-primary-background', 'rgb(*)') || canvasMode();
      },
      menu: {
        radius: 16,
        itemRadius: 0,
        itemHeight: 48,
        itemPadX: 16,
        listPadY: 8,
        listPadX: 0,
        weight: 400,
        titleWeight: 600,
        iconSize: 24,
        width: 320,
        badgeRadius: 999,
        buttonRadius: 8,
        buttonHeight: 36,
        buttonWeight: 600,
        buttonFontSize: 14,
        toastRadius: 16,
      },
      tokens: {
        light: {
          surface: '#ffffff',
          text: 'rgb(var(--ig-primary-text, 0, 0, 0))',
          muted: 'rgb(var(--ig-secondary-text, 115, 115, 115))',
          hover: 'rgba(var(--ig-hover-overlay, 0, 0, 0, .05))',
          pressed: 'rgba(0, 0, 0, .1)',
          divider: 'rgb(var(--ig-separator, 219, 223, 228))',
          border: 'none',
          accent: 'rgb(var(--ig-colors-button-primary-background, 74, 93, 249))',
          accentText: '#ffffff',
          accentHover: 'rgb(var(--ig-colors-button-primary-background--hover, 65, 80, 247))',
          badgeBg: 'rgba(74, 93, 249, .12)',
          badgeText: '#4a5df9',
          ok: '#58c322',
          err: 'rgb(var(--ig-error-or-destructive, 237, 73, 86))',
          focus: '#4a5df9',
          shadow: '0 4px 12px rgba(0, 0, 0, .15)',
          toastBg: 'rgba(43, 48, 54, .75)',
          toastText: '#ffffff',
        },
        dark: {
          surface: '#262626',
          text: 'rgb(var(--ig-primary-text, 245, 245, 245))',
          muted: 'rgb(var(--ig-secondary-text, 168, 168, 168))',
          hover: 'rgba(var(--ig-hover-overlay, 255, 255, 255, .1))',
          pressed: 'rgba(255, 255, 255, .2)',
          divider: 'rgb(var(--ig-separator, 43, 48, 54))',
          border: 'none',
          accent: 'rgb(var(--ig-colors-button-primary-background, 74, 93, 249))',
          accentText: '#ffffff',
          accentHover: 'rgb(var(--ig-colors-button-primary-background--hover, 65, 80, 247))',
          badgeBg: 'rgba(112, 141, 255, .18)',
          badgeText: '#708dff',
          ok: '#58c322',
          err: 'rgb(var(--ig-error-or-destructive, 237, 73, 86))',
          focus: '#708dff',
          shadow: '0 4px 12px rgba(0, 0, 0, .15)',
          toastBg: 'rgba(43, 48, 54, .75)',
          toastText: '#ffffff',
        },
      },
    },

    {
      // Facebook's card: 8px radius, 8px of padding all round, 44px rows with
      // a 4px hover overlay, and the wide two-part card shadow.
      id: 'facebook',
      hosts: ['www.facebook.com', 'facebook.com', 'web.facebook.com', 'm.facebook.com'],
      font: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Historic", "Segoe UI", Helvetica, Arial, sans-serif',
      fontSize: 15,
      detect: () => {
        if (hasClass('__fb-dark-mode')) return 'dark';
        if (hasClass('__fb-light-mode')) return 'light';
        return modeFromProperty('--card-background') || canvasMode();
      },
      menu: {
        radius: 8,
        itemRadius: 4,
        itemHeight: 44,
        itemPadX: 8,
        listPadY: 8,
        listPadX: 8,
        weight: 500,
        titleWeight: 600,
        iconSize: 20,
        width: 344,
        badgeRadius: 4,
        buttonRadius: 6,
        buttonHeight: 36,
        buttonWeight: 600,
        buttonFontSize: 15,
      },
      tokens: {
        light: {
          surface: 'var(--card-background, #ffffff)',
          text: 'var(--primary-text, #050505)',
          muted: 'var(--secondary-text, #65676b)',
          hover: 'var(--hover-overlay, rgba(0, 0, 0, .05))',
          pressed: 'var(--press-overlay, rgba(0, 0, 0, .1))',
          divider: 'var(--divider, #ced0d4)',
          border: 'none',
          accent: '#0866ff',
          accentText: '#ffffff',
          accentHover: '#0861f2',
          badgeBg: 'rgba(8, 102, 255, .12)',
          badgeText: '#0866ff',
          ok: '#31a24c',
          err: '#f3425f',
          focus: '#0866ff',
          shadow: 'var(--card-box-shadow, 0 12px 28px 0 rgba(0, 0, 0, .2), 0 2px 4px 0 rgba(0, 0, 0, .1))',
          toastBg: 'var(--card-background, #ffffff)',
          toastText: '#1c2b33',
        },
        dark: {
          surface: 'var(--card-background, #242526)',
          text: 'var(--primary-text, #e4e6eb)',
          muted: 'var(--secondary-text, #b0b3b8)',
          hover: 'var(--hover-overlay, rgba(255, 255, 255, .1))',
          pressed: 'var(--press-overlay, rgba(255, 255, 255, .2))',
          divider: 'var(--divider, #3e4042)',
          border: 'none',
          accent: '#0866ff',
          accentText: '#ffffff',
          accentHover: '#2277ff',
          badgeBg: 'rgba(29, 133, 252, .18)',
          badgeText: '#1d85fc',
          ok: '#31a24c',
          err: '#f3425f',
          focus: '#1d85fc',
          shadow: 'var(--card-box-shadow, 0 12px 28px 0 rgba(0, 0, 0, .2), 0 2px 4px 0 rgba(0, 0, 0, .1))',
          toastBg: 'var(--card-background, #242526)',
          toastText: '#ffffff',
        },
      },
    },

    {
      // Snapchat's dropdown: a 6px card with a hairline border, 8px of top and
      // bottom padding, 38px full-bleed rows and the black/white pill.
      id: 'snapchat',
      hosts: ['www.snapchat.com', 'snapchat.com', 'story.snapchat.com'],
      font: '"Avenir Next", -apple-system, BlinkMacSystemFont, Roboto, "Segoe UI", Helvetica, Arial, sans-serif',
      fontSize: 14,
      detect: () => {
        const value = attr('data-theme');
        if (value === 'light' || value === 'dark') return value;
        return modeFromProperty('--page-bg-color') || (prefersDark() ? 'dark' : 'light');
      },
      menu: {
        radius: 6,
        itemRadius: 0,
        itemHeight: 38,
        itemPadX: 16,
        listPadY: 8,
        listPadX: 0,
        weight: 400,
        titleWeight: 700,
        iconSize: 16,
        width: 300,
        badgeRadius: 999,
        buttonRadius: 100,
        buttonHeight: 36,
        buttonWeight: 500,
        buttonFontSize: 14,
      },
      tokens: {
        light: {
          surface: 'var(--page-bg-color, #ffffff)',
          text: 'var(--content-primary-color, #121314)',
          muted: '#53575b',
          hover: 'var(--button-secondary-hover, #e9eaeb)',
          pressed: '#c7c7cc',
          divider: '#e9eaeb',
          border: '1px solid #e9eaeb',
          accent: '#121314',
          accentText: '#ffffff',
          accentHover: '#2a2c2e',
          badgeBg: '#e9eaeb',
          badgeText: '#121314',
          ok: '#157015',
          err: '#f23c57',
          focus: '#0096e5',
          shadow: '0 6px 12px 4px rgba(0, 0, 0, .1)',
          toastBg: '#ffffff',
          toastText: '#121314',
        },
        dark: {
          surface: 'var(--page-bg-color, #121314)',
          text: 'var(--content-primary-color, #ffffff)',
          muted: '#d4d5d6',
          hover: 'var(--button-secondary-hover, #3a3e41)',
          pressed: '#53575b',
          divider: '#3a3e41',
          border: '1px solid #3a3e41',
          accent: '#ffffff',
          accentText: '#121314',
          accentHover: '#e6e6e6',
          badgeBg: '#3a3e41',
          badgeText: '#fffc00',
          ok: '#4ecb4e',
          err: '#f23c57',
          focus: '#fffc00',
          shadow: '0 6px 12px 4px rgba(0, 0, 0, .1)',
          toastBg: '#121314',
          toastText: '#ffffff',
        },
      },
    },
  ];

  const DEFAULT_THEME = THEMES[0];
  const BY_HOST = new Map();
  for (const theme of THEMES) for (const host of theme.hosts) BY_HOST.set(host, theme);

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  /** The theme for a location, or the neutral default for sites we don't know. */
  function forLocation(location) {
    let hostname = '';
    try {
      hostname = String((location || window.location).hostname || '').toLowerCase();
    } catch {
      return DEFAULT_THEME;
    }
    const exact = BY_HOST.get(hostname);
    if (exact) return exact;
    // A subdomain we didn't list (e.g. www.medal.tv vs medal.tv): take the
    // longest registered host that this one ends with.
    let best = null;
    for (const [host, theme] of BY_HOST) {
      if (hostname.endsWith(`.${host}`) && (!best || host.length > best.host.length)) best = { host, theme };
    }
    return best ? best.theme : DEFAULT_THEME;
  }

  // ---------------------------------------------------------------------------
  // Resolving
  // ---------------------------------------------------------------------------

  /**
   * Which of the page's custom properties really exist right now. Our host is
   * a child of <html>, so that is the element whose computed properties it
   * inherits; something defined only on <body> never reaches us.
   */
  function pageProperties() {
    let style = null;
    try {
      style = root() ? getComputedStyle(root()) : null;
    } catch {
      style = null;
    }
    const cache = new Map();
    return (name) => {
      if (!style) return false;
      if (!cache.has(name)) {
        let value = '';
        try {
          value = style.getPropertyValue(name);
        } catch {
          value = '';
        }
        cache.set(name, !!value && value.trim() !== '');
      }
      return cache.get(name);
    };
  }

  /**
   * Keep every var() the page actually defines (so our colours follow the
   * site live) and collapse the rest to their measured fallback. A custom
   * property that exists but is empty makes the declaration invalid at
   * computed-value time, which would paint nothing at all.
   */
  function substituteVars(value, isDefined) {
    if (typeof value !== 'string' || value.indexOf('var(') < 0) return value;
    let out = '';
    let i = 0;
    for (;;) {
      const start = value.indexOf('var(', i);
      if (start < 0) return out + value.slice(i);
      out += value.slice(i, start);
      let depth = 0;
      let end = -1;
      for (let j = start + 3; j < value.length; j++) {
        if (value[j] === '(') depth++;
        else if (value[j] === ')' && --depth === 0) {
          end = j;
          break;
        }
      }
      if (end < 0) return out + value.slice(start); // unbalanced: leave it alone
      const inner = value.slice(start + 4, end);
      const comma = inner.indexOf(',');
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const fallback = substituteVars(comma < 0 ? '' : inner.slice(comma + 1).trim(), isDefined);
      out += isDefined(name) ? `var(${name}, ${fallback})` : fallback;
      i = end + 1;
    }
  }

  /**
   * 'light' | 'dark' for the site, from its own switch. `context.anchor` is
   * the element the UI hangs off, for sites that theme a region differently
   * from the page around it (Twitch's player is dark on a light page).
   */
  function mode(location, context) {
    const theme = forLocation(location);
    const anchor = context && context.anchor;
    if (anchor && theme.forAnchor) {
      try {
        const scoped = theme.forAnchor(anchor);
        if (scoped === 'light' || scoped === 'dark') return scoped;
      } catch {
        /* the site changed its markup: fall through to the page */
      }
    }
    try {
      const value = theme.detect();
      if (value === 'light' || value === 'dark') return value;
    } catch {
      /* the site changed its markup: fall through */
    }
    return canvasMode();
  }

  /**
   * The theme resolved for the mode the site is in right now:
   * { id, mode, font, fontSize, menu, tokens } with every colour ready to use.
   */
  function current(location, context) {
    const theme = forLocation(location);
    const active = mode(location, context);
    const set = theme.tokens[active] || theme.tokens.dark || theme.tokens.light || DEFAULT_THEME.tokens[active];
    // The site's own properties hold the mode the PAGE is in. When we take a
    // different one -- Twitch's player menus stay dark on a light page --
    // following them live would paint a light panel from the dark set, so use
    // the measured colours instead.
    const isDefined = active === mode(location) ? pageProperties() : () => false;
    const tokens = {};
    for (const [key, value] of Object.entries(set)) tokens[key] = substituteVars(value, isDefined);
    return {
      id: theme.id,
      mode: active,
      font: substituteVars(theme.font, isDefined),
      fontSize: theme.fontSize,
      menu: theme.menu,
      tokens,
    };
  }

  // ---------------------------------------------------------------------------
  // CSS custom properties
  // ---------------------------------------------------------------------------

  /**
   * The --jdi-* properties our shadow-root stylesheets are written against.
   * Setting them on one element re-themes everything below it.
   */
  function varsFor(resolved) {
    const t = resolved.tokens;
    const m = resolved.menu;
    const size = resolved.fontSize;
    const soft = Math.min(m.radius, 8);
    return {
      '--jdi-font': resolved.font,
      '--jdi-font-size': `${size}px`,
      '--jdi-font-size-sm': `${Math.max(11, size - 2)}px`,
      '--jdi-font-size-xs': `${Math.max(10, size - 3)}px`,
      '--jdi-title-size': `${Math.min(16, Math.max(13, size))}px`,

      '--jdi-surface': t.surface,
      // Glass surfaces (Apple Music) need something opaque to fall back to
      // when the browser has no backdrop filter or the reader wants contrast.
      '--jdi-surface-solid': t.surfaceSolid || t.surface,
      '--jdi-text': t.text,
      '--jdi-muted': t.muted,
      '--jdi-hover': t.hover,
      '--jdi-pressed': t.pressed,
      '--jdi-divider': t.divider,
      '--jdi-panel-border': t.border,
      // Apple Music rules a hairline between menu rows; everyone else lets the
      // hover band do the separating.
      '--jdi-row-line': t.rowLine || '0',
      // The "Download all" menu opens over the panel, which on most sites is
      // the same surface as the menu itself. Where the site's menus carry no
      // border, a hairline of its own divider colour keeps the two cards apart.
      '--jdi-menu-ring': t.border && t.border !== 'none' ? 'transparent' : t.menuRing || t.divider,
      '--jdi-accent': t.accent,
      '--jdi-accent-text': t.accentText,
      '--jdi-accent-hover': t.accentHover,
      '--jdi-badge-bg': t.badgeBg,
      '--jdi-badge-text': t.badgeText,
      '--jdi-ok': t.ok,
      '--jdi-err': t.err,
      '--jdi-focus': t.focus,
      '--jdi-shadow': t.shadow,
      '--jdi-toast-bg': t.toastBg,
      '--jdi-toast-text': t.toastText,

      '--jdi-radius': `${m.radius}px`,
      '--jdi-soft-radius': `${soft}px`,
      '--jdi-item-radius': `${m.itemRadius}px`,
      '--jdi-item-h': `${m.itemHeight}px`,
      '--jdi-item-px': `${m.itemPadX}px`,
      '--jdi-pad-y': `${m.listPadY}px`,
      '--jdi-pad-x': `${m.listPadX}px`,
      '--jdi-weight': String(m.weight),
      '--jdi-title-weight': String(m.titleWeight),
      '--jdi-icon': `${m.iconSize}px`,
      '--jdi-width': `${m.width}px`,
      '--jdi-badge-radius': `${m.badgeRadius}px`,
      '--jdi-btn-radius': `${m.buttonRadius}px`,
      '--jdi-btn-h': `${m.buttonHeight}px`,
      '--jdi-btn-weight': String(m.buttonWeight),
      '--jdi-btn-size': `${m.buttonFontSize}px`,
      '--jdi-toast-radius': `${m.toastRadius == null ? Math.max(soft, 8) : m.toastRadius}px`,
      '--jdi-blur': m.blur || 'none',

      // Only X ships squircles; everything else keeps plain rounded corners.
      '--jdi-corner-shape': m.squircleRadius ? 'squircle' : 'round',
      '--jdi-radius-sq': `${m.squircleRadius || m.radius}px`,
      '--jdi-item-radius-sq': `${m.squircleItemRadius || m.itemRadius}px`,
    };
  }

  /** Paint an element (a shadow-root wrapper) with a resolved theme. */
  function applyTo(element, resolved) {
    if (!element || !element.style) return null;
    const active = resolved || current();
    for (const [name, value] of Object.entries(varsFor(active))) element.style.setProperty(name, value);
    element.setAttribute('data-theme', active.mode);
    element.setAttribute('data-site', active.id);
    return active;
  }

  // ---------------------------------------------------------------------------
  // Following the site
  // ---------------------------------------------------------------------------

  const watchedAttributes = ['class', 'dark', 'style', 'data-theme', 'data-tux-color-scheme'];
  const listeners = new Set();
  let observer = null;
  let media = null;
  let lastMode = null;

  function announce() {
    const next = mode();
    if (next === lastMode) return;
    lastMode = next;
    for (const listener of Array.from(listeners)) {
      try {
        listener(next);
      } catch {
        /* one bad listener must not stop the others */
      }
    }
  }

  function startWatching() {
    if (observer || !root()) return;
    lastMode = mode();
    observer = new MutationObserver(announce);
    try {
      observer.observe(root(), { attributes: true, attributeFilter: watchedAttributes });
      if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: watchedAttributes });
    } catch {
      /* detached document */
    }
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', announce);
    } catch {
      media = null;
    }
  }

  /**
   * Call back when the site flips between light and dark, so open UI can
   * re-resolve itself. Returns a function that stops listening.
   */
  function observe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    startWatching();
    return () => listeners.delete(listener);
  }

  JDI.themes = { forLocation, current, mode, varsFor, applyTo, observe, canvasMode, list: THEMES };
})();
