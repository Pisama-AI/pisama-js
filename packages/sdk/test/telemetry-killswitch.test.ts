// PISAMA_TELEMETRY=false is the master kill switch. When set, the SDK must:
//   • emit zero network requests to the ingest endpoint
//   • silently drop any enqueued events instead of buffering them
//   • not attach the sdk_first_run headers (since no request fires anyway)
//
// This is a binary acceptance test: it counts requests, expects zero.

import { test } from 'node:test';
import assert from 'node:assert';
import { TraceExporter } from '../src/exporter.js';
import { pisamaMiddleware } from '../src/middleware.js';

test.beforeEach(() => {
  delete process.env.PISAMA_TELEMETRY;
  delete process.env.PISAMA_SILENT;
});

test.afterEach(() => {
  delete process.env.PISAMA_TELEMETRY;
  delete process.env.PISAMA_SILENT;
});

test('PISAMA_TELEMETRY=false: TraceExporter.flush makes zero network requests', async () => {
  process.env.PISAMA_TELEMETRY = 'false';
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  const exporter = new TraceExporter({
    projectId: 'ps_killswitch_test',
    endpoint: 'https://test/api/v1/spans',
    fetchImpl,
  });
  exporter.enqueue({
    projectId: 'ps_killswitch_test',
    traceId: 't1',
    spanId: 's1',
    startTime: 1,
    endTime: 2,
    model: 'x',
    toolCalls: [],
    metadata: {},
  });
  await exporter.flush();

  assert.equal(calls, 0, 'no HTTP requests when telemetry is disabled');
});

test('PISAMA_TELEMETRY=false: middleware builds a passthrough no-op', async () => {
  process.env.PISAMA_TELEMETRY = 'false';
  process.env.PISAMA_SILENT = '1';
  process.env.PISAMA_PROJECT_ID = 'ps_killswitch_mw';

  const mw = pisamaMiddleware({});
  // The no-op wrapGenerate just calls doGenerate() and returns its result.
  // If telemetry were active, the middleware would enqueue an event and
  // (depending on eager mode) issue a fetch. We assert no fetch attempts
  // happen by handing a fetch that throws — if it ever runs, this test fails.
  const failingFetch = (async () => {
    throw new Error('fetch must not be called when telemetry is disabled');
  }) as typeof fetch;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = failingFetch;

  try {
    const result = await (
      mw as unknown as {
        wrapGenerate: (args: {
          doGenerate: () => Promise<{ content: unknown[]; finishReason: string }>;
          params: { prompt: string };
          model: { modelId: string; provider: string };
        }) => Promise<{ content: unknown[]; finishReason: string }>;
      }
    ).wrapGenerate({
      doGenerate: async () => ({ content: [], finishReason: 'stop' }),
      params: { prompt: 'hi' },
      model: { modelId: 'x', provider: 'test' },
    });
    assert.deepEqual(result, { content: [], finishReason: 'stop' });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PISAMA_PROJECT_ID;
  }
});

test('PISAMA_TELEMETRY=false: enqueue drops events immediately (no buffer growth)', async () => {
  process.env.PISAMA_TELEMETRY = 'false';
  const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  const exporter = new TraceExporter({
    projectId: 'ps_dropguard',
    endpoint: 'https://test/api/v1/spans',
    fetchImpl,
  });
  for (let i = 0; i < 100; i++) {
    exporter.enqueue({
      projectId: 'ps_dropguard',
      traceId: `t${i}`,
      spanId: `s${i}`,
      startTime: i,
      endTime: i + 1,
      model: 'x',
      toolCalls: [],
      metadata: {},
    });
  }
  // Read private buffer via TS escape hatch — these tests already poke at
  // internals via exporter.flush() side effects.
  const buf = (exporter as unknown as { buffer: unknown[] }).buffer;
  assert.equal(buf.length, 0, 'buffer must stay empty when telemetry is off');
});

test('default (PISAMA_TELEMETRY unset): exporter still issues requests', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  const exporter = new TraceExporter({
    projectId: 'ps_default',
    endpoint: 'https://test/api/v1/spans',
    fetchImpl,
  });
  exporter.enqueue({
    projectId: 'ps_default',
    traceId: 't1',
    spanId: 's1',
    startTime: 1,
    endTime: 2,
    model: 'x',
    toolCalls: [],
    metadata: {},
  });
  await exporter.flush();
  assert.equal(calls, 1, 'default mode posts the batch');
});
