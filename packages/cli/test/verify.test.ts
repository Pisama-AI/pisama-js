import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/verify.js';

interface Spy {
  logs: string[];
  errs: string[];
  exitCode: number | null;
  restore: () => void;
}

function spy(): Spy {
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  const s: Spy = {
    logs: [],
    errs: [],
    exitCode: null,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    },
  };
  console.log = (...a: unknown[]) => {
    s.logs.push(a.map(String).join(' '));
  };
  console.error = (...a: unknown[]) => {
    s.errs.push(a.map(String).join(' '));
  };
  // throw a sentinel so we can catch the early-exit
  process.exit = ((code?: number) => {
    s.exitCode = code ?? 0;
    throw new Error('__exit__');
  }) as unknown as typeof process.exit;
  return s;
}

function extractAuthHeader(init?: RequestInit): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.authorization;
}

test('verify fails clearly when no API key is available anywhere', async () => {
  const orig = process.env.PISAMA_API_KEY;
  delete process.env.PISAMA_API_KEY;
  const s = spy();
  try {
    try {
      await verify({ cwd: '/tmp' });
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => /no API key/i.test(l)),
      "expected 'no API key' message",
    );
    assert.ok(
      s.errs.some((l) => /settings\/api-keys/.test(l)),
      'expected a pointer to the dashboard api-keys settings page',
    );
  } finally {
    s.restore();
    if (orig !== undefined) process.env.PISAMA_API_KEY = orig;
  }
});

