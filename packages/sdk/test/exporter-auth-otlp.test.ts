import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceExporter } from '../src/exporter.js';
import type { TraceEvent } from '../src/types.js';
import { scopedToken } from './otlp-helpers.js';

interface CapturedRequest {
  url: string;
  authorization?: string;
  requestId?: string;
  body: unknown;
  redirect?: RequestRedirect;
}

function event(sequence = 1): TraceEvent {
  return {
    projectId: 'checkout-agent',
    traceId: sequence.toString(16).padStart(32, '0'),
    spanId: sequence.toString(16).padStart(16, '0'),
    startTime: 1_800_000_000_000 + sequence,
    endTime: 1_800_000_000_100 + sequence,
    model: 'gpt-test',
    prompt: 'redacted prompt',
    completion: 'redacted completion',
    reasoning: 'redacted reasoning',
    toolCalls: [
      {
        toolCallId: 'tool-1',
        toolName: 'lookup',
        args: { query: 'safe' },
        startTime: 1,
      },
    ],
    inputTokens: 11,
    outputTokens: 7,
    costUsd: 0.0125,
    finishReason: 'stop',
    metadata: { environment: 'test' },
  };
}

function headers(init: RequestInit): Headers {
  return new Headers(init.headers);
}

function body(init: RequestInit): unknown {
  return JSON.parse(String(init.body ?? '{}'));
}

test('SDK exchanges the raw key once and sends authenticated OTLP JSON', async () => {
  const rawKey = 'pisama_raw_key_must_not_be_bearer';
  const requests: CapturedRequest[] = [];
  let tokenSequence = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const requestHeaders = headers(init);
    requests.push({
      url: String(input),
      authorization: requestHeaders.get('authorization') ?? undefined,
      requestId: requestHeaders.get('x-request-id') ?? undefined,
      body: body(init),
      redirect: init.redirect,
    });
    if (String(input).endsWith('/api/v1/auth/token')) {
      tokenSequence++;
      return Response.json({ access_token: scopedToken('ingest', tokenSequence) });
    }
    return Response.json({ accepted: 1, submitted: 1, rejected: 0 }, { status: 202 });
  }) as typeof fetch;

  const exporter = new TraceExporter({
    apiKey: rawKey,
    projectId: 'checkout-agent',
    endpoint: 'https://api.test/api/v1/traces/ingest',
    fetchImpl,
  });
  exporter.enqueue(event(1));
  await exporter.flush();
  exporter.enqueue(event(2));
  await exporter.flush();

  const tokenRequests = requests.filter((request) => request.url.endsWith('/api/v1/auth/token'));
  const ingestRequests = requests.filter((request) =>
    request.url.endsWith('/api/v1/traces/ingest'),
  );
  assert.equal(tokenRequests.length, 1, 'JWT should be cached across batches');
  assert.deepEqual(tokenRequests[0]?.body, { api_key: rawKey, scope: 'ingest' });
  assert.equal(tokenRequests[0]?.authorization, undefined);
  assert.equal(ingestRequests.length, 2);
  assert.ok(
    ingestRequests.every(
      (request) => request.authorization === `Bearer ${scopedToken('ingest', 1)}`,
    ),
  );
  assert.ok(ingestRequests.every((request) => request.authorization !== `Bearer ${rawKey}`));
  assert.ok(ingestRequests.every((request) => !JSON.stringify(request.body).includes(rawKey)));
  assert.ok(requests.every((request) => request.redirect === 'error'));

  const otlp = ingestRequests[0]?.body as {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key: string; value: Record<string, unknown> }> };
      scopeSpans?: Array<{
        scope?: { name?: string; version?: string };
        spans?: Array<{
          traceId?: string;
          spanId?: string;
          name?: string;
          kind?: number;
          startTimeUnixNano?: string;
          endTimeUnixNano?: string;
          attributes?: Array<{ key: string; value: Record<string, unknown> }>;
        }>;
      }>;
    }>;
  };
  const resource = otlp.resourceSpans?.[0];
  const span = resource?.scopeSpans?.[0]?.spans?.[0];
  assert.equal(resource?.scopeSpans?.[0]?.scope?.name, '@pisama/sdk');
  assert.match(span?.traceId ?? '', /^[0-9a-f]{32}$/);
  assert.match(span?.spanId ?? '', /^[0-9a-f]{16}$/);
  assert.equal(span?.name, 'gen_ai.chat gpt-test');
  assert.equal(span?.kind, 3);
  assert.match(span?.startTimeUnixNano ?? '', /^\d+$/);
  assert.match(span?.endTimeUnixNano ?? '', /^\d+$/);
  const attributes = Object.fromEntries(
    (span?.attributes ?? []).map((item) => [item.key, item.value]),
  );
  assert.deepEqual(attributes['gen_ai.request.model'], { stringValue: 'gpt-test' });
  assert.deepEqual(attributes['gen_ai.prompt'], { stringValue: 'redacted prompt' });
  assert.deepEqual(attributes['gen_ai.completion'], { stringValue: 'redacted completion' });
  assert.deepEqual(attributes['gen_ai.usage.input_tokens'], { intValue: '11' });
  assert.deepEqual(attributes['gen_ai.usage.output_tokens'], { intValue: '7' });
  assert.deepEqual(attributes['gen_ai.usage.total_tokens'], { intValue: '18' });
  assert.deepEqual(attributes['gen_ai.usage.cost_usd'], { doubleValue: 0.0125 });
});

