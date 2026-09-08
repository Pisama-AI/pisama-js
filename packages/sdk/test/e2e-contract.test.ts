// Opt-in contract test against a real Pisama deployment. Unit tests pin the
// wire shape; this gate requires authenticated readback of the stored trace/span.
// The designated test key must permit both ingest and read token exchange.
//
//   PISAMA_E2E_ENDPOINT=http://localhost:8000 \
//   PISAMA_E2E_API_KEY=pisama_... \
//   pnpm --filter @pisama/sdk test

import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceExporter } from '../src/exporter.js';
import type { TraceEvent } from '../src/types.js';

const BASE_URL = process.env.PISAMA_E2E_ENDPOINT?.replace(/\/$/, '');
const API_KEY = process.env.PISAMA_E2E_API_KEY;

interface IngestCapture {
  status: number;
  response: {
    accepted?: number;
    submitted?: number;
    rejected?: number;
    duplicates?: number;
    traces?: number;
  } | null;
  authorization?: string;
  body: unknown;
}

test('e2e contract: scoped auth and OTLP JSON persist a real span', async (t) => {
  if (!BASE_URL || !API_KEY) {
    t.skip('PISAMA_E2E_ENDPOINT and PISAMA_E2E_API_KEY are required');
    return;
  }

  const originalFetch = globalThis.fetch;
  const captured: IngestCapture[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (String(input).endsWith('/api/v1/traces/ingest')) {
      captured.push({
        status: response.status,
        response: (await response
          .clone()
          .json()
          .catch(() => null)) as IngestCapture['response'],
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
    }
    return response;
  }) as typeof fetch;

  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const now = Date.now();
  const event: TraceEvent = {
    projectId: 'pisama-sdk-e2e',
    traceId,
    spanId,
    startTime: now,
    endTime: now + 10,
    model: 'pisama-sdk-contract-test',
    prompt: 'pisama SDK contract probe',
    completion: 'ok',
    toolCalls: [],
    inputTokens: 4,
    outputTokens: 1,
    metadata: { source: '@pisama/sdk e2e-contract' },
  };

  try {
    const exporter = new TraceExporter({
      apiKey: API_KEY,
      projectId: event.projectId,
      endpoint: `${BASE_URL}/api/v1/traces/ingest`,
    });
    exporter.enqueue(event);
    await exporter.flush();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.length, 1, 'expected one real ingest request');
  const request = captured[0]!;
  assert.equal(request.status, 202);
  assert.match(request.authorization ?? '', /^Bearer /);
  assert.notEqual(request.authorization, `Bearer ${API_KEY}`, 'raw key must never be bearer auth');
  assert.equal(request.response?.submitted, 1);
  assert.equal(request.response?.accepted, 1);
  assert.equal(request.response?.rejected, 0);
  assert.equal(request.response?.duplicates, 0);
  assert.equal(request.response?.traces, 1);

  const body = request.body as {
    resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ traceId?: string }> }> }>;
  };
  assert.equal(body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.traceId, traceId);

  // Reuse the CLI's real scoped transport, not a second test-only auth client.
  const { PlatformAuth } = await import('../../cli/src/platform-auth.js');
  const auth = new PlatformAuth(BASE_URL, API_KEY);
  const deadline = Date.now() + 20_000;
  const { tenantId } = await auth.identity('read', deadline);
  const tenantUrl = `${BASE_URL}/api/v1/tenants/${encodeURIComponent(tenantId)}`;
  let storedId: string | undefined;
  while (Date.now() < deadline && !storedId) {
    const response = await auth.fetch('read', `${tenantUrl}/traces?per_page=50`, {}, deadline);
    assert.equal(response.status, 200, 'authenticated trace listing must succeed');
    const page = (await response.json()) as { traces: Array<{ id: string; session_id: string }> };
    assert.ok(Array.isArray(page.traces), 'trace listing must contain a traces array');
    storedId = page.traces.find((trace) => trace.session_id === traceId)?.id;
    if (!storedId) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(storedId, 'accepted trace must become readable before the deadline');
  const detail = await auth.fetch(
    'read',
    `${tenantUrl}/traces/${encodeURIComponent(storedId)}`,
    {},
    deadline,
  );
  assert.equal(detail.status, 200);
  const storedTrace = (await detail.json()) as { session_id: string; state_count: number };
  assert.equal(storedTrace.session_id, traceId);
  assert.equal(storedTrace.state_count, 1);
  const response = await auth.fetch(
    'read',
    `${tenantUrl}/traces/${encodeURIComponent(storedId)}/states?full_state=true`,
    {},
    deadline,
  );
  assert.equal(response.status, 200);
  const states = (await response.json()) as Array<{
    state_delta: { _pisama_otel?: { span_id?: string } };
  }>;
  assert.ok(Array.isArray(states));
  assert.equal(states.length, 1);
  assert.equal(states[0]?.state_delta._pisama_otel?.span_id, spanId);
});
