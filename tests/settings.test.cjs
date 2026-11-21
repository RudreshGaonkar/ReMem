const assert = require('node:assert/strict');
const { test } = require('node:test');
const { transformSync } = require('esbuild');
const { readFileSync } = require('node:fs');

const source = readFileSync(require.resolve('../src/context/security.ts'), 'utf8');
const compiled = { exports: {} };
new Function('module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(compiled, compiled.exports);
const { resolveZeroFluffMode } = compiled.exports;

test('Zero Fluff inherits an enabled ReMem setting when Cuttlehawk is unset', () => {
  assert.equal(resolveZeroFluffMode({ defaultValue: false }, false, true), true);
  assert.equal(resolveZeroFluffMode({ defaultValue: false }, false, undefined), false);
});

test('explicit Cuttlehawk Zero Fluff settings override ReMem, including false', () => {
  for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue']) {
    assert.equal(resolveZeroFluffMode({ defaultValue: true, [scope]: false }, false, true), false);
  }
  assert.equal(resolveZeroFluffMode({ globalValue: false, workspaceFolderValue: true }, true, false), true);
});
