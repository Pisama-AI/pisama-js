import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformAuth, PlatformAuthError } from '../src/platform-auth.js';

function token(claims: Record<string, unknown>, sequence = 1): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-${sequence}`;
}

test('platform auth rejects redirects for key exchange and protected requests', async () => {
  const rawKey = 'pisama_redirect_boundary_key';
  const redirects: Array<RequestRedirect | undefined> = [];
  const authorizations: Array<string | null> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    redirects.push(init.redirect);
    authorizations.push(new Headers(init.headers).get('authorization'));
    if (String(input).endsWith('/api/v1/auth/token')) {
      assert.deepEqual(JSON.parse(String(init.body)), { api_key: rawKey, scope: 'read' });
      return Response.json({
        access_token: token({ tenant_id: 'tenant-1', scope: 'read' }),
      });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  const auth = new PlatformAuth('https://api.test', rawKey, fetchImpl);

  assert.deepEqual(await auth.identity('read'), { tenantId: 'tenant-1', scope: 'read' });
  await auth.fetch('read', 'https://api.test/api/v1/traces', { redirect: 'follow' });

  assert.deepEqual(redirects, ['error', 'error']);
  assert.deepEqual(authorizations, [
    null,
    `Bearer ${token({ tenant_id: 'tenant-1', scope: 'read' })}`,
  ]);
  assert.ok(authorizations.every((authorization) => authorization !== `Bearer ${rawKey}`));
});

test('platform auth rejects missing, unknown, and insufficient token scopes', async () => {
  const cases = [
    {
      accessToken: token({ tenant_id: 'tenant-1' }),
      expected: /no usable scope/i,
    },
    {
      accessToken: token({ tenant_id: 'tenant-1', scope: 'admin' }),
      expected: /no usable scope/i,
    },
    {
      accessToken: token({ tenant_id: 'tenant-1', scope: 'ingest' }),
      expected: /cannot satisfy read access/i,
    },
  ];

  for (const item of cases) {
    let protectedCalls = 0;
    const auth = new PlatformAuth('https://api.test', 'pisama_scope_boundary_key', (async (
      input: RequestInfo | URL,
    ) => {
      if (String(input).endsWith('/api/v1/auth/token')) {
        return Response.json({ access_token: item.accessToken });
      }
      protectedCalls++;
      return new Response('{}');
    }) as typeof fetch);

    await assert.rejects(
      () => auth.identity('read'),
      (error: unknown) => error instanceof PlatformAuthError && item.expected.test(error.message),
    );
    assert.equal(protectedCalls, 0);
  }
});

test('platform auth concurrent 401s share one refresh without evicting it', async () => {
  let tokenCalls = 0;
  let initialCalls = 0;
  let releaseInitial!: () => void;
  const bothInitialStarted = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const protectedTokens: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input).endsWith('/api/v1/auth/token')) {
      tokenCalls++;
      return Response.json({
        access_token: token({ tenant_id: 'tenant-1', scope: 'read' }, tokenCalls),
      });
    }
    const authorization = new Headers(init.headers).get('authorization') ?? '';
    protectedTokens.push(authorization);
    if (authorization === `Bearer ${token({ tenant_id: 'tenant-1', scope: 'read' }, 1)}`) {
      initialCalls++;
      if (initialCalls === 2) releaseInitial();
      await bothInitialStarted;
      return new Response('expired', { status: 401 });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  const auth = new PlatformAuth('https://api.test', 'pisama_concurrent_key', fetchImpl);

  const responses = await Promise.all([
    auth.fetch('read', 'https://api.test/api/v1/traces/a'),
    auth.fetch('read', 'https://api.test/api/v1/traces/b'),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.equal(tokenCalls, 2);
  assert.deepEqual(protectedTokens, [
    `Bearer ${token({ tenant_id: 'tenant-1', scope: 'read' }, 1)}`,
    `Bearer ${token({ tenant_id: 'tenant-1', scope: 'read' }, 1)}`,
    `Bearer ${token({ tenant_id: 'tenant-1', scope: 'read' }, 2)}`,
    `Bearer ${token({ tenant_id: 'tenant-1', scope: 'read' }, 2)}`,
  ]);
});

test('platform auth bounds an unresolved token exchange even when fetch ignores abort', async () => {
  const auth = new PlatformAuth(
    'https://api.test',
    'pisama_timeout_key',
    (() => new Promise<Response>(() => {})) as typeof fetch,
    20,
  );

  const started = Date.now();
  await assert.rejects(
    () => auth.identity('read'),
    (error: unknown) => {
      assert.ok(error instanceof PlatformAuthError);
      assert.match(error.message, /timed out after 20ms/i);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1_000);
});

test('platform auth bounds a token response body that never finishes', async () => {
  const auth = new PlatformAuth(
    'https://api.test',
    'pisama_timeout_key',
    (async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    20,
  );

  const started = Date.now();
  await assert.rejects(() => auth.identity('read'), /timed out after 20ms/i);
  assert.ok(Date.now() - started < 1_000);
});

test('platform auth bounds a protected response body that never finishes', async () => {
  const auth = new PlatformAuth(
    'https://api.test',
    'pisama_timeout_key',
    (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/v1/auth/token')) {
        return Response.json({
          access_token: token({ tenant_id: 'tenant-1', scope: 'read' }),
        });
      }
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    20,
  );

  const started = Date.now();
  await assert.rejects(
    () => auth.fetch('read', 'https://api.test/api/v1/traces'),
    /timed out after 20ms/i,
  );
  assert.ok(Date.now() - started < 1_000);
});

test('platform auth validates its request timeout', () => {
  assert.throws(
    () => new PlatformAuth('https://api.test', 'pisama_timeout_key', globalThis.fetch, 0),
    /timeoutMs must be a positive finite number/,
  );
});
