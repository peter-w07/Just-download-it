// Test helpers for run.mjs, injected into a page next to the extension's own
// content scripts (Firefox runs all of an extension's content scripts in one
// sandbox, so these see globalThis.JDI). Only the test copy of the build has
// this file. Extension pages can't eval, so the test calls these by name.
(() => {
  'use strict';

  /** The quality picker, read through its closed shadow root (Firefox's openOrClosedShadowRoot). */
  function pickerState() {
    const host = document.querySelector('jdi-root');
    const shadow = host && host.openOrClosedShadowRoot;
    const panel = shadow && shadow.querySelector('.panel');
    if (!panel) return { open: false };
    return {
      open: true,
      loading: !!panel.querySelector('.state .spinner'),
      error: (panel.querySelector('.state.error') || {}).textContent || '',
      title: (panel.querySelector('.title') || {}).textContent || '',
      rows: Array.from(panel.querySelectorAll('.row')).map((row) => (row.querySelector('.label') || {}).textContent),
    };
  }

  /** Where to click a page Download button: the middle of the button in its shadow root, or null. */
  function buttonPoint() {
    for (const host of document.querySelectorAll('jdi-button')) {
      const shadow = host.openOrClosedShadowRoot;
      const button = shadow && shadow.querySelector('button');
      const r = button && button.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    return null;
  }

  function ready() {
    return !!(globalThis.JDI && JDI.core);
  }

  /** How many times content/core.js ran in this page (the test build counts them). */
  function coreRuns() {
    return globalThis.__jdiCoreRuns || 0;
  }

  /** A small image in the page, and where to right-click it. */
  function addImage() {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    const g = canvas.getContext('2d');
    g.fillStyle = '#2f6bff';
    g.fillRect(0, 0, 320, 200);
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    img.id = 'jdi-test-image';
    img.style.cssText = 'position:fixed;left:40px;top:40px;width:320px;height:200px;z-index:9';
    document.body.append(img);
    return { x: 200, y: 140, src: img.src };
  }

  /** A small PNG made here and saved like a screenshot (JDI.core.saveBlob). */
  async function savePng(base) {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 30;
    canvas.getContext('2d').fillRect(0, 0, 40, 30);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return JDI.core.saveBlob(blob, { site: 'Captures', base, ext: 'png' });
  }

  /** Ask the extension to save an inline (data:) image, the way the generic handler's picks are. */
  function saveDataUrl(base) {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    return chrome.runtime.sendMessage({ type: 'jdi:download', site: 'Example', batch: `t${Date.now()}`, files: [{ url: png, filename: base, ext: 'png' }] });
  }

  globalThis.JDI_TEST = { pickerState, buttonPoint, ready, coreRuns, addImage, savePng, saveDataUrl };
})();
