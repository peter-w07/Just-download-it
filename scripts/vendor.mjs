// Bundles the media libraries the offscreen document uses into
// extension/vendor/, so the extension itself needs no build step.
// Run after updating a dependency: npm run vendor
//
// Output:
//   vendor/media.mjs                 Mediabunny + its MP3 encoder, one ES module
//   vendor/mp3-encoder.worker.js     the encoder's worker, as a real file
//   vendor/mediabunny.LICENSE.txt
//   vendor/gifenc.mjs                the GIF encoder used for page recordings
//   vendor/gifenc.LICENSE.txt
//
// Why the worker is split out: the MP3 encoder normally starts its worker from
// a blob: URL, which an extension's Content Security Policy doesn't allow.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'extension', 'vendor');
const modules = join(root, 'node_modules');
mkdirSync(vendor, { recursive: true });
rmSync(join(vendor, 'mediabunny.min.mjs'), { force: true });

const WORKER_FILE = 'mp3-encoder.worker.js';

/** Pull the worker source out of `inlineWorker('...')` and load it from a file instead. */
const splitWorker = {
  name: 'split-mp3-worker',
  setup(b) {
    b.onLoad({ filter: /mediabunny-mp3-encoder\.m?js$/ }, (args) => {
      const code = readFileSync(args.path, 'utf8');
      const marker = 'return inlineWorker(';
      const start = code.indexOf(marker);
      if (start < 0) throw new Error('mp3-encoder layout changed: inlineWorker(...) call not found');
      const literalStart = start + marker.length;
      const quote = code[literalStart];
      if (quote !== "'" && quote !== '"' && quote !== '`') throw new Error('mp3-encoder layout changed: worker source is not a string literal');
      // Find the closing quote, honouring escapes.
      let i = literalStart + 1;
      while (i < code.length && code[i] !== quote) i += code[i] === '\\' ? 2 : 1;
      const literal = code.slice(literalStart, i + 1);
      const workerSource = vm.runInNewContext(literal);
      writeFileSync(join(vendor, WORKER_FILE), workerSource);
      const replaced =
        code.slice(0, start) +
        `return new Worker(new URL('./${WORKER_FILE}', import.meta.url))` +
        code.slice(code.indexOf(')', i) + 1);
      return { contents: replaced, loader: 'js' };
    });
  },
};

await build({
  stdin: {
    contents: "export * from 'mediabunny';\nexport { registerMp3Encoder } from '@mediabunny/mp3-encoder';\n",
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'chrome120',
  platform: 'browser',
  outfile: join(vendor, 'media.mjs'),
  plugins: [splitWorker],
  legalComments: 'inline',
  logLevel: 'warning',
});

const license = readFileSync(join(modules, 'mediabunny', 'LICENSE'), 'utf8');
writeFileSync(join(vendor, 'mediabunny.LICENSE.txt'), license);
const { version } = JSON.parse(readFileSync(join(modules, 'mediabunny', 'package.json'), 'utf8'));
const mp3 = JSON.parse(readFileSync(join(modules, '@mediabunny', 'mp3-encoder', 'package.json'), 'utf8')).version;
console.log(`vendored mediabunny ${version} + @mediabunny/mp3-encoder ${mp3}`);

// gifenc (MIT, Matt DesLauriers): GIF recordings of a tab (offscreen/recorder.js).
const gifencVersion = JSON.parse(readFileSync(join(modules, 'gifenc', 'package.json'), 'utf8')).version;
await build({
  stdin: {
    contents: "export { GIFEncoder, quantize, applyPalette } from 'gifenc';\n",
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'chrome120',
  platform: 'browser',
  // Its "browser" field points at a CommonJS build; the ES module one bundles cleaner.
  mainFields: ['module', 'main'],
  outfile: join(vendor, 'gifenc.mjs'),
  banner: { js: `/*! gifenc ${gifencVersion} | MIT License | Copyright (c) 2017 Matt DesLauriers | gifenc.LICENSE.txt */` },
  legalComments: 'inline',
  logLevel: 'warning',
});
writeFileSync(join(vendor, 'gifenc.LICENSE.txt'), readFileSync(join(modules, 'gifenc', 'LICENSE.md'), 'utf8'));
console.log(`vendored gifenc ${gifencVersion}`);