test('verify happy path: tenant resolved, ingest accepted, trace found on second poll', async () => {
  const originalFetch = globalThis.fetch;
  const seenTraceId: { value?: string } = {};
  let pollCount = 0;
  const authHeaders: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const auth = extractAuthHeader(init);
    if (auth) authHeaders.push(auth);
    if (url.endsWith('/api/v1/auth/me')) {
      return new Response(JSON.stringify({ tenant_id: 'tenant-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/v1/traces/ingest')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      seenTraceId.value = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.traceId;
      return new Response(JSON.stringify({ accepted: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/v1/tenants/') && url.includes('/traces')) {
      pollCount++;
      const traces =
        pollCount >= 2 && seenTraceId.value
          ? [{ trace_id: seenTraceId.value, session_id: null }]
          : [];
      return new Response(JSON.stringify({ traces }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const s = spy();
  try {
    await verify({
      cwd: '/tmp',
      apiKey: 'test-key-123',
      baseUrl: 'https://api.pisama.ai/',
      timeoutMs: 5000,
    });
    assert.equal(s.exitCode, null, 'should not exit on success');
    assert.ok(
      s.logs.some((l) => /tenant-abc/.test(l)),
      'expected tenant id in output',
    );
    assert.ok(
      s.logs.some((l) => /Install is working/.test(l)),
      'expected success message',
    );
    assert.ok(
      s.logs.some((l) => /Dashboard: https:\/\/pisama\.ai\/dashboard/.test(l)),
      'expected the dashboard link',
    );
    assert.ok(
      authHeaders.length >= 3,
      'expected auth header on auth/me, ingest, and poll calls',
    );
    assert.ok(
      authHeaders.every((h) => h === 'Bearer test-key-123'),
      'expected every outbound request to carry the bearer token',
    );
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
});

test('verify happy path via PISAMA_API_KEY env var', async () => {
  const orig = process.env.PISAMA_API_KEY;
  process.env.PISAMA_API_KEY = 'env-key-456';
  const originalFetch = globalThis.fetch;
  const seenTraceId: { value?: string } = {};
  let pollCount = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/me')) {
      const auth = extractAuthHeader(init);
      assert.equal(auth, 'Bearer env-key-456');
      return new Response(JSON.stringify({ tenant_id: 'tenant-env' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/v1/traces/ingest')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      seenTraceId.value = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.traceId;
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }
    if (url.includes('/api/v1/tenants/') && url.includes('/traces')) {
      pollCount++;
      const traces =
        pollCount >= 2 && seenTraceId.value
          ? [{ trace_id: seenTraceId.value, session_id: null }]
          : [];
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const s = spy();
  try {
    await verify({ cwd: '/tmp', baseUrl: 'https://api.pisama.ai/', timeoutMs: 5000 });
    assert.equal(s.exitCode, null, 'should not exit on success');
    assert.ok(s.logs.some((l) => /Install is working/.test(l)));
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
    if (orig !== undefined) process.env.PISAMA_API_KEY = orig;
    else delete process.env.PISAMA_API_KEY;
  }
});

test('verify fails when auth/me returns 401', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/me')) {
      return new Response('unauthorized', { status: 401 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const s = spy();
  try {
    try {
      await verify({ cwd: '/tmp', apiKey: 'bad-key', baseUrl: 'https://test', timeoutMs: 5000 });
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => /API key rejected/.test(l)),
      'expected API key rejected message',
    );
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
});

test('verify fails when ingest returns 401', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/me')) {
      return new Response(JSON.stringify({ tenant_id: 'tenant-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/v1/traces/ingest')) {
      return new Response('unauthorized', { status: 401 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const s = spy();
  try {
    try {
      await verify({ cwd: '/tmp', apiKey: 'bad-key', baseUrl: 'https://test', timeoutMs: 5000 });
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => /rejected the API key/.test(l)),
      'expected ingest-rejected-key message',
    );
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
});

test('verify fails when ingest returns 404 naming the endpoint and self-hosted deployments', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/me')) {
      return new Response(JSON.stringify({ tenant_id: 'tenant-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/v1/traces/ingest')) {
      return new Response('not found', { status: 404 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const s = spy();
  try {
    try {
      await verify({ cwd: '/tmp', apiKey: 'k', baseUrl: 'https://test', timeoutMs: 5000 });
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => /api\/v1\/traces\/ingest/.test(l)),
      'expected the ingest endpoint path named in the error',
    );
    assert.ok(
      s.errs.some((l) => /self-hosted/i.test(l)),
      'expected a mention of self-hosted deployments',
    );
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
});

test('verify fails when ingest returns 502', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/me')) {
      return new Response(JSON.stringify({ tenant_id: 'tenant-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/v1/traces/ingest')) {
      return new Response('server error', { status: 502 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const s = spy();
  try {
    try {
      await verify({ cwd: '/tmp', apiKey: 'k', baseUrl: 'https://test', timeoutMs: 5000 });
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => /HTTP 502/.test(l)),
      'expected HTTP 502 in error',
    );
    assert.ok(
      s.errs.some((l) => /https:\/\/test\/api\/v1\/health/.test(l)),
      'expected the configured API health endpoint in the error',
    );
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
});

test('verify reports the configured health endpoint when the ingest endpoint is unreachable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/me')) {
      return new Response(JSON.stringify({ tenant_id: 'tenant-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/v1/traces/ingest')) {
      throw new Error('connect ECONNREFUSED');
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const s = spy();
  try {
    try {
      await verify({
        cwd: '/tmp',
        apiKey: 'k',
        baseUrl: 'https://test',
        timeoutMs: 100,
      });
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => /cannot reach the configured API/.test(l)),
      'expected a host-neutral connectivity error',
    );
    assert.ok(
      s.errs.some((l) => /https:\/\/test\/api\/v1\/health/.test(l)),
      'expected the configured API health endpoint',
    );
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
});

test('verify fails when trace never lands within timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/me')) {
      return new Response(JSON.stringify({ tenant_id: 'tenant-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/v1/traces/ingest')) {
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }
    if (url.includes('/api/v1/tenants/') && url.includes('/traces')) {
      return new Response(JSON.stringify({ traces: [] }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const s = spy();
  try {
    try {
      await verify({ cwd: '/tmp', apiKey: 'k', baseUrl: 'https://test', timeoutMs: 1500 });
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => /didn't appear/.test(l)),
      "expected 'didn't appear' in error",
    );
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
});

test('verify sends a structurally valid OTLP payload', async () => {
  const originalFetch = globalThis.fetch;
  let capturedSpan: Record<string, unknown> | undefined;
  let capturedResourceSpans: unknown;
  let pollCount = 0;
  let seenTraceId: string | undefined;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/me')) {
      return new Response(JSON.stringify({ tenant_id: 'tenant-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/v1/traces/ingest')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      capturedResourceSpans = body.resourceSpans;
      capturedSpan = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
      seenTraceId = capturedSpan?.traceId as string | undefined;
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }
    if (url.includes('/api/v1/tenants/') && url.includes('/traces')) {
      pollCount++;
      const traces = pollCount >= 2 && seenTraceId ? [{ trace_id: seenTraceId }] : [];
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const s = spy();
  try {
    await verify({ cwd: '/tmp', apiKey: 'k', baseUrl: 'https://api.pisama.ai/', timeoutMs: 5000 });
    assert.equal(s.exitCode, null);
    assert.ok(Array.isArray(capturedResourceSpans), 'resourceSpans should be an array');
    assert.ok((capturedResourceSpans as unknown[]).length > 0, 'resourceSpans should be non-empty');
    assert.ok(capturedSpan, 'expected a captured span');
    assert.match(String(capturedSpan?.traceId), /^[0-9a-f]{32}$/);
    assert.match(String(capturedSpan?.spanId), /^[0-9a-f]{16}$/);
    const start = String(capturedSpan?.startTimeUnixNano);
    const end = String(capturedSpan?.endTimeUnixNano);
    assert.match(start, /^\d+$/);
    assert.match(end, /^\d+$/);
    assert.ok(BigInt(end) > BigInt(start), 'end time should be after start time');
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
});
