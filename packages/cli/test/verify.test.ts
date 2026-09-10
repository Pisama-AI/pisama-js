import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseVerifyTimeout, verify } from '../src/verify.js';

interface Spy {
  logs: string[];
  errs: string[];
  exitCode: number | null;
  restore: () => void;
}

interface CapturedRequest {
  url: string;
  method: string;
  authorization?: string;
  requestId?: string;
  body: unknown;
}

interface PlatformOptions {
  tokenStatus?: number;
  ingestStatus?: number;
  ingest401s?: number;
  read401s?: number;
  neverLand?: boolean;
  ingestThrows?: boolean;
  ingestBody?: unknown;
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
  console.log = (...args: unknown[]) => s.logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => s.errs.push(args.map(String).join(' '));
  process.exit = ((code?: number) => {
    s.exitCode = code ?? 0;
    throw new Error('__exit__');
  }) as unknown as typeof process.exit;
  return s;
}

function token(tenantId: string, scope: string, sequence: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ tenant_id: tenantId, scope })).toString('base64url');
  return `${header}.${payload}.token-${scope}-${sequence}`;
}

function installPlatform(options: PlatformOptions = {}) {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  const tokenCounts = new Map<string, number>();
  let seenTraceId: string | undefined;
  let pollCount = 0;
  let ingest401s = options.ingest401s ?? 0;
  let read401s = options.read401s ?? 0;

  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    let body: unknown;
    try {
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init.body;
    }
    requests.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      requestId: headers.get('x-request-id') ?? undefined,
      body,
    });

    if (url.endsWith('/api/v1/auth/token')) {
      if (options.tokenStatus) return new Response('', { status: options.tokenStatus });
      const scope = String((body as { scope?: unknown })?.scope ?? '');
      const count = (tokenCounts.get(scope) ?? 0) + 1;
      tokenCounts.set(scope, count);
      return Response.json({ access_token: token('tenant-abc', scope, count) });
    }
    if (url.endsWith('/api/v1/traces/ingest')) {
      if (options.ingestThrows) throw new Error('connect ECONNREFUSED');
      if (ingest401s > 0) {
        ingest401s--;
        return new Response('expired', { status: 401 });
      }
      const otlp = body as {
        resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ traceId?: string }> }> }>;
      };
      seenTraceId = otlp.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.traceId;
      return Response.json(
        options.ingestBody === undefined
          ? { accepted: 1, submitted: 1, rejected: 0, duplicates: 0, traces: 1 }
          : options.ingestBody,
        { status: options.ingestStatus ?? 202 },
      );
    }
    if (url.includes('/api/v1/tenants/') && url.includes('/traces')) {
      if (read401s > 0) {
        read401s--;
        return new Response('expired', { status: 401 });
      }
      pollCount++;
      const landed = !options.neverLand && pollCount >= 2 && seenTraceId;
      const id = landed
        ? seenTraceId?.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5')
        : undefined;
      return Response.json({ traces: id ? [{ id }] : [] });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  return {
    requests,
    tokenCounts,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function expectExit(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.equal((error as Error).message, '__exit__');
  }
}

function hangingResponse(status = 200): Response {
  return new Response(
    new ReadableStream({
      start() {
        // Intentionally never enqueue or close: exercises the total body deadline.
      },
    }),
    { status },
  );
}

test('verify normalises a positive finite timeout and rejects unsafe values', () => {
  assert.equal(normaliseVerifyTimeout(1.9), 1);
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    assert.throws(() => normaliseVerifyTimeout(value), /--timeout-ms must be between/);
  }
});

