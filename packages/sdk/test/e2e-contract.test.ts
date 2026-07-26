// End-to-end contract test against a real Pisama backend.
//
// Every other test in this file uses mocked fetch — that catches SDK-side
// bugs but cannot detect a contract drift between the SDK and the
// /api/v1/spans endpoint. When the backend changes its accepted request
// shape or response shape, mocked tests stay green while alpha users' SDK
// flushes start silently failing in production.
//
// This test is gated behind PISAMA_E2E_ENDPOINT. Without it the test is
// skipped — unit-test CI keeps the mocked path. A separate e2e job (local
// dev, staging deploy gate, or pre-publish check) runs:
//
//   PISAMA_E2E_ENDPOINT=http://localhost:3000 \
//   PISAMA_E2E_PROJECT_ID=e2e_$(date +%s) \
//   pnpm --filter @pisama/sdk test
//
// We wrap globalThis.fetch instead of using the SDK's fetchImpl override so
// the test exercises the exact code path production flushes use (default
// fetchImpl resolution, including keepalive handling).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TraceExporter } from '../src/exporter.js';
import { SDK_VERSION } from '../src/version.js';
import type { TraceEvent } from '../src/types.js';

test('SDK_VERSION matches the package version', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  assert.equal(SDK_VERSION, manifest.version);
});

test('SDK guides use supported project and CLI commands', async () => {
  const packageReadme = new URL('../README.md', import.meta.url);
  const integrationGuides = [
    new URL('./integration/express/README.md', import.meta.url),
    new URL('./integration/hono/README.md', import.meta.url),
    new URL('./integration/nextjs/README.md', import.meta.url),
    new URL('./integration/tanstack-start/README.md', import.meta.url),
  ];
  const approvedInit = 'npx --yes --package=@pisama/cli@latest -- pisama-ts init';
  const approvedVerify = 'npx --yes --package=@pisama/cli@latest -- pisama-ts verify';

  const rootGuide = await readFile(packageReadme, 'utf8');
  assert.match(rootGuide, new RegExp(approvedInit.replaceAll('/', '\\/')));

  for (const guideUrl of integrationGuides) {
    const guide = await readFile(guideUrl, 'utf8');
    assert.doesNotMatch(guide, /\bWHOOPSIE_PROJECT_ID\b/);
    assert.doesNotMatch(guide, /\bnpx\s+(?:pisama|@pisama\/cli)\b/);
    assert.match(guide, /\bPISAMA_PROJECT_ID\b/);
    assert.match(guide, new RegExp(approvedVerify.replaceAll('/', '\\/')));
  }
});

const ENDPOINT = process.env.PISAMA_E2E_ENDPOINT;
const PROJECT_ID = process.env.PISAMA_E2E_PROJECT_ID ?? `e2e_${Date.now().toString(36)}`;

function makeEvent(traceId: string): TraceEvent {
  const now = Date.now();
  return {
    projectId: PROJECT_ID,
    traceId,
    spanId: `span_${traceId}`,
    startTime: now,
    endTime: now + 12,
    model: 'e2e-contract-mock',
    prompt: 'ping',
    completion: 'pong',
    toolCalls: [],
    inputTokens: 1,
    outputTokens: 1,
    metadata: { source: 'pisama-ts e2e-contract' },
  };
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { events: TraceEvent[] };
  status: number;
  responseBody: unknown;
}

function captureFetch(target: string): {
  captured: CapturedRequest[];
  restore: () => void;
} {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof URL ? input.toString() : input);
    if (!url.includes(target)) return original(input, init);
    const headers: Record<string, string> = {};
    const initHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(initHeaders)) {
      headers[k.toLowerCase()] = String(v);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      events: TraceEvent[];
    };
    const res = await original(input, init);
    const responseBody = (await res
      .clone()
      .json()
      .catch(() => null)) as unknown;
    captured.push({
      url,
      method: String(init?.method ?? 'GET'),
      headers,
      body,
      status: res.status,
      responseBody,
    });
    return res;
  }) as typeof fetch;
  return { captured, restore: () => (globalThis.fetch = original) };
}

