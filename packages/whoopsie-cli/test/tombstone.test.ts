import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

test('retired CLI always fails closed with no network attempt', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'whoopsie-cli-retired-'));
  const sentinel = join(temporary, 'network-attempted');
  try {
    for (const args of [[], ['verify'], ['mcp'], ['init'], ['--help']]) {
      const result = spawnSync(
        process.execPath,
        ['--require', join(here, 'forbid-network.cjs'), join(root, 'dist/bin.js'), ...args],
        {
          encoding: 'utf8',
          env: { ...process.env, WHOOPSIE_NETWORK_SENTINEL: sentinel },
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /@whoopsie\/cli is retired/);
      assert.match(result.stderr, /@pisama\/cli@0\.11\.3/);
      assert.equal(existsSync(sentinel), false);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('retirement package has no dependencies, install lifecycle, or legacy transport', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: string;
    dependencies?: unknown;
    scripts?: Record<string, string>;
  };
  assert.equal(manifest.version, '0.9.0');
  assert.equal(manifest.dependencies, undefined);
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    assert.equal(manifest.scripts?.[lifecycle], undefined);
  }
  const shippedSource = readFileSync(join(root, 'dist/bin.js'), 'utf8');
  assert.ok(!/\/api\/v1\/spans|fetch\(|node:https|node:http/.test(shippedSource));
});
