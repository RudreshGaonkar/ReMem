// esbuild.js — Bundles the ReMem VS Code extension into a single out/extension.js
// WASM files (sql.js, web-tree-sitter) are copied as static assets and cannot be inlined.

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');
const isProd = process.argv.includes('--production');

// ── Copy WASM assets that the runtime loader resolves by filename ────────────
function copyWasmAssets() {
  const assets = [
    {
      src: 'node_modules/sql.js/dist/sql-wasm.wasm',
      dest: 'out/sql-wasm.wasm',
    },
    {
      src: 'node_modules/web-tree-sitter/tree-sitter.wasm',
      dest: 'out/tree-sitter.wasm',
    },
  ];

  for (const { src, dest } of assets) {
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      console.log(`[esbuild] Copied WASM asset: ${src} → ${dest}`);
    } else {
      console.warn(`[esbuild] WARNING: WASM asset not found: ${src}`);
    }
  }
}

copyWasmAssets();

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: [
    'vscode',       // provided by VS Code host — never bundle
    'fsevents',     // optional macOS native watcher — safe to skip on Linux
  ],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isProd,
  minify: isProd,
  logLevel: 'info',
};

if (isWatch) {
  esbuild.context(buildOptions).then((ctx) => {
    ctx.watch();
    console.log('[esbuild] Watching for changes…');
  });
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
