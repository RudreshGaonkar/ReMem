const { spawnSync } = require('node:child_process');
const { name, version } = require('../package.json');

const result = spawnSync(process.env.REMEM_IDE_COMMAND || 'antigravity-ide', [
  '--install-extension', `${name}-${version}.vsix`, '--force',
], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