for (const hangAt of [
  'token fetch',
  'token body',
  'ingest fetch',
  'ingest body',
  'poll fetch',
  'poll body',
] as const) {
  test(`verify total deadline bounds a hanging ${hangAt}`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/api/v1/auth/token')) {
        if (hangAt === 'token fetch') return new Promise<Response>(() => {});
        if (hangAt === 'token body') return hangingResponse();
        const body = JSON.parse(String(init.body)) as { scope?: string };
        return Response.json({ access_token: token('tenant-abc', body.scope ?? 'read', 1) });
      }
      if (url.endsWith('/api/v1/traces/ingest')) {
        if (hangAt === 'ingest fetch') return new Promise<Response>(() => {});
        if (hangAt === 'ingest body') return hangingResponse(202);
        return Response.json(
          { accepted: 1, submitted: 1, rejected: 0, duplicates: 0, traces: 1 },
          { status: 202 },
        );
      }
      if (url.includes('/api/v1/tenants/') && url.includes('/traces')) {
        if (hangAt === 'poll fetch') return new Promise<Response>(() => {});
        if (hangAt === 'poll body') return hangingResponse();
        return Response.json({ traces: [] });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const s = spy();
    const started = Date.now();
    try {
      await expectExit(() =>
        verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 25 }),
      );
      assert.equal(s.exitCode, 1);
      assert.ok(Date.now() - started < 1_000, `${hangAt} exceeded the bounded deadline`);
    } finally {
      s.restore();
      globalThis.fetch = originalFetch;
    }
  });
}

test('verify shares one deadline across sequential authentication stages', async () => {
  const originalFetch = globalThis.fetch;
  let protectedIngestCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/token')) {
      const body = JSON.parse(String(init.body)) as { scope?: string };
      await new Promise((resolve) => setTimeout(resolve, 70));
      return Response.json({ access_token: token('tenant-abc', body.scope ?? 'read', 1) });
    }
    if (url.endsWith('/api/v1/traces/ingest')) protectedIngestCalls += 1;
    return Response.json({ accepted: 1 }, { status: 202 });
  }) as typeof fetch;
  const s = spy();
  const started = Date.now();
  try {
    await expectExit(() =>
      verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 100 }),
    );
    assert.equal(s.exitCode, 1);
    assert.equal(protectedIngestCalls, 0, 'ingest must not start after the total deadline expires');
    assert.ok(Date.now() - started < 500);
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
});

test('verify fails clearly when no API key is available anywhere', async () => {
  const original = process.env.PISAMA_API_KEY;
  delete process.env.PISAMA_API_KEY;
  const s = spy();
  try {
    await expectExit(() => verify({ cwd: '/tmp' }));
    assert.equal(s.exitCode, 1);
    assert.ok(s.errs.some((line) => /no API key/i.test(line)));
    assert.ok(s.errs.some((line) => /settings\/api-keys/.test(line)));
  } finally {
    s.restore();
    if (original !== undefined) process.env.PISAMA_API_KEY = original;
  }
});

test('verify exchanges scoped JWTs, caches them, and never uses the raw key as bearer', async () => {
  const platform = installPlatform();
  const s = spy();
  const rawKey = 'pisama_raw_secret_test';
  try {
    await verify({
      cwd: '/tmp',
      apiKey: rawKey,
      baseUrl: 'https://api.pisama.ai/',
      timeoutMs: 5000,
    });
    assert.equal(s.exitCode, null);
    assert.ok(s.logs.some((line) => /tenant-abc/.test(line)));
    assert.ok(s.logs.some((line) => /Install is working/.test(line)));
    assert.ok(s.logs.some((line) => /https:\/\/pisama\.ai\/dashboard/.test(line)));
    assert.equal(platform.tokenCounts.get('read'), 1, 'read JWT is cached across both polls');
    assert.equal(platform.tokenCounts.get('ingest'), 1);
    assert.equal(
      platform.requests.some((request) => request.url.endsWith('/api/v1/auth/me')),
      false,
      'dashboard-only auth/me must not be used for API-key identity',
    );
    for (const request of platform.requests) {
      assert.notEqual(request.authorization, `Bearer ${rawKey}`);
      if (request.url.endsWith('/api/v1/auth/token')) {
        assert.equal(request.authorization, undefined);
        assert.equal((request.body as { api_key?: string }).api_key, rawKey);
      }
    }
    const ingest = platform.requests.find((request) =>
      request.url.endsWith('/api/v1/traces/ingest'),
    );
    assert.match(ingest?.authorization ?? '', /^Bearer .+\.token-ingest-1$/);
    assert.match(ingest?.requestId ?? '', /^pisama-cli-[0-9a-f]{24}$/);
  } finally {
    s.restore();
    platform.restore();
  }
});

