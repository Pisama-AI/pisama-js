import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { _resetClientIdCache, detectRuntime, getClientId } from '../src/client-id.js';
import { redactObject, redactText } from '../src/redact.js';

test('client id persists with owner-only permissions and survives cache reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pisama-client-id-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  _resetClientIdCache();

  try {
    const first = getClientId();
    const cached = getClientId();
    _resetClientIdCache();
    const persisted = getClientId();
    const payload = JSON.parse(await readFile(join(root, '.pisama', 'client.json'), 'utf8')) as {
      client_id: string;
      created_at: string;
    };

    assert.match(first, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(cached, first);
    assert.equal(persisted, first);
    assert.equal(payload.client_id, first);
    assert.ok(Number.isFinite(Date.parse(payload.created_at)));
    assert.equal(detectRuntime(), 'node');
  } finally {
    _resetClientIdCache();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('standard redaction removes supported secret and identity patterns', () => {
  const value = [
    'person@example.com',
    '+1 415-555-0100',
    '123-45-6789',
    '4111 1111 1111 1111',
    'eyJabcdefghijk.abcdefghijk.abcdefghijk',
    `sk-${'a'.repeat(24)}`,
    `sk-ant-${'b'.repeat(24)}`,
    'AKIA1234567890ABCDEF',
    `ghp_${'c'.repeat(36)}`,
    'xoxb-1234567890-token',
  ].join(' ');

  const redacted = redactText(value);

  for (const replacement of [
    '[email]',
    '[phone]',
    '[ssn]',
    '[card]',
    '[jwt]',
    '[openai-key]',
    '[anthropic-key]',
    '[aws-key]',
    '[github-pat]',
    '[slack-token]',
  ]) {
    assert.match(redacted, new RegExp(`\\${replacement}`));
  }
});

test('aggressive and object redaction preserve structure without leaking values', () => {
  const input = {
    owner: 'Ada Lovelace',
    endpoint: 'https://example.com/private',
    addresses: ['192.168.1.20', 'ops@example.com'],
    count: 2,
  };

  assert.deepEqual(redactObject(input, 'aggressive'), {
    owner: '[name]',
    endpoint: '[url]',
    addresses: ['[ip]', '[email]'],
    count: 2,
  });
  assert.equal(redactText('unchanged', 'off'), 'unchanged');
  assert.equal(redactText('hidden', 'metadata-only'), '[redacted]');
  assert.equal(redactObject(input, 'off'), input);
  assert.equal(redactObject(input, 'metadata-only'), undefined);
});
