import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceExporter } from '../src/exporter.js';
import type { TraceEvent } from '../src/types.js';

function fakeEvent(traceId: string): TraceEvent {
  return {
    projectId: 'ws_207_test',
    traceId,
    spanId: 'span-1',
    startTime: Date.now(),
    endTime: Date.now() + 10,
    model: 'mock',
    toolCalls: [],
    metadata: {},
  };
}

interface ConsoleSpy {
  logs: string[];
  warns: string[];
  restore: () => void;
}

function spyConsole(): ConsoleSpy {
  const log = console.log;
  const warn = console.warn;
  const s: ConsoleSpy = {
    logs: [],
    warns: [],
    restore: () => {
      console.log = log;
      console.warn = warn;
    },
  };
  console.log = (...a: unknown[]) => {
    s.logs.push(a.map(String).join(' '));
  };
  console.warn = (...a: unknown[]) => {
    s.warns.push(a.map(String).join(' '));
  };
  return s;
}

test('exporter logs a partial-flush warning on HTTP 207 (silent partial drop fix)', async () => {
  delete process.env.PISAMA_SILENT;
  delete process.env.PISAMA_DEBUG;
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        accepted: 1,
        submitted: 2,
        failed: [{ traceId: 'trace-bad', reason: 'missing_project_id' }],
      }),
      { status: 207, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  const exporter = new TraceExporter({
    projectId: 'ws_207_test',
    endpoint: 'https://test/api/v1/spans',
    fetchImpl,
    flushIntervalMs: 50,
  });
  exporter.enqueue(fakeEvent('trace-good'));
  exporter.enqueue(fakeEvent('trace-bad'));

  const c = spyConsole();
  try {
    await exporter.flush();
    assert.ok(
      c.warns.some((l) => /partial flush/i.test(l)),
      `expected a 'partial flush' warning, got: ${JSON.stringify(c.warns)}`,
    );
    assert.ok(
      c.warns.some((l) => /1\/2 accepted/.test(l) && /1 dropped/.test(l)),
      'expected counts in the warning',
    );
  } finally {
    c.restore();
  }
});

test('exporter logs each failed event with reason in PISAMA_DEBUG=1 mode', async () => {
  process.env.PISAMA_DEBUG = '1';
  delete process.env.PISAMA_SILENT;
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        accepted: 0,
        submitted: 2,
        failed: [
          { traceId: 't1', reason: 'missing_project_id' },
          { traceId: 't2', reason: 'persist_failed' },
        ],
      }),
      { status: 207, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  const exporter = new TraceExporter({
    projectId: 'ws_207_debug',
    endpoint: 'https://test/api/v1/spans',
    fetchImpl,
  });
  exporter.enqueue(fakeEvent('t1'));
  exporter.enqueue(fakeEvent('t2'));

  const c = spyConsole();
  try {
    await exporter.flush();
    assert.ok(c.warns.some((l) => /t1/.test(l) && /missing_project_id/.test(l)));
    assert.ok(c.warns.some((l) => /t2/.test(l) && /persist_failed/.test(l)));
  } finally {
    c.restore();
    delete process.env.PISAMA_DEBUG;
  }
});

test('exporter respects PISAMA_SILENT=1 even on 207', async () => {
  process.env.PISAMA_SILENT = '1';
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        accepted: 0,
        submitted: 1,
        failed: [{ traceId: 't1', reason: 'boom' }],
      }),
      { status: 207, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  const exporter = new TraceExporter({
    projectId: 'ws_207_silent',
    endpoint: 'https://test/api/v1/spans',
    fetchImpl,
  });
  exporter.enqueue(fakeEvent('t1'));

  const c = spyConsole();
  try {
    await exporter.flush();
    assert.equal(c.warns.length, 0, 'silent mode must suppress 207 warning');
  } finally {
    c.restore();
    delete process.env.PISAMA_SILENT;
  }
});
