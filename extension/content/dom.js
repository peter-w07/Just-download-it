/*
 * Just download it: DOM helpers shared by the site handlers.
 */
(() => {
  'use strict';

  const JDI = (globalThis.JDI = globalThis.JDI || {});

  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'AUDIO']);

  /**
   * document.elementsFromPoint, but also looks inside open shadow roots
   * (sites built from web components hide their <video> in one).
   * Topmost element first.
   */
  function deepElementsFromPoint(x, y, root = document, depth = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || typeof root.elementsFromPoint !== 'function') return [];
    const out = [];
    for (const node of root.elementsFromPoint(x, y)) {
      if (node.shadowRoot && depth < 4) {
        for (const inner of deepElementsFromPoint(x, y, node.shadowRoot, depth + 1)) {
          if (inner !== node && !out.includes(inner)) out.push(inner);
        }
      }
      if (!out.includes(node)) out.push(node);
    }
    return out;
  }

  function containsPoint(node, x, y) {
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function isRendered(node) {
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  /**
   * Media elements under the point, topmost first. Checks the hit-test stack
   * first, then (for media hidden behind overlays or with pointer-events:none)
   * searches a few ancestors of the topmost elements for media covering the point.
   */
  function findMediaAt(stack, x, y) {
    const found = [];
    const add = (node) => {
      if (!found.includes(node)) found.push(node);
    };
    for (const node of stack || []) if (MEDIA_TAGS.has(node.tagName)) add(node);
    if (found.length || !Number.isFinite(x) || !Number.isFinite(y)) return found;

    for (const start of (stack || []).slice(0, 3)) {
      let node = start;
      for (let depth = 0; node && depth < 6 && node !== document.documentElement; depth++) {
        for (const m of node.querySelectorAll('img, video, audio')) {
          if (containsPoint(m, x, y) && isRendered(m)) add(m);
        }
        if (found.length) return found;
        node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      }
    }
    return found;
  }

  /** The first CSS background image on the stack (or a close ancestor). */
  function findBackgroundImage(stack) {
    const seen = new Set();
    for (const start of (stack || []).slice(0, 4)) {
      let node = start;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        if (seen.has(node)) break;
        seen.add(node);
        const bg = getComputedStyle(node).backgroundImage;
        const m = bg && /url\((['"]?)(.*?)\1\)/.exec(bg);
        if (m && m[2] && !m[2].startsWith('data:image/svg')) {
          try {
            return new URL(m[2], document.baseURI).href;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return '';
  }

  function metaContent(...names) {
    for (const name of names) {
      const node = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      const value = node && node.getAttribute('content');
      if (value) {
        try {
          return new URL(value, document.baseURI).href;
        } catch {
          /* ignore */
        }
      }
    }
    return '';
  }

  JDI.dom = { deepElementsFromPoint, containsPoint, isRendered, findMediaAt, findBackgroundImage, metaContent };
})();