test('verify reads PISAMA_API_KEY from the environment', async () => {
  const original = process.env.PISAMA_API_KEY;
  process.env.PISAMA_API_KEY = 'pisama_env_key';
  const platform = installPlatform();
  const s = spy();
  try {
    await verify({ cwd: '/tmp', baseUrl: 'https://api.pisama.ai', timeoutMs: 5000 });
    assert.equal(s.exitCode, null);
    assert.ok(
      platform.requests
        .filter((request) => request.url.endsWith('/api/v1/auth/token'))
        .every((request) => (request.body as { api_key?: string }).api_key === 'pisama_env_key'),
    );
  } finally {
    s.restore();
    platform.restore();
    if (original !== undefined) process.env.PISAMA_API_KEY = original;
    else delete process.env.PISAMA_API_KEY;
  }
});

test('verify fails clearly when API-key exchange is rejected', async () => {
  const platform = installPlatform({ tokenStatus: 401 });
  const s = spy();
  try {
    await expectExit(() =>
      verify({ cwd: '/tmp', apiKey: 'bad-key', baseUrl: 'https://test', timeoutMs: 100 }),
    );
    assert.equal(s.exitCode, 1);
    assert.ok(s.errs.some((line) => /API key rejected/.test(line)));
  } finally {
    s.restore();
    platform.restore();
  }
});

test('verify re-exchanges once on ingest 401 and reuses exact payload and request id', async () => {
  const platform = installPlatform({ ingest401s: 1 });
  const s = spy();
  try {
    await verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 5000 });
    assert.equal(s.exitCode, null);
    assert.equal(platform.tokenCounts.get('ingest'), 2);
    const attempts = platform.requests.filter((request) =>
      request.url.endsWith('/api/v1/traces/ingest'),
    );
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1]?.body, attempts[0]?.body);
    assert.equal(attempts[1]?.requestId, attempts[0]?.requestId);
    assert.notEqual(attempts[1]?.authorization, attempts[0]?.authorization);
  } finally {
    s.restore();
    platform.restore();
  }
});

test('verify stops after one re-exchange when ingest keeps returning 401', async () => {
  const platform = installPlatform({ ingest401s: 99 });
  const s = spy();
  try {
    await expectExit(() =>
      verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 100 }),
    );
    assert.equal(s.exitCode, 1);
    assert.equal(platform.tokenCounts.get('ingest'), 2);
    assert.equal(
      platform.requests.filter((request) => request.url.endsWith('/api/v1/traces/ingest')).length,
      2,
    );
    assert.ok(s.errs.some((line) => /after one re-exchange/.test(line)));
  } finally {
    s.restore();
    platform.restore();
  }
});

test('verify re-exchanges the cached read token once on polling 401', async () => {
  const platform = installPlatform({ read401s: 1 });
  const s = spy();
  try {
    await verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 5000 });
    assert.equal(s.exitCode, null);
    assert.equal(platform.tokenCounts.get('read'), 2);
  } finally {
    s.restore();
    platform.restore();
  }
});

for (const status of [404, 502]) {
  test(`verify reports ingest HTTP ${status} clearly`, async () => {
    const platform = installPlatform({ ingestStatus: status });
    const s = spy();
    try {
      await expectExit(() =>
        verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 100 }),
      );
      assert.equal(s.exitCode, 1);
      if (status === 404) {
        assert.ok(s.errs.some((line) => /api\/v1\/traces\/ingest/.test(line)));
        assert.ok(s.errs.some((line) => /self-hosted/i.test(line)));
      }
      if (status !== 404) assert.ok(s.errs.some((line) => line.includes(String(status))));
      if (status === 502) assert.ok(s.errs.some((line) => /api\/v1\/health/.test(line)));
    } finally {
      s.restore();
      platform.restore();
    }
  });
}