test('SDK re-exchanges once on 401 and retries the exact body and request id', async () => {
  const requests: CapturedRequest[] = [];
  let tokenSequence = 0;
  let ingestSequence = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const requestHeaders = headers(init);
    requests.push({
      url: String(input),
      authorization: requestHeaders.get('authorization') ?? undefined,
      requestId: requestHeaders.get('x-request-id') ?? undefined,
      body: body(init),
      redirect: init.redirect,
    });
    if (String(input).endsWith('/api/v1/auth/token')) {
      tokenSequence++;
      return Response.json({ access_token: scopedToken('ingest', tokenSequence) });
    }
    ingestSequence++;
    return ingestSequence === 1
      ? new Response('expired', { status: 401 })
      : Response.json({ accepted: 1, submitted: 1, rejected: 0 }, { status: 202 });
  }) as typeof fetch;

  const exporter = new TraceExporter({
    apiKey: 'pisama_key',
    endpoint: 'https://api.test/api/v1/traces/ingest',
    fetchImpl,
  });
  exporter.enqueue(event());
  await exporter.flush();

  const ingestRequests = requests.filter((request) =>
    request.url.endsWith('/api/v1/traces/ingest'),
  );
  assert.equal(tokenSequence, 2);
  assert.equal(ingestRequests.length, 2);
  assert.deepEqual(ingestRequests[1]?.body, ingestRequests[0]?.body);
  assert.equal(ingestRequests[1]?.requestId, ingestRequests[0]?.requestId);
  assert.equal(ingestRequests[0]?.authorization, `Bearer ${scopedToken('ingest', 1)}`);
  assert.equal(ingestRequests[1]?.authorization, `Bearer ${scopedToken('ingest', 2)}`);
});

test('SDK stops after one re-exchange on persistent 401', async () => {
  let tokenCalls = 0;
  let ingestCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/v1/auth/token')) {
      tokenCalls++;
      return Response.json({ access_token: scopedToken('ingest', tokenCalls) });
    }
    ingestCalls++;
    return new Response('expired', { status: 401 });
  }) as typeof fetch;
  const exporter = new TraceExporter({
    apiKey: 'pisama_key',
    endpoint: 'https://api.test/api/v1/traces/ingest',
    fetchImpl,
  });
  exporter.enqueue(event());
  await exporter.flush();
  assert.equal(tokenCalls, 2);
  assert.equal(ingestCalls, 2);
});

test('SDK rejects missing, unknown, and insufficient token scopes before ingest', async () => {
  const invalidTokens = [scopedToken('', 1), scopedToken('admin', 2), scopedToken('read', 3)];

  for (const accessToken of invalidTokens) {
    let ingestCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/v1/auth/token')) {
        return Response.json({ access_token: accessToken });
      }
      ingestCalls++;
      return new Response('{}', { status: 202 });
    }) as typeof fetch;
    const exporter = new TraceExporter({
      apiKey: 'pisama_key',
      endpoint: 'https://api.test/api/v1/traces/ingest',
      fetchImpl,
    });
    const auth = exporter as unknown as { accessToken: () => Promise<string> };
    await assert.rejects(() => auth.accessToken(), /scope|scoped/i);
    assert.equal(ingestCalls, 0);
  }
});