test('e2e contract: SDK request shape matches /api/v1/spans backend contract', async (t) => {
  if (!ENDPOINT) {
    t.skip('PISAMA_E2E_ENDPOINT not set — skipping e2e contract test');
    return;
  }

  // Force flushes to be visible — silent mode would hide partial-flush
  // diagnostics that are part of the contract.
  delete process.env.PISAMA_SILENT;

  const cap = captureFetch('/api/v1/spans');
  const exporter = new TraceExporter({
    projectId: PROJECT_ID,
    endpoint: `${ENDPOINT.replace(/\/$/, '')}/api/v1/spans`,
    flushIntervalMs: 5_000,
    maxBatchSize: 4,
  });

  exporter.enqueue(makeEvent('trace_e2e_a'));
  exporter.enqueue(makeEvent('trace_e2e_b'));
  await exporter.flush();
  cap.restore();

  assert.equal(cap.captured.length, 1, 'expected exactly one POST to /api/v1/spans');
  const req = cap.captured[0]!;

  // -- Request contract --
  assert.equal(req.method, 'POST', 'must POST trace events');
  assert.equal(req.headers['content-type'], 'application/json', 'must send JSON content-type');
  assert.equal(
    req.headers['x-pisama-project-id'],
    PROJECT_ID,
    'project id header must match configured projectId',
  );
  assert.ok(
    req.headers['x-pisama-client-id'] && req.headers['x-pisama-client-id'].length > 0,
    'client id header must be present',
  );
  assert.equal(
    req.headers['x-pisama-sdk-version'],
    SDK_VERSION,
    'SDK version header must match build',
  );
  assert.ok(
    ['node', 'bun', 'deno', 'edge'].includes(req.headers['x-pisama-runtime']!),
    `runtime header must be a known value, got ${req.headers['x-pisama-runtime']}`,
  );
  assert.ok(Array.isArray(req.body.events), 'body.events must be an array');
  assert.equal(req.body.events.length, 2, 'expected both enqueued events in batch');
  for (const ev of req.body.events) {
    assert.ok(typeof ev.projectId === 'string', 'event.projectId required');
    assert.ok(typeof ev.traceId === 'string', 'event.traceId required');
    assert.ok(typeof ev.spanId === 'string', 'event.spanId required');
    assert.ok(typeof ev.startTime === 'number', 'event.startTime required');
    assert.ok(typeof ev.endTime === 'number', 'event.endTime required');
    assert.ok(typeof ev.model === 'string', 'event.model required');
    assert.ok(Array.isArray(ev.toolCalls), 'event.toolCalls required');
  }

  // -- Response contract --
  // Two backends serve /api/v1/spans with different shapes:
  //   - TS backend (~/pisama-ts/apps/web): synchronous detection,
  //     returns 200/207/502 with `{accepted, detections, failed?, rejected?}`.
  //   - Python backend (api.pisama.ai): async detection,
  //     returns 202 with `{accepted, traces, project_id}`.
  // The SDK exporter tolerates both. The probe accepts either; a 4xx
  // means the request shape itself is rejected (contract drift).
  assert.ok(
    [200, 202, 207, 502].includes(req.status),
    `backend returned ${req.status}; SDK request shape is incompatible with backend contract`,
  );

  const body = req.responseBody as {
    accepted?: number;
    detections?: unknown[];
    failed?: Array<{ traceId: string; reason: string }>;
    rejected?: unknown;
    traces?: number;
    project_id?: string;
  } | null;
  assert.ok(body !== null, 'response must be valid JSON');
  assert.equal(typeof body.accepted, 'number', 'response.accepted must be a number');

  if (req.status === 202) {
    // Python backend: detection is async.
    assert.equal(typeof body.traces, 'number', 'Python backend response must include `traces`');
    assert.equal(
      typeof body.project_id,
      'string',
      'Python backend response must include `project_id`',
    );
  } else {
    // TS backend: detection is synchronous.
    assert.ok(
      Array.isArray(body.detections),
      'TS backend response.detections must be an array (even when empty)',
    );
    if (req.status === 207) {
      assert.ok(
        Array.isArray(body.failed) && body.failed.length > 0,
        'HTTP 207 must include a non-empty failed[] array',
      );
      for (const f of body.failed!) {
        assert.equal(typeof f.traceId, 'string', 'failed entry must have traceId');
        assert.equal(typeof f.reason, 'string', 'failed entry must have reason');
      }
    }
  }
});