for (const ingestBody of [
  { submitted: 1, accepted: 0, rejected: 0, duplicates: 0, traces: 0 },
  { submitted: 1, accepted: 0, rejected: 1, duplicates: 0, traces: 0 },
  { submitted: 1, accepted: 0, rejected: 0, duplicates: 1, traces: 1 },
  { submitted: 2, accepted: 1, rejected: 1, duplicates: 0, traces: 1 },
  { submitted: 1, accepted: '1', rejected: 0, duplicates: 0, traces: 1 },
  { accepted: 1 },
  null,
  [],
  'not a counter object',
]) {
  test(`verify rejects unconfirmed ingest counters ${JSON.stringify(ingestBody)}`, async () => {
    const platform = installPlatform({ ingestBody });
    const s = spy();
    try {
      await expectExit(() =>
        verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 5000 }),
      );
      assert.equal(s.exitCode, 1);
      assert.ok(s.errs.some((line) => /did not confirm acceptance/.test(line)));
      assert.equal(
        s.logs.some((line) => /Ingest accepted|Install is working/.test(line)),
        false,
      );
      assert.equal(
        platform.requests.some((request) => request.url.includes('/tenants/')),
        false,
      );
    } finally {
      s.restore();
      platform.restore();
    }
  });
}

test('verify reports the health endpoint when ingest is unreachable', async () => {
  const platform = installPlatform({ ingestThrows: true });
  const s = spy();
  try {
    await expectExit(() =>
      verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 100 }),
    );
    assert.ok(s.errs.some((line) => /cannot reach the configured API/.test(line)));
    assert.ok(s.errs.some((line) => /https:\/\/test\/api\/v1\/health/.test(line)));
  } finally {
    s.restore();
    platform.restore();
  }
});

test('verify fails when the accepted trace never lands within timeout', async () => {
  const platform = installPlatform({ neverLand: true });
  const s = spy();
  try {
    await expectExit(() =>
      verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 10 }),
    );
    assert.ok(s.errs.some((line) => /didn't appear/.test(line)));
  } finally {
    s.restore();
    platform.restore();
  }
});

test('verify sends a structurally valid OTLP payload with scoped ingest auth', async () => {
  const platform = installPlatform();
  const s = spy();
  try {
    await verify({ cwd: '/tmp', apiKey: 'key', baseUrl: 'https://test', timeoutMs: 5000 });
    const ingest = platform.requests.find((request) =>
      request.url.endsWith('/api/v1/traces/ingest'),
    );
    const body = ingest?.body as {
      resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }>;
    };
    const span = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    assert.ok(span);
    assert.equal(span.name, 'gen_ai.chat pisama.verify');
    assert.ok(
      (span.attributes as Array<{ key: string; value: { stringValue: string } }>).some(
        (attribute) =>
          attribute.key === 'gen_ai.system' && attribute.value.stringValue === 'pisama-synthetic',
      ),
      'production ingestion requires a recognized GenAI span',
    );
    assert.match(String(span.traceId), /^[0-9a-f]{32}$/);
    assert.match(String(span.spanId), /^[0-9a-f]{16}$/);
    assert.match(String(span.startTimeUnixNano), /^\d+$/);
    assert.match(String(span.endTimeUnixNano), /^\d+$/);
    assert.ok(BigInt(String(span.endTimeUnixNano)) > BigInt(String(span.startTimeUnixNano)));
    assert.match(ingest?.authorization ?? '', /^Bearer .+\.token-ingest-1$/);
  } finally {
    s.restore();
    platform.restore();
  }
});