test('SDK concurrent 401s share one refresh and cannot evict the fresh token', async () => {
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
      return Response.json({ access_token: scopedToken('ingest', tokenCalls) });
    }
    const authorization = new Headers(init.headers).get('authorization') ?? '';
    protectedTokens.push(authorization);
    if (authorization === `Bearer ${scopedToken('ingest', 1)}`) {
      initialCalls++;
      if (initialCalls === 2) releaseInitial();
      await bothInitialStarted;
      return new Response('expired', { status: 401 });
    }
    return Response.json({ accepted: 1, submitted: 1, rejected: 0 }, { status: 202 });
  }) as typeof fetch;
  const exporter = new TraceExporter({
    apiKey: 'pisama_key',
    endpoint: 'https://api.test/api/v1/traces/ingest',
    fetchImpl,
  });
  const sender = exporter as unknown as {
    send: (body: string, requestId: string) => Promise<Response>;
  };

  const responses = await Promise.all([
    sender.send('{"batch":1}', 'request-1'),
    sender.send('{"batch":2}', 'request-2'),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status),
    [202, 202],
  );
  assert.equal(tokenCalls, 2);
  assert.deepEqual(protectedTokens, [
    `Bearer ${scopedToken('ingest', 1)}`,
    `Bearer ${scopedToken('ingest', 1)}`,
    `Bearer ${scopedToken('ingest', 2)}`,
    `Bearer ${scopedToken('ingest', 2)}`,
  ]);
});

test('SDK fails closed without an API key', async () => {
  const original = process.env.PISAMA_API_KEY;
  delete process.env.PISAMA_API_KEY;
  let requests = 0;
  const exporter = new TraceExporter({
    endpoint: 'https://api.test/api/v1/traces/ingest',
    fetchImpl: (async () => {
      requests++;
      return new Response();
    }) as typeof fetch,
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    exporter.enqueue(event());
    await exporter.flush();
    assert.equal(requests, 0);
  } finally {
    console.warn = originalWarn;
    if (original === undefined) delete process.env.PISAMA_API_KEY;
    else process.env.PISAMA_API_KEY = original;
  }
});

test('SDK bounds token exchange and eager flush latency even when fetch ignores abort', async () => {
  const exporter = new TraceExporter({
    apiKey: 'pisama_timeout_test_key',
    endpoint: 'https://api.test/api/v1/traces/ingest',
    timeoutMs: 20,
    fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
  });
  const previousSilent = process.env.PISAMA_SILENT;
  process.env.PISAMA_SILENT = '1';
  try {
    exporter.enqueue(event());
    const started = Date.now();
    await exporter.flush();
    assert.ok(Date.now() - started < 1_000, 'flush must return after its configured budget');
  } finally {
    if (previousSilent === undefined) delete process.env.PISAMA_SILENT;
    else process.env.PISAMA_SILENT = previousSilent;
  }
});

test('SDK bounds a token response body that never finishes', async () => {
  const exporter = new TraceExporter({
    apiKey: 'pisama_timeout_test_key',
    endpoint: 'https://api.test/api/v1/traces/ingest',
    timeoutMs: 20,
    fetchImpl: (async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });
  const auth = exporter as unknown as { accessToken: () => Promise<string> };
  const started = Date.now();
  await assert.rejects(() => auth.accessToken(), /timed out after 20ms/);
  assert.ok(Date.now() - started < 1_000, 'exchange must include token-body time in its budget');
});

test('SDK bounds an ingest response body that never finishes', async () => {
  const exporter = new TraceExporter({
    apiKey: 'pisama_timeout_test_key',
    endpoint: 'https://api.test/api/v1/traces/ingest',
    timeoutMs: 20,
    fetchImpl: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/v1/auth/token')) {
        return Response.json({ access_token: scopedToken('ingest', 1) });
      }
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  const sender = exporter as unknown as {
    send: (body: string, requestId: string) => Promise<Response>;
  };
  const started = Date.now();
  await assert.rejects(() => sender.send('{"batch":1}', 'request-1'), /timed out after 20ms/);
  assert.ok(Date.now() - started < 1_000, 'send must include ingest-body time in its budget');
});

test('SDK validates its transport timeout', () => {
  assert.throws(
    () =>
      new TraceExporter({
        apiKey: 'pisama_timeout_test_key',
        timeoutMs: 0,
        fetchImpl: globalThis.fetch,
      }),
    /timeoutMs must be a positive finite number/,
  );
});
