import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceExporter } from '../src/exporter.js';
import type { TraceEvent } from '../src/types.js';
import { tokenResponse } from './otlp-helpers.js';

function fakeEvent(traceId: string): TraceEvent {
  return {
    projectId: 'ws_partial_test',
    traceId,
    spanId: '0000000000000001',
    startTime: Date.now(),
    endTime: Date.now() + 10,
    model: 'mock',
    toolCalls: [],
    metadata: {},
  };
}

function exporterWithResult(body: Record<string, unknown>, status = 202): TraceExporter {
  return new TraceExporter({
    apiKey: 'pisama_partial_test_key',
    projectId: 'ws_partial_test',
    endpoint: 'https://test/api/v1/traces/ingest',
    fetchImpl: (async (input: RequestInfo | URL) =>
      String(input).endsWith('/api/v1/auth/token')
        ? tokenResponse()
        : Response.json(body, { status })) as typeof fetch,
  });
}

function spyWarnings() {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  return { warnings, restore: () => (console.warn = original) };
}

test('exporter warns when the OTLP ingest response reports rejected spans', async () => {
  delete process.env.PISAMA_SILENT;
  const exporter = exporterWithResult({ accepted: 1, submitted: 2, rejected: 1 });
  exporter.enqueue(fakeEvent('00000000000000000000000000000001'));
  exporter.enqueue(fakeEvent('00000000000000000000000000000002'));
  const spy = spyWarnings();
  try {
    await exporter.flush();
    assert.ok(spy.warnings.some((line) => /partial flush/i.test(line)));
    assert.ok(spy.warnings.some((line) => /1\/2 accepted/.test(line) && /1 rejected/.test(line)));
  } finally {
    spy.restore();
  }
});

test('successful OTLP response with no rejections stays quiet', async () => {
  delete process.env.PISAMA_SILENT;
  const exporter = exporterWithResult({ accepted: 1, submitted: 1, rejected: 0 });
  exporter.enqueue(fakeEvent('00000000000000000000000000000001'));
  const spy = spyWarnings();
  try {
    await exporter.flush();
    assert.equal(spy.warnings.length, 0);
  } finally {
    spy.restore();
  }
});

test('PISAMA_SILENT=1 suppresses rejected-span warnings', async () => {
  process.env.PISAMA_SILENT = '1';
  const exporter = exporterWithResult({ accepted: 0, submitted: 1, rejected: 1 });
  exporter.enqueue(fakeEvent('00000000000000000000000000000001'));
  const spy = spyWarnings();
  try {
    await exporter.flush();
    assert.equal(spy.warnings.length, 0);
  } finally {
    spy.restore();
    delete process.env.PISAMA_SILENT;
  }
});