test('e2e contract: backend tolerates an empty toolCalls array and no prompt/completion', async (t) => {
  if (!ENDPOINT) {
    t.skip('PISAMA_E2E_ENDPOINT not set — skipping e2e contract test');
    return;
  }

  const cap = captureFetch('/api/v1/spans');
  const exporter = new TraceExporter({
    projectId: PROJECT_ID,
    endpoint: `${ENDPOINT.replace(/\/$/, '')}/api/v1/spans`,
    maxBatchSize: 1,
  });

  const minimal: TraceEvent = {
    projectId: PROJECT_ID,
    traceId: 'trace_e2e_minimal',
    spanId: 'span_minimal',
    startTime: Date.now(),
    endTime: Date.now() + 1,
    model: 'minimal',
    toolCalls: [],
    metadata: {},
  };
  exporter.enqueue(minimal);
  await exporter.flush();
  cap.restore();

  assert.equal(cap.captured.length, 1, 'exporter must flush minimal event');
  assert.ok(
    cap.captured[0]!.status !== 400,
    'minimal event must not be rejected as malformed (HTTP 400 indicates contract drift)',
  );
});

// ---------------------------------------------------------------------------
// Per-detector probes
// ---------------------------------------------------------------------------
// One probe per detector shipped in @pisama/detectors. Each builds a
// TraceEvent specifically designed to trip the named detector, posts it
// to the backend, and asserts the response.detections array contains a
// hit with the expected detector name. This catches two failure modes
// the contract test alone can't:
//
//   1. The detector got disconnected from the ingest pipeline (e.g. a
//      refactor that registers detectors via a list and dropped one).
//   2. The detector's trigger thresholds drifted in a way that makes
//      previously-firing patterns silent.
//
// These only run against the synchronous TS backend (HTTP 200 with
// detections inline). The Python backend processes detections async via
// background_tasks and returns 202; probing it would require a separate
// poll-for-detections pattern not built into this test.

interface DetectionHit {
  detector: string;
  detected?: boolean;
  severity?: number;
  summary?: string;
}

interface SyncResponseBody {
  accepted: number;
  detections: Array<{ traceId: string; hits: DetectionHit[] }>;
}

async function probeDetector(
  detectorName: string,
  event: TraceEvent,
): Promise<DetectionHit[] | 'skip'> {
  const cap = captureFetch('/api/v1/spans');
  const exporter = new TraceExporter({
    projectId: PROJECT_ID,
    endpoint: `${ENDPOINT!.replace(/\/$/, '')}/api/v1/spans`,
    maxBatchSize: 1,
  });
  exporter.enqueue(event);
  await exporter.flush();
  cap.restore();

  const req = cap.captured[0]!;
  if (req.status === 202) return 'skip'; // Python backend: async, no inline detections.
  if (req.status !== 200 && req.status !== 207) {
    throw new Error(
      `${detectorName} probe got HTTP ${req.status} — expected 200/207 from TS backend`,
    );
  }
  const body = req.responseBody as SyncResponseBody;
  const allHits = body.detections.flatMap((d) => d.hits);
  return allHits.filter((h) => h.detector === detectorName && h.detected !== false);
}

function baseEvent(traceId: string): Omit<TraceEvent, 'prompt' | 'completion' | 'toolCalls'> {
  const now = Date.now();
  return {
    projectId: PROJECT_ID,
    traceId,
    spanId: `span_${traceId}`,
    startTime: now,
    endTime: now + 10,
    model: 'probe-mock',
    metadata: {},
  };
}

// loop: 5+ tool calls with the same toolName in a row
test('e2e probe: loop detector fires on consecutive same-tool calls', async (t) => {
  if (!ENDPOINT) return t.skip('PISAMA_E2E_ENDPOINT not set');
  const ev: TraceEvent = {
    ...baseEvent('probe_loop'),
    prompt: 'Search for the answer',
    completion: 'Trying repeatedly',
    toolCalls: Array.from({ length: 7 }, (_, i) => ({
      toolCallId: `c${i}`,
      toolName: 'shellExec',
      startTime: Date.now() + i,
    })),
  };
  const hits = await probeDetector('loop', ev);
  if (hits === 'skip')
    return t.skip('Python backend (202) — async detection, see /detections poll path');
  assert.ok(hits.length > 0, 'loop detector must fire on 7 identical consecutive tool calls');
});

