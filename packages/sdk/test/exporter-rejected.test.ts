// A rejected flush used to be discarded in complete silence.
//
// `fetch` does not throw on HTTP error statuses, and by the time the response is
// inspected the batch has already been spliced out of the buffer. Only HTTP 207 was
// ever examined, so any 4xx or 5xx dropped its events with no signal at all: the
// caller believed telemetry was working while nothing was delivered. That is exactly
// what happened when the hosted ingest route was removed server-side, and there was
// no test covering it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceExporter } from '../src/exporter.js';
import type { TraceEvent } from '../src/types.js';

function fakeEvent(traceId: string): TraceEvent {
  return {
    projectId: 'ws_rejected_test',
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

const TEST_ENDPOINT = 'https://api.example.test/ingest';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exporterReturning(status: number, endpoint = TEST_ENDPOINT) {
  return new TraceExporter({
    projectId: 'ws_rejected_test',
    endpoint,
    fetchImpl: (async () => new Response('', { status })) as unknown as typeof fetch,
  });
}

test('a 404 flush warns and names the endpoint instead of failing silently', async () => {
  const spy = spyConsole();
  try {
    const exporter = exporterReturning(404);
    exporter.enqueue(fakeEvent('t-404'));
    await exporter.flush();

    const warned = spy.warns.join('\n');
    assert.ok(warned.includes('404'), `expected the status in the warning, got: ${warned}`);
    assert.match(
      warned,
      new RegExp(escapeRegExp(TEST_ENDPOINT)),
      `expected the endpoint in the warning, got: ${warned}`,
    );
    assert.ok(
      /drop/i.test(warned),
      `expected the warning to say events were dropped, got: ${warned}`,
    );
  } finally {
    spy.restore();
  }
});

test('a 401 flush warns that credentials are missing', async () => {
  const spy = spyConsole();
  try {
    const exporter = exporterReturning(401);
    exporter.enqueue(fakeEvent('t-401'));
    await exporter.flush();

    const warned = spy.warns.join('\n');
    assert.ok(warned.includes('401'), `expected the status in the warning, got: ${warned}`);
    assert.ok(/credential/i.test(warned), `expected a credentials hint, got: ${warned}`);
  } finally {
    spy.restore();
  }
});

test('a 500 flush still warns rather than dropping silently', async () => {
  const spy = spyConsole();
  try {
    const exporter = exporterReturning(500);
    exporter.enqueue(fakeEvent('t-500'));
    await exporter.flush();

    assert.ok(
      spy.warns.some((w) => w.includes('500')),
      `expected a warning naming HTTP 500, got: ${JSON.stringify(spy.warns)}`,
    );
  } finally {
    spy.restore();
  }
});

test('a 2xx flush stays quiet', async () => {
  const spy = spyConsole();
  try {
    const exporter = exporterReturning(202);
    exporter.enqueue(fakeEvent('t-202'));
    await exporter.flush();

    assert.equal(
      spy.warns.length,
      0,
      `a successful flush must not warn, got: ${JSON.stringify(spy.warns)}`,
    );
  } finally {
    spy.restore();
  }
});
