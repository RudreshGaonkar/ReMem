// esbuild.js — Bundles the Cuttlehawk VS Code extension into a single out/extension.js
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
      throw new Error(`Required WASM asset missing: ${src}`);
    }
  }
}

copyWasmAssets();

const mcpOnly = process.argv.includes('--mcp');
const buildOptions = {
  entryPoints: mcpOnly
    ? { 'cuttlehawk-mcp': 'src/mcp/server.ts', 'storage-worker': 'src/database/storageWorker.ts' }
    : { extension: 'src/extension.ts', 'cuttlehawk-mcp': 'src/mcp/server.ts', 'storage-worker': 'src/database/storageWorker.ts' },
  bundle: true,
  outdir: 'out',
  external: ['vscode', 'fsevents'],
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
  target: 'node18',
  define: { CUTTLEHAWK_VERSION: JSON.stringify(require('./package.json').version) },
  sourcemap: !isProd,
  minify: isProd,
  logLevel: 'warning',
  metafile: true,
  plugins: [{
    name: 'verify-headless-entry',
    setup(build) {
      build.onEnd((result) => {
        const mcp = result.metafile?.outputs['out/cuttlehawk-mcp.js'];
        if (mcp?.imports.some((entry) => entry.path === 'vscode')) {
          return { errors: [{ text: 'The MCP bundle must be independent of the editor API.' }] };
        }
        if (mcp) fs.chmodSync('out/cuttlehawk-mcp.js', 0o755);
      });
    },
  }],
};

async function main() {
  if (isWatch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
  } else {
    await esbuild.build(buildOptions);
  }
}

main().catch(() => { process.exitCode = 1; });
