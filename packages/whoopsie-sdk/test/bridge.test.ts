import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('SDK retirement artifact is a declared successor bridge with legacy aliases', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: string;
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.equal(manifest.version, '0.9.0');
  assert.deepEqual(manifest.dependencies, { '@pisama/sdk': 'workspace:0.10.2' });
  assert.equal(
    readFileSync(join(root, 'index.js'), 'utf8').trim(),
    "export * from '@pisama/sdk';\n" +
      "export { pisamaMiddleware as whoopsieMiddleware } from '@pisama/sdk';",
  );
  assert.equal(
    readFileSync(join(root, 'index.d.ts'), 'utf8').trim(),
    "export * from '@pisama/sdk';\n" +
      "export { pisamaMiddleware as whoopsieMiddleware } from '@pisama/sdk';\n" +
      "export type { PisamaMiddlewareOptions as WhoopsieMiddlewareOptions } from '@pisama/sdk';",
  );
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    assert.equal(manifest.scripts?.[lifecycle], undefined);
  }
});

test('SDK bridge ships no endpoint, credential, or network implementation', () => {
  const source = readFileSync(join(root, 'index.js'), 'utf8');
  assert.ok(
    !/\/api\/v1\/spans|https?:|fetch\(|XMLHttpRequest|WebSocket|node:http|node:https/.test(source),
  );
});
