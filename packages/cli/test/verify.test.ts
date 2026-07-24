import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function mktmp() {
  return mkdtemp(join(tmpdir(), 'pisama-verify-'));
}

test('verify fails clearly when no project id is available anywhere', async () => {
  const root = await mktmp();
  const orig = process.env.PISAMA_PROJECT_ID;
  delete process.env.PISAMA_PROJECT_ID;
  const s = spy();
  try {
    try {
      await verify({ cwd: root });
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => /no project id/i.test(l)),
      "expected 'no project id' message",
    );
  } finally {
    s.restore();
    if (orig !== undefined) process.env.PISAMA_PROJECT_ID = orig;
    await rm(root, { recursive: true, force: true });
  }
});

test('verify reads project id from .env.local when env var is unset', async () => {
  const root = await mktmp();
  await writeFile(
    join(root, '.env.local'),
    'PISAMA_PROJECT_ID="ws_fromfile12"\nOTHER=ignored\n',
    'utf8',
  );
  const orig = process.env.PISAMA_PROJECT_ID;
  delete process.env.PISAMA_PROJECT_ID;

  // Mock fetch: ingest 200, then trace appears on second poll
  const originalFetch = globalThis.fetch;
  const seenTraceId: { value?: string } = {};
  let pollCount = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/spans')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      seenTraceId.value = body.events?.[0]?.traceId;
      return new Response(JSON.stringify({ accepted: 1, detections: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/v1/projects/')) {
      pollCount++;
      // First poll empty, second poll has the trace.
      // Pisama backend shape: { project_id, is_claimed, traces: [{ trace_id, session_id, ... }] }
      // SDK's traceId lands in the trace's session_id field.
      const traces =
        pollCount >= 2 && seenTraceId.value
          ? [{ trace_id: 'uuid-1', session_id: seenTraceId.value, detections: [] }]
          : [];
      return new Response(
        JSON.stringify({ project_id: 'ws_fromfile12', is_claimed: false, traces }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const s = spy();
  try {
    await verify({
      cwd: root,
      baseUrl: 'https://api.pisama.ai/',
      timeoutMs: 5000,
    });
    assert.equal(s.exitCode, null, 'should not exit on success');
    assert.ok(
      s.logs.some((l) => /from \.env\.local/.test(l)),
      'expected source=.env.local note',
    );
    assert.ok(
      s.logs.some((l) => /ws_fromfile12/.test(l)),
      'expected project id in output',
    );
    assert.ok(
      s.logs.some((l) => /Install is working/.test(l)),
      'expected success message',
    );
    assert.ok(
      s.logs.some((l) => /Dashboard: https:\/\/pisama\.ai\/live\/ws_fromfile12/.test(l)),
      'expected the public web dashboard rather than the API host',
    );
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
    if (orig !== undefined) process.env.PISAMA_PROJECT_ID = orig;
    await rm(root, { recursive: true, force: true });
  }
});

test('verify fails when ingest returns 5xx', async () => {
  const root = await mktmp();
  process.env.PISAMA_PROJECT_ID = 'ws_5xxtest12345';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('server error', { status: 502 })) as typeof fetch;
  const s = spy();
  try {
    try {
      await verify({ cwd: root, baseUrl: 'https://test', timeoutMs: 5000 });
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
    delete process.env.PISAMA_PROJECT_ID;
    await rm(root, { recursive: true, force: true });
  }
});

test('verify reports the configured health endpoint when the API is unreachable', async () => {
  const root = await mktmp();
  const s = spy();
  try {
    try {
      await verify({
        cwd: root,
        projectId: 'ws_unreachable12',
        baseUrl: 'http://127.0.0.1:1',
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
      s.errs.some((l) => /http:\/\/127\.0\.0\.1:1\/api\/v1\/health/.test(l)),
      'expected the configured API health endpoint',
    );
  } finally {
    s.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('verify fails when trace never lands within timeout', async () => {
  const root = await mktmp();
  process.env.PISAMA_PROJECT_ID = 'ws_neverland12';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/v1/spans')) {
      return new Response(JSON.stringify({ accepted: 1, detections: [] }), {
        status: 200,
      });
    }
    if (url.includes('/api/v1/traces')) {
      return new Response(JSON.stringify({ projectId: 'ws_neverland12', count: 0, events: [] }), {
        status: 200,
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const s = spy();
  try {
    try {
      await verify({ cwd: root, baseUrl: 'https://test', timeoutMs: 1500 });
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => /didn't appear/.test(l)),
      "expected 'didn\\'t appear' in error",
    );
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
    delete process.env.PISAMA_PROJECT_ID;
    await rm(root, { recursive: true, force: true });
  }
});