// repetition: 6-gram repeated 4+ times in completion
test('e2e probe: repetition detector fires on n-gram repeats', async (t) => {
  if (!ENDPOINT) return t.skip('PISAMA_E2E_ENDPOINT not set');
  const phrase = 'the quick brown fox jumps over the lazy dog ';
  const ev: TraceEvent = {
    ...baseEvent('probe_rep'),
    prompt: 'Tell me a story',
    completion: phrase.repeat(6),
    toolCalls: [],
  };
  const hits = await probeDetector('repetition', ev);
  if (hits === 'skip') return t.skip('Python backend (202)');
  assert.ok(hits.length > 0, 'repetition detector must fire on repeated 6-gram x6');
});

// cost: tokens > 8000 or costUsd > 0.5
test('e2e probe: cost detector fires above token threshold', async (t) => {
  if (!ENDPOINT) return t.skip('PISAMA_E2E_ENDPOINT not set');
  const ev: TraceEvent = {
    ...baseEvent('probe_cost'),
    prompt: 'Summarize this huge corpus',
    completion: 'Done.',
    inputTokens: 9000,
    outputTokens: 200,
    toolCalls: [],
  };
  const hits = await probeDetector('cost', ev);
  if (hits === 'skip') return t.skip('Python backend (202)');
  assert.ok(hits.length > 0, 'cost detector must fire above 8000 tokens');
});

// completion: finishReason=stop + completion < 20 chars
test('e2e probe: completion detector fires on premature stop', async (t) => {
  if (!ENDPOINT) return t.skip('PISAMA_E2E_ENDPOINT not set');
  const ev: TraceEvent = {
    ...baseEvent('probe_compl'),
    prompt: 'Write a detailed analysis of the third quarter financials.',
    completion: 'ok',
    finishReason: 'stop',
    toolCalls: [],
  };
  const hits = await probeDetector('completion', ev);
  if (hits === 'skip') return t.skip('Python backend (202)');
  assert.ok(hits.length > 0, 'completion detector must fire on premature finishReason=stop');
});

// hallucination: prompt has Sources block + completion contains unsupported cap-phrases
test('e2e probe: hallucination detector fires on unsourced claims', async (t) => {
  if (!ENDPOINT) return t.skip('PISAMA_E2E_ENDPOINT not set');
  const ev: TraceEvent = {
    ...baseEvent('probe_hallu'),
    prompt:
      'Answer the question.\n\nSources:\nApple makes phones.\nGoogle makes search engines.\n\n',
    completion:
      'According to the Galactic Empire and the Cosmic Federation, the Atlantic Republic and the Pacific Alliance and the Imperial Council all signed the treaty.',
    toolCalls: [],
  };
  const hits = await probeDetector('hallucination', ev);
  if (hits === 'skip') return t.skip('Python backend (202)');
  assert.ok(hits.length > 0, 'hallucination detector must fire on 5+ named phrases not in sources');
});

// context: prompt has Context block + completion has zero token overlap
test('e2e probe: context detector fires when completion ignores supplied context', async (t) => {
  if (!ENDPOINT) return t.skip('PISAMA_E2E_ENDPOINT not set');
  const ev: TraceEvent = {
    ...baseEvent('probe_ctx'),
    prompt: 'Context: zorblax wibblesnaks quamble plonkit frumious bandersnatch\n\nAnswer:',
    completion:
      'Rabbits enjoy carrots and lettuce. Pizza tastes wonderful with sausage toppings and cheese.',
    toolCalls: [],
  };
  const hits = await probeDetector('context', ev);
  if (hits === 'skip') return t.skip('Python backend (202)');
  assert.ok(hits.length > 0, 'context detector must fire when zero context tokens overlap');
});

// derailment: 5+ tool calls with non-task-related verbs
test("e2e probe: derailment detector fires when tools don't align with task", async (t) => {
  if (!ENDPOINT) return t.skip('PISAMA_E2E_ENDPOINT not set');
  const ev: TraceEvent = {
    ...baseEvent('probe_derail'),
    prompt: 'Write a Python function that adds two numbers.',
    completion: 'Working on it',
    toolCalls: Array.from({ length: 6 }, (_, i) => ({
      toolCallId: `t${i}`,
      toolName: 'slack_message',
      startTime: Date.now() + i,
    })),
  };
  const hits = await probeDetector('derailment', ev);
  if (hits === 'skip') return t.skip('Python backend (202)');
  assert.ok(
    hits.length > 0,
    "derailment detector must fire when 6 tools don't align with task verb 'write'",
  );
});
