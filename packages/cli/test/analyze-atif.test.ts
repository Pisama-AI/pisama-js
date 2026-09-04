import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAtif } from '../src/analyze-atif.js';

const here = dirname(fileURLToPath(import.meta.url));
// Real Harbor ATIF trajectory, vendored verbatim from Pisama-AI/pisama's
// harbor-golden fixtures. See fixtures/atif/PROVENANCE.md.
const REAL_TRAJECTORY = resolve(
  here,
  'fixtures',
  'atif',
  'hello-world-context-summarization.trajectory.json',
);
const REAL_CONTINUATION_ROOT = resolve(here, 'fixtures', 'atif', 'continuation', 'trajectory.json');

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
  process.exit = ((code?: number) => {
    s.exitCode = code ?? 0;
    throw new Error('__exit__');
  }) as unknown as typeof process.exit;
  return s;
}

function withNoNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('--local must not make network calls');
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function minimalTrajectory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'ATIF-v1.7',
    session_id: 'continuation-test',
    agent: { name: 'test', model_name: 'test-model' },
    steps: [],
    ...overrides,
  };
}

async function expectDiscoveryFailureWithoutNetwork(path: string, expected: RegExp): Promise<void> {
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error('discovery failure must precede network');
  }) as typeof fetch;
  const s = spy();
  try {
    try {
      await analyzeAtif({ path, apiKey: 'unused', baseUrl: 'https://test' });
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((line) => expected.test(line)),
      s.errs.join('\n'),
    );
    assert.equal(networkCalls, 0);
  } finally {
    s.restore();
    globalThis.fetch = originalFetch;
  }
}

test('analyze-atif --local runs @pisama/detectors on a real Harbor trajectory with zero network calls', async () => {
  const s = spy();
  try {
    await withNoNetwork(() => analyzeAtif({ path: REAL_TRAJECTORY, local: true }));
  } finally {
    s.restore();
  }

  // The fixture's real tool-call sequence is 5x consecutive `bash_command`
  // then 2x `mark_task_complete` (steps 5-6 have no tool_calls and are
  // skipped by the AgentTrace projection). That's MIN_CONSECUTIVE_CRIT
  // exactly, so the loop detector's own severity formula gives 50 (medium),
  // not >=65 (high) -- so this should NOT exit non-zero. If it did, either
  // the severity mapping or the detector wiring regressed.
  assert.equal(s.exitCode, null, 'a medium/low-severity-only run should exit 0');
  const out = s.logs.join('\n');
  // Proves it actually ran real @pisama/detectors algorithms against the
  // real trajectory (not a stub): two independent detectors fire, each with
  // evidence only the real algorithm produces -- loop.ts's consecutive-tool
  // count, and cost.ts's threshold check against the fixture's real
  // final_metrics token totals (7802 + 1030 = 8832).
  assert.match(out, /MEDIUM/);
  assert.match(out, /loop/);
  assert.match(out, /repeated 5x consecutively/);
  assert.match(out, /LOW/);
  assert.match(out, /cost/);
  assert.match(out, /High token usage: 8832 tokens/);
  assert.match(out, /@pisama\/detectors/);
  assert.match(out, /2 total detection\(s\)/);
  assert.match(out, /spans 10/);
  assert.ok(
    s.errs.every((l) => !/could not reach|HTTP \d/.test(l)),
    'local mode must never hit the network path',
  );
});

test('analyze-atif --local --apply fails fast: local mode has no apply path', async () => {
  const s = spy();
  try {
    await withNoNetwork(() =>
      analyzeAtif({
        path: REAL_TRAJECTORY,
        local: true,
        apply: true,
        framework: 'n8n',
        entityId: 'x',
      }),
    );
    assert.fail('expected process.exit');
  } catch (e) {
    assert.equal((e as Error).message, '__exit__');
  } finally {
    s.restore();
  }
  assert.equal(s.exitCode, 1);
  assert.ok(s.errs.some((l) => /--local runs detectors offline and cannot --apply/.test(l)));
});

test('analyze-atif --local exits 0 on a trajectory with no detector findings', async () => {
  // Two clean steps: a user turn and a single short agent tool call. Small
  // enough that no v1Detectors heuristic fires (below every threshold).
  const trajectory = {
    schema_version: 'ATIF-v1.7',
    session_id: 'clean-session',
    agent: { model_name: 'claude-sonnet-4-6' },
    steps: [
      { step_id: 1, timestamp: '2026-01-01T00:00:00Z', source: 'user', message: 'Say hi.' },
      {
        step_id: 2,
        timestamp: '2026-01-01T00:00:01Z',
        source: 'agent',
        message: 'hi',
        tool_calls: [{ tool_call_id: 'tc-1', function_name: 'noop', arguments: {} }],
        observation: { results: [{ source_call_id: 'tc-1', content: 'ok' }] },
        metrics: { prompt_tokens: 5, completion_tokens: 1, cost_usd: 0.0001 },
      },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-'));
  const file = join(dir, 'clean.json');
  writeFileSync(file, JSON.stringify(trajectory));

  const s = spy();
  try {
    await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
    assert.equal(s.exitCode, null, 'a clean trajectory should not exit non-zero');
    const out = s.logs.join('\n');
    assert.match(out, /No detections/);
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif --local still validates schema_version like the remote path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-'));
  const file = join(dir, 'bad-schema.json');
  writeFileSync(file, JSON.stringify({ schema_version: 'ATIF-v99.0', steps: [] }));

  const s = spy();
  try {
    await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
    assert.fail('expected process.exit');
  } catch (e) {
    assert.equal((e as Error).message, '__exit__');
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(s.exitCode, 1);
  assert.ok(s.errs.some((l) => /unsupported schema_version/.test(l)));
});

test('analyze-atif rejects valid JSON whose root is not an object', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-root-'));
  try {
    for (const [index, value] of [null, [], 'trajectory', 42].entries()) {
      const file = join(dir, `invalid-root-${index}.json`);
      writeFileSync(file, JSON.stringify(value));
      const s = spy();
      try {
        await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
        assert.fail('expected process.exit');
      } catch (error) {
        assert.equal((error as Error).message, '__exit__');
      } finally {
        s.restore();
      }
      assert.equal(s.exitCode, 1);
      assert.ok(s.errs.some((line) => /trajectory JSON root must be an object/.test(line)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture sanity: the vendored trajectory file still parses as valid JSON', () => {
  const raw = readFileSync(REAL_TRAJECTORY, 'utf8');
  const parsed = JSON.parse(raw) as { schema_version?: string; steps?: unknown[] };
  assert.equal(parsed.schema_version, 'ATIF-v1.7');
  assert.ok(Array.isArray(parsed.steps) && parsed.steps.length > 0);
});

test('analyze-atif --local follows the committed Harbor continuation in run order', async () => {
  const s = spy();
  try {
    await withNoNetwork(() => analyzeAtif({ path: REAL_CONTINUATION_ROOT, local: true }));
    assert.equal(s.exitCode, null);
  } finally {
    s.restore();
  }
  const output = s.logs.join('\n');
  assert.match(output, /Analyzing 2 trajectories locally/);
  assert.ok(output.indexOf('trajectory.json') < output.indexOf('trajectory.cont-1.json'));
  assert.match(output, /trajectory\.json[\s\S]*No detections/);
  assert.match(output, /trajectory\.cont-1\.json[\s\S]*High token usage: 8832 tokens/);
  assert.match(output, /Summary: 2 trajectorie\(s\), 1 total detection\(s\)/);
});

// ---------------------------------------------------------------------------
// Remote (default, backend-calling) path. --local is additive; the existing
// /api/v1/atif/analyze flow must keep working unchanged.
// ---------------------------------------------------------------------------

interface MockDiagnosisDetection {
  category?: string;
  severity?: string;
  confidence?: number;
  title?: string;
  description?: string;
}

function mockAnalyzeResponse(overrides: {
  detections?: MockDiagnosisDetection[];
  detectionStatus?: string;
  detectorsRun?: string[];
  detectorsFailed?: Record<string, string>;
  topologyComplete?: boolean;
  unresolvedTrajectoryRefs?: string[];
  healing?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const detections = (overrides.detections ?? []).map((detection, index) => ({
    category: detection.category ?? `detector_${index}`,
    detected: true,
    severity: detection.severity ?? 'medium',
    confidence: detection.confidence ?? 0.5,
    title: detection.title ?? 'Detector finding',
    description: detection.description ?? 'Detector finding description.',
  }));
  return {
    diagnosis: {
      trace_id: 'trace-1',
      has_failures: detections.length > 0,
      failure_count: detections.length,
      detection_status: overrides.detectionStatus ?? 'complete',
      all_detections: detections,
      detectors_run: overrides.detectorsRun ?? ['loop', 'persona_drift'],
      detectors_failed: overrides.detectorsFailed ?? {},
    },
    trace: {
      trace_id: 'trace-1',
      span_count: 3,
      total_tokens: 100,
      atif_schema_version: 'ATIF-v1.7',
      atif_session_id: 'sess-1',
      atif_trajectory_id: null,
      topology_complete: overrides.topologyComplete ?? true,
      unresolved_trajectory_refs: overrides.unresolvedTrajectoryRefs ?? [],
    },
    healing: overrides.healing ?? null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function testJwt(scope: string, suffix = '1'): string {
  const claims = Buffer.from(
    JSON.stringify({ tenant_id: 'tenant-atif-test', scope }),
    'utf8',
  ).toString('base64url');
  return `test.${claims}.token-${scope}-${suffix}`;
}

function withMockFetch<T>(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  fn: () => Promise<T>,
  onToken?: (body: { api_key?: string; scope?: string }, init: RequestInit | undefined) => void,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  let tokenIndex = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/auth/token')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { api_key?: string; scope?: string };
      onToken?.(body, init);
      tokenIndex += 1;
      return jsonResponse({ access_token: testJwt(body.scope ?? 'full', String(tokenIndex)) });
    }
    return handler(url, init);
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test('analyze-atif (remote) happy path: posts the trajectory and exits 0 on no detections', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  let capturedAuth: string | undefined;
  const s = spy();
  try {
    await withMockFetch(
      (url, init) => {
        assert.equal(url, 'https://test/api/v1/atif/analyze');
        capturedBody = JSON.parse(String(init?.body ?? '{}'));
        capturedAuth = new Headers(init?.headers).get('authorization') ?? undefined;
        return jsonResponse(mockAnalyzeResponse({}));
      },
      () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k-1', baseUrl: 'https://test/' }),
    );
    assert.equal(s.exitCode, null);
  } finally {
    s.restore();
  }
  assert.match(capturedAuth ?? '', /^Bearer test\..+\.token-read-1$/);
  assert.notEqual(capturedAuth, 'Bearer k-1');
  assert.ok((capturedBody?.trajectory as { schema_version?: string })?.schema_version);
  const out = s.logs.join('\n');
  assert.match(out, /against https:\/\/test/);
  assert.match(out, /No detections/);
  assert.match(out, /No critical\/high-severity failures/);
});

test('analyze-atif (remote) submits a continuation and cannot hide its high finding', async () => {
  const submitted: Array<{ continued_trajectory_ref?: string; continuation?: number }> = [];
  const s = spy();
  try {
    try {
      await withMockFetch(
        (_url, init) => {
          const body = JSON.parse(String(init?.body)) as {
            trajectory: {
              continued_trajectory_ref?: string;
              agent?: { extra?: { continuation_index?: number } };
            };
          };
          const trajectory = body.trajectory;
          submitted.push({
            continued_trajectory_ref: trajectory.continued_trajectory_ref,
            continuation: trajectory.agent?.extra?.continuation_index,
          });
          if (trajectory.continued_trajectory_ref) {
            return jsonResponse(
              mockAnalyzeResponse({
                topologyComplete: false,
                unresolvedTrajectoryRefs: ['trajectory.cont-1.json'],
              }),
            );
          }
          return jsonResponse(
            mockAnalyzeResponse({
              detections: [
                {
                  category: 'completion_misjudgment',
                  severity: 'high',
                  confidence: 0.95,
                  title: 'Continuation failed',
                },
              ],
            }),
          );
        },
        () =>
          analyzeAtif({
            path: REAL_CONTINUATION_ROOT,
            apiKey: 'key',
            baseUrl: 'https://test',
          }),
      );
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
  } finally {
    s.restore();
  }

  assert.equal(s.exitCode, 1);
  assert.deepEqual(submitted, [
    { continued_trajectory_ref: 'trajectory.cont-1.json', continuation: undefined },
    { continued_trajectory_ref: undefined, continuation: 1 },
  ]);
  const output = s.logs.join('\n');
  assert.match(output, /continuation submitted: trajectory\.cont-1\.json/);
  assert.match(output, /completion_misjudgment/);
  assert.match(output, /At least one critical\/high-severity detection fired/);
  assert.doesNotMatch(output, /Summary:[\s\S]*No critical\/high-severity failures/);
});

test('analyze-atif (remote) rejects continuation topology responses that disagree with source', async () => {
  const continuedReference = 'trajectory.cont-1.json';
  const cases: Array<{ name: string; response: Record<string, unknown> }> = [
    {
      name: 'complete response omits submitted continuation',
      response: mockAnalyzeResponse({}),
    },
    {
      name: 'incomplete response omits submitted continuation',
      response: mockAnalyzeResponse({
        topologyComplete: false,
        unresolvedTrajectoryRefs: ['trajectory.summarization-1-summary.json'],
      }),
    },
    {
      name: 'response invents an undeclared reference',
      response: mockAnalyzeResponse({
        topologyComplete: false,
        unresolvedTrajectoryRefs: [continuedReference, 'not-declared-by-source.json'],
      }),
    },
    {
      name: 'response duplicates the submitted continuation',
      response: mockAnalyzeResponse({
        topologyComplete: false,
        unresolvedTrajectoryRefs: [continuedReference, continuedReference],
      }),
    },
  ];

  for (const entry of cases) {
    const s = spy();
    try {
      try {
        await withMockFetch(
          () => jsonResponse(entry.response),
          () =>
            analyzeAtif({
              path: REAL_CONTINUATION_ROOT,
              apiKey: 'key',
              baseUrl: 'https://test',
            }),
        );
        assert.fail('expected process.exit');
      } catch (error) {
        assert.equal((error as Error).message, '__exit__', entry.name);
      }
    } finally {
      s.restore();
    }
    assert.equal(s.exitCode, 1, entry.name);
    assert.ok(
      s.errs.some((line) => /analyze endpoint returned an invalid response/.test(line)),
      entry.name,
    );
    assert.doesNotMatch(s.logs.join('\n'), /No detections|No critical\/high-severity failures/);
  }
});

test('analyze-atif (remote) exits 1 and never reports clean when every detector failed', async () => {
  const s = spy();
  try {
    try {
      await withMockFetch(
        () =>
          jsonResponse(
            mockAnalyzeResponse({
              detectionStatus: 'failed',
              detectorsRun: [],
              detectorsFailed: { loop: 'detector timed out' },
            }),
          ),
        () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
      );
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
  } finally {
    s.restore();
  }

  assert.equal(s.exitCode, 1);
  const output = s.logs.join('\n');
  assert.match(output, /Detection analysis failed; result is incomplete/);
  assert.match(output, /detectors_failed: loop/);
  assert.match(output, /0 confirmed detections returned; result is not clean/);
  assert.match(output, /At least one analysis had incomplete detector or topology evidence/);
  assert.doesNotMatch(output, /No detections|No critical\/high-severity failures/);
});

test('analyze-atif (remote) exits 1 on partial detector coverage with no findings', async () => {
  const s = spy();
  try {
    try {
      await withMockFetch(
        () =>
          jsonResponse(
            mockAnalyzeResponse({
              detectionStatus: 'partial',
              detectorsFailed: { persona_drift: 'dependency unavailable' },
            }),
          ),
        () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
      );
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
  } finally {
    s.restore();
  }

  assert.equal(s.exitCode, 1);
  const output = s.logs.join('\n');
  assert.match(output, /Detection analysis partial; result is incomplete/);
  assert.match(output, /detectors_failed: persona_drift/);
  assert.doesNotMatch(output, /No detections|No critical\/high-severity failures/);
});

test('analyze-atif (remote) never reports clean with unresolved topology', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-unresolved-source-'));
  const trajectoryPath = join(dir, 'trajectory.json');
  writeFileSync(
    trajectoryPath,
    JSON.stringify(
      minimalTrajectory({
        steps: [
          {
            observation: {
              results: [
                {
                  subagent_trajectory_ref: [{ trajectory_path: 'external-subagent-trajectory' }],
                },
              ],
            },
          },
        ],
      }),
    ),
  );
  const s = spy();
  try {
    try {
      await withMockFetch(
        () =>
          jsonResponse(
            mockAnalyzeResponse({
              topologyComplete: false,
              unresolvedTrajectoryRefs: ['external-subagent-trajectory'],
            }),
          ),
        () => analyzeAtif({ path: trajectoryPath, apiKey: 'key', baseUrl: 'https://test' }),
      );
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(s.exitCode, 1);
  const output = s.logs.join('\n');
  assert.match(output, /Trajectory topology is incomplete; result is not clean/);
  assert.match(output, /unresolved_trajectory_refs: external-subagent-trajectory/);
  assert.doesNotMatch(output, /No detections|No critical\/high-severity failures/);
});

test('analyze-atif (remote) rejects malformed or inconsistent 200 responses', async () => {
  const mismatchedTrace = mockAnalyzeResponse({});
  (mismatchedTrace.trace as Record<string, unknown>).trace_id = 'other-trace';
  const mismatchedCount = mockAnalyzeResponse({});
  (mismatchedCount.diagnosis as Record<string, unknown>).failure_count = 1;
  const missingDetected = mockAnalyzeResponse({ detections: [{ category: 'loop' }] });
  delete (
    (missingDetected.diagnosis as Record<string, unknown>).all_detections as Record<
      string,
      unknown
    >[]
  )[0].detected;

  const cases: Array<{ name: string; response: unknown }> = [
    { name: 'missing diagnosis', response: { trace: {}, healing: null } },
    {
      name: 'non-terminal status',
      response: mockAnalyzeResponse({ detectionStatus: 'running' }),
    },
    {
      name: 'complete status with detector failure',
      response: mockAnalyzeResponse({ detectorsFailed: { loop: 'failed' } }),
    },
    {
      name: 'complete status with no attempted detector',
      response: mockAnalyzeResponse({ detectorsRun: [] }),
    },
    { name: 'failure count mismatch', response: mismatchedCount },
    { name: 'trace ID mismatch', response: mismatchedTrace },
    { name: 'malformed detection row', response: missingDetected },
    {
      name: 'topology flag contradicts unresolved refs',
      response: mockAnalyzeResponse({ unresolvedTrajectoryRefs: ['missing.json'] }),
    },
  ];

  for (const entry of cases) {
    const s = spy();
    try {
      try {
        await withMockFetch(
          () => jsonResponse(entry.response),
          () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
        );
        assert.fail('expected process.exit');
      } catch (error) {
        assert.equal((error as Error).message, '__exit__', entry.name);
      }
    } finally {
      s.restore();
    }
    assert.equal(s.exitCode, 1, entry.name);
    assert.ok(
      s.errs.some((line) => /analyze endpoint returned an invalid response/.test(line)),
      entry.name,
    );
    assert.doesNotMatch(s.logs.join('\n'), /No detections|No critical\/high-severity failures/);
  }
});

test('analyze-atif exchanges the raw key for a scoped JWT and retries exactly once on 401', async () => {
  const rawKey = 'pisama_raw_secret_never_bearer';
  const tokenBodies: { api_key?: string; scope?: string }[] = [];
  const analyzeRequests: {
    authorization: string | null;
    requestId: string | null;
    body: string;
  }[] = [];
  const s = spy();
  try {
    await withMockFetch(
      (_url, init) => {
        const headers = new Headers(init?.headers);
        analyzeRequests.push({
          authorization: headers.get('authorization'),
          requestId: headers.get('x-request-id'),
          body: String(init?.body),
        });
        return analyzeRequests.length === 1
          ? new Response('expired', { status: 401 })
          : jsonResponse(mockAnalyzeResponse({}));
      },
      () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: rawKey, baseUrl: 'https://test' }),
      (body) => tokenBodies.push(body),
    );
  } finally {
    s.restore();
  }

  assert.deepEqual(tokenBodies, [
    { api_key: rawKey, scope: 'read' },
    { api_key: rawKey, scope: 'read' },
  ]);
  assert.equal(analyzeRequests.length, 2);
  for (const request of analyzeRequests) {
    assert.match(request.authorization ?? '', /^Bearer test\..+\.token-read-/);
    assert.notEqual(request.authorization, `Bearer ${rawKey}`);
  }
  assert.equal(analyzeRequests[0].requestId, analyzeRequests[1].requestId);
  assert.equal(analyzeRequests[0].body, analyzeRequests[1].body);
  assert.ok(!s.logs.join('\n').includes(rawKey));
  assert.ok(!s.errs.join('\n').includes(rawKey));
});

test('analyze-atif stops after the single authenticated retry on a persistent 401', async () => {
  let analyzeCalls = 0;
  let tokenCalls = 0;
  const s = spy();
  try {
    await withMockFetch(
      () => {
        analyzeCalls += 1;
        return new Response('unauthorized', { status: 401 });
      },
      () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'secret', baseUrl: 'https://test' }),
      () => {
        tokenCalls += 1;
      },
    );
    assert.fail('expected process.exit');
  } catch (error) {
    assert.equal((error as Error).message, '__exit__');
  } finally {
    s.restore();
  }
  assert.equal(tokenCalls, 2);
  assert.equal(analyzeCalls, 2);
  assert.ok(s.errs.some((line) => /HTTP 401/.test(line)));
});

test('analyze-atif requests full scope for --apply and never uses credentials as auth', async () => {
  const scopes: string[] = [];
  let authorization: string | null = null;
  const s = spy();
  try {
    await withMockFetch(
      (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        return jsonResponse(mockAnalyzeResponse({ healing: { success: true } }));
      },
      () =>
        analyzeAtif({
          path: REAL_TRAJECTORY,
          apply: true,
          framework: 'n8n',
          entityId: 'workflow-1',
          credentials: '{"api_key":"framework-secret"}',
          apiKey: 'pisama-secret',
          baseUrl: 'https://test',
        }),
      (body) => scopes.push(body.scope ?? ''),
    );
  } finally {
    s.restore();
  }
  assert.deepEqual(scopes, ['full']);
  assert.match(authorization ?? '', /^Bearer test\..+\.token-full-1$/);
  assert.notEqual(authorization, 'Bearer pisama-secret');
  assert.notEqual(authorization, 'Bearer framework-secret');
});

test('analyze-atif (remote) exits 1 when the backend returns a high-severity detection', async () => {
  const s = spy();
  try {
    await withMockFetch(
      () =>
        jsonResponse(
          mockAnalyzeResponse({
            detections: [
              { category: 'persona_drift', severity: 'high', confidence: 0.91, title: 'drifted' },
            ],
          }),
        ),
      () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
    );
    assert.fail('expected process.exit');
  } catch (e) {
    assert.equal((e as Error).message, '__exit__');
  } finally {
    s.restore();
  }
  assert.equal(s.exitCode, 1);
  assert.ok(s.logs.some((l) => /At least one critical\/high-severity detection fired/.test(l)));
  assert.ok(s.logs.some((l) => /persona_drift/.test(l)));
});

test('analyze-atif (remote) renders a critical detection and exits 1', async () => {
  const s = spy();
  try {
    await withMockFetch(
      () =>
        jsonResponse(
          mockAnalyzeResponse({
            detections: [
              {
                category: 'prompt_injection',
                severity: 'critical',
                confidence: 0.99,
                title: 'critical injection',
              },
            ],
          }),
        ),
      () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
    );
    assert.fail('expected process.exit');
  } catch (error) {
    assert.equal((error as Error).message, '__exit__');
  } finally {
    s.restore();
  }

  assert.equal(s.exitCode, 1);
  const output = s.logs.join('\n');
  assert.match(output, /CRITICAL/);
  assert.match(output, /prompt_injection/);
  assert.match(output, /At least one critical\/high-severity detection fired/);
});

test('analyze-atif (remote) fails clearly when the analyze endpoint is unreachable', async () => {
  const s = spy();
  try {
    await withMockFetch(
      () => {
        throw new Error('connect ECONNREFUSED');
      },
      () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
    );
    assert.fail('expected process.exit');
  } catch (e) {
    assert.equal((e as Error).message, '__exit__');
  } finally {
    s.restore();
  }
  assert.equal(s.exitCode, 1);
  assert.ok(s.errs.some((l) => /authenticated analyze request failed/.test(l)));
});

test('analyze-atif (remote) fails on a non-ok HTTP status and surfaces the response body', async () => {
  const s = spy();
  try {
    await withMockFetch(
      () => new Response('rate limited', { status: 429 }),
      () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
    );
    assert.fail('expected process.exit');
  } catch (e) {
    assert.equal((e as Error).message, '__exit__');
  } finally {
    s.restore();
  }
  assert.equal(s.exitCode, 1);
  assert.ok(s.errs.some((l) => /HTTP 429/.test(l)));
  assert.ok(s.errs.some((l) => /rate limited/.test(l)));
});

test('analyze-atif (remote) truncates a severity group beyond 3 items', async () => {
  const detections: MockDiagnosisDetection[] = Array.from({ length: 5 }, (_, i) => ({
    category: `detector_${i}`,
    severity: 'low',
  }));
  const s = spy();
  try {
    await withMockFetch(
      () => jsonResponse(mockAnalyzeResponse({ detections })),
      () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
    );
    assert.equal(s.exitCode, null);
  } finally {
    s.restore();
  }
  assert.ok(s.logs.some((l) => /\.\.\. and 2 more/.test(l)));
});

// ---------------------------------------------------------------------------
// --apply / credentials / healing rendering
// ---------------------------------------------------------------------------

test('--apply requires --framework, --entity-id, and --credentials, each reported separately', async () => {
  const base = { path: REAL_TRAJECTORY, apply: true } as const;
  for (const [opts, expected] of [
    [base, /--apply requires --framework/],
    [{ ...base, framework: 'n8n' }, /--apply requires --entity-id/],
    [{ ...base, framework: 'n8n', entityId: 'wf-1' }, /--apply requires --credentials/],
  ] as const) {
    const s = spy();
    try {
      await analyzeAtif(opts);
      assert.fail('expected process.exit');
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    } finally {
      s.restore();
    }
    assert.equal(s.exitCode, 1);
    assert.ok(
      s.errs.some((l) => expected.test(l)),
      `expected ${expected} in ${s.errs.join('|')}`,
    );
  }
});

test('--apply rejects invalid inline --credentials JSON', async () => {
  const s = spy();
  try {
    await analyzeAtif({
      path: REAL_TRAJECTORY,
      apply: true,
      framework: 'n8n',
      entityId: 'wf-1',
      credentials: '{not json',
    });
    assert.fail('expected process.exit');
  } catch (e) {
    assert.equal((e as Error).message, '__exit__');
  } finally {
    s.restore();
  }
  assert.equal(s.exitCode, 1);
  assert.ok(s.errs.some((l) => /--credentials JSON is invalid/.test(l)));
});

test('--apply reads --credentials from a file path and rejects a missing or invalid one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-creds-'));
  try {
    const credsFile = join(dir, 'creds.json');
    writeFileSync(credsFile, JSON.stringify({ instance_url: 'https://n8n.example' }));

    let capturedBody: Record<string, unknown> | undefined;
    const s = spy();
    try {
      await withMockFetch(
        (_url, init) => {
          capturedBody = JSON.parse(String(init?.body ?? '{}'));
          return jsonResponse(
            mockAnalyzeResponse({ healing: { success: true, fix_type: 'noop' } }),
          );
        },
        () =>
          analyzeAtif({
            path: REAL_TRAJECTORY,
            apply: true,
            framework: 'n8n',
            entityId: 'wf-1',
            credentials: credsFile,
            apiKey: 'k',
            baseUrl: 'https://test',
          }),
      );
      assert.equal(s.exitCode, null);
    } finally {
      s.restore();
    }
    assert.deepEqual(capturedBody?.credentials, { instance_url: 'https://n8n.example' });
    assert.equal(capturedBody?.apply_fix, true);

    const missing = spy();
    try {
      await analyzeAtif({
        path: REAL_TRAJECTORY,
        apply: true,
        framework: 'n8n',
        entityId: 'wf-1',
        credentials: join(dir, 'nope.json'),
      });
      assert.fail('expected process.exit');
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    } finally {
      missing.restore();
    }
    assert.equal(missing.exitCode, 1);
    assert.ok(missing.errs.some((l) => /--credentials file could not be read/.test(l)));

    const badJsonFile = join(dir, 'bad.json');
    writeFileSync(badJsonFile, '{not json');
    const bad = spy();
    try {
      await analyzeAtif({
        path: REAL_TRAJECTORY,
        apply: true,
        framework: 'n8n',
        entityId: 'wf-1',
        credentials: badJsonFile,
      });
      assert.fail('expected process.exit');
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    } finally {
      bad.restore();
    }
    assert.equal(bad.exitCode, 1);
    assert.ok(bad.errs.some((l) => /--credentials file is not valid JSON/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--apply renders a successful, non-rolled-back healing with an id-keyed successor', async () => {
  const s = spy();
  try {
    await withMockFetch(
      () =>
        jsonResponse(
          mockAnalyzeResponse({
            healing: {
              success: true,
              healing_id: 'heal-1',
              fix_type: 'code_patch',
              backup_commit_sha: 'abcdef1234567890',
              rolled_back: false,
              successor_entity: { id: 'entity-1' },
            },
          }),
        ),
      () =>
        analyzeAtif({
          path: REAL_TRAJECTORY,
          apply: true,
          framework: 'n8n',
          entityId: 'wf-1',
          credentials: '{}',
          apiKey: 'k',
          baseUrl: 'https://test',
        }),
    );
    assert.equal(s.exitCode, null);
  } finally {
    s.restore();
  }
  const out = s.logs.join('\n');
  assert.match(out, /applied/);
  assert.match(out, /fix_type code_patch/);
  assert.match(out, /healing_id heal-1/);
  assert.match(out, /backup_sha abcdef123456/);
  assert.match(out, /successor entity-1/);
});

test('--apply renders a rolled-back healing with an agent_id-keyed successor', async () => {
  const s = spy();
  try {
    try {
      await withMockFetch(
        () =>
          jsonResponse(
            mockAnalyzeResponse({
              healing: {
                success: true,
                rolled_back: true,
                successor_entity: { agent_id: 'agent-2' },
              },
            }),
          ),
        () =>
          analyzeAtif({
            path: REAL_TRAJECTORY,
            apply: true,
            framework: 'n8n',
            entityId: 'wf-1',
            credentials: '{}',
            apiKey: 'k',
            baseUrl: 'https://test',
          }),
      );
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
  } finally {
    s.restore();
  }
  assert.equal(s.exitCode, 1);
  const out = s.logs.join('\n');
  assert.match(out, /rolled back/);
  assert.match(out, /successor agent-2/);
  assert.match(out, /requested fix was missing, failed, or rolled back/);
});

test('--apply renders a failed healing with its error', async () => {
  const s = spy();
  try {
    try {
      await withMockFetch(
        () =>
          jsonResponse(
            mockAnalyzeResponse({ healing: { success: false, error: 'workflow locked' } }),
          ),
        () =>
          analyzeAtif({
            path: REAL_TRAJECTORY,
            apply: true,
            framework: 'n8n',
            entityId: 'wf-1',
            credentials: '{}',
            apiKey: 'k',
            baseUrl: 'https://test',
          }),
      );
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
  } finally {
    s.restore();
  }
  assert.equal(s.exitCode, 1);
  const out = s.logs.join('\n');
  assert.match(out, /apply failed/);
  assert.match(out, /workflow locked/);
  assert.match(out, /requested fix was missing, failed, or rolled back/);
});

test('--apply exits 1 when the backend omits the healing result', async () => {
  const s = spy();
  try {
    try {
      await withMockFetch(
        () => jsonResponse(mockAnalyzeResponse({ healing: null })),
        () =>
          analyzeAtif({
            path: REAL_TRAJECTORY,
            apply: true,
            framework: 'n8n',
            entityId: 'wf-1',
            credentials: '{}',
            apiKey: 'k',
            baseUrl: 'https://test',
          }),
      );
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
  } finally {
    s.restore();
  }
  assert.equal(s.exitCode, 1);
  assert.match(s.logs.join('\n'), /requested fix was missing, failed, or rolled back/);
});

test('--apply is single-trajectory only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-multi-'));
  try {
    const trajectory = JSON.parse(readFileSync(REAL_TRAJECTORY, 'utf8'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify(trajectory));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(trajectory));

    const s = spy();
    try {
      await analyzeAtif({
        path: dir,
        apply: true,
        framework: 'n8n',
        entityId: 'wf-1',
        credentials: '{}',
      });
      assert.fail('expected process.exit');
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    } finally {
      s.restore();
    }
    assert.equal(s.exitCode, 1);
    assert.ok(s.errs.some((l) => /--apply is single-trajectory only; 2 files matched/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path/directory discovery (all local, no network needed)
// ---------------------------------------------------------------------------

test('discovery: a directory containing agent/trajectory.json is treated as a single Harbor trial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-trial-'));
  try {
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'trajectory.json'), readFileSync(REAL_TRAJECTORY, 'utf8'));

    const s = spy();
    try {
      await withNoNetwork(() => analyzeAtif({ path: dir, local: true }));
      assert.equal(s.exitCode, null);
    } finally {
      s.restore();
    }
    assert.ok(s.logs.some((l) => /agent[/\\]trajectory\.json/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: a flat directory of .json files analyzes every trajectory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-flat-'));
  try {
    const raw = readFileSync(REAL_TRAJECTORY, 'utf8');
    writeFileSync(join(dir, 'a.json'), raw);
    writeFileSync(join(dir, 'b.json'), raw);

    const s = spy();
    try {
      await withNoNetwork(() => analyzeAtif({ path: dir, local: true }));
    } finally {
      s.restore();
    }
    assert.ok(s.logs.some((l) => /Analyzing 2 trajectories locally/.test(l)));
    assert.ok(s.logs.some((l) => /^a\.json$/m.test(l)));
    assert.ok(s.logs.some((l) => /^b\.json$/m.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: a Harbor job-output directory is walked recursively, skipping dotdirs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-job-'));
  try {
    const raw = readFileSync(REAL_TRAJECTORY, 'utf8');
    mkdirSync(join(dir, 'trial-1', 'agent'), { recursive: true });
    writeFileSync(join(dir, 'trial-1', 'agent', 'trajectory.json'), raw);
    // A dotdir sibling that must be skipped by the walk.
    mkdirSync(join(dir, '.hidden'), { recursive: true });
    writeFileSync(join(dir, '.hidden', 'trajectory.json'), raw);

    const s = spy();
    try {
      await withNoNetwork(() => analyzeAtif({ path: dir, local: true }));
    } finally {
      s.restore();
    }
    assert.ok(s.logs.some((l) => /Analyzing 1 trajectory locally/.test(l)));
    assert.ok(s.logs.some((l) => /trial-1[/\\]agent[/\\]trajectory\.json/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: Harbor root metadata JSON cannot mask nested trajectories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-harbor-root-'));
  try {
    const raw = readFileSync(REAL_TRAJECTORY, 'utf8');
    for (const filename of ['config.json', 'lock.json', 'result.json']) {
      writeFileSync(join(dir, filename), JSON.stringify({ kind: 'harbor-metadata' }));
    }
    mkdirSync(join(dir, 'trials', 'trial-1', 'agent'), { recursive: true });
    writeFileSync(join(dir, 'trials', 'trial-1', 'agent', 'trajectory.json'), raw);

    const s = spy();
    try {
      await withNoNetwork(() => analyzeAtif({ path: dir, local: true }));
      assert.equal(s.exitCode, null);
    } finally {
      s.restore();
    }
    const output = s.logs.join('\n');
    assert.match(output, /Analyzing 1 trajectory locally/);
    assert.match(output, /trials[/\\]trial-1[/\\]agent[/\\]trajectory\.json/);
    assert.doesNotMatch(output, /config\.json|lock\.json|result\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: unsafe, missing, cyclic, and invalid continuation refs fail before network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-continuation-safety-'));
  try {
    const missing = join(dir, 'missing');
    mkdirSync(missing);
    writeFileSync(
      join(missing, 'trajectory.json'),
      JSON.stringify(minimalTrajectory({ continued_trajectory_ref: 'missing.json' })),
    );
    await expectDiscoveryFailureWithoutNetwork(
      join(missing, 'trajectory.json'),
      /Missing ATIF continued_trajectory_ref/,
    );

    const absolute = join(dir, 'absolute');
    mkdirSync(absolute);
    const absoluteContinuation = join(absolute, 'continuation.json');
    writeFileSync(absoluteContinuation, JSON.stringify(minimalTrajectory()));
    writeFileSync(
      join(absolute, 'trajectory.json'),
      JSON.stringify(minimalTrajectory({ continued_trajectory_ref: absoluteContinuation })),
    );
    await expectDiscoveryFailureWithoutNetwork(
      join(absolute, 'trajectory.json'),
      /continued_trajectory_ref must be relative/,
    );

    const escape = join(dir, 'escape');
    mkdirSync(escape);
    writeFileSync(join(dir, 'outside.json'), JSON.stringify(minimalTrajectory()));
    writeFileSync(
      join(escape, 'trajectory.json'),
      JSON.stringify(minimalTrajectory({ continued_trajectory_ref: '../outside.json' })),
    );
    await expectDiscoveryFailureWithoutNetwork(
      join(escape, 'trajectory.json'),
      /continued_trajectory_ref escapes agent directory/,
    );

    const cycle = join(dir, 'cycle');
    mkdirSync(cycle);
    writeFileSync(
      join(cycle, 'trajectory.json'),
      JSON.stringify(minimalTrajectory({ continued_trajectory_ref: 'continuation.json' })),
    );
    writeFileSync(
      join(cycle, 'continuation.json'),
      JSON.stringify(minimalTrajectory({ continued_trajectory_ref: 'trajectory.json' })),
    );
    await expectDiscoveryFailureWithoutNetwork(
      join(cycle, 'trajectory.json'),
      /continued_trajectory_ref cycle detected/,
    );

    const invalid = join(dir, 'invalid');
    mkdirSync(invalid);
    writeFileSync(
      join(invalid, 'trajectory.json'),
      JSON.stringify(minimalTrajectory({ continued_trajectory_ref: '  ' })),
    );
    await expectDiscoveryFailureWithoutNetwork(
      join(invalid, 'trajectory.json'),
      /continued_trajectory_ref must be a non-empty string/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: continuation chains are bounded before authentication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-continuation-bound-'));
  try {
    for (let index = 0; index <= 128; index += 1) {
      writeFileSync(
        join(dir, `segment-${index}.json`),
        JSON.stringify(
          minimalTrajectory(
            index < 128 ? { continued_trajectory_ref: `segment-${index + 1}.json` } : {},
          ),
        ),
      );
    }
    await expectDiscoveryFailureWithoutNetwork(
      join(dir, 'segment-0.json'),
      /continuation chain exceeds 128 segments/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: selected agent and flat-file symlinks cannot escape before network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-symlink-boundary-'));
  try {
    const outsideAgent = join(dir, 'outside-agent');
    mkdirSync(outsideAgent);
    writeFileSync(join(outsideAgent, 'trajectory.json'), JSON.stringify(minimalTrajectory()));

    const selectedAgentLink = join(dir, 'selected-agent-link');
    mkdirSync(selectedAgentLink);
    symlinkSync(outsideAgent, join(selectedAgentLink, 'agent'), 'dir');
    await expectDiscoveryFailureWithoutNetwork(selectedAgentLink, /escapes the selected directory/);

    const selectedFlatLink = join(dir, 'selected-flat-link');
    mkdirSync(selectedFlatLink);
    symlinkSync(join(outsideAgent, 'trajectory.json'), join(selectedFlatLink, 'leak.json'), 'file');
    await expectDiscoveryFailureWithoutNetwork(
      selectedFlatLink,
      /trajectory root escapes the selected directory/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: broken agent links and over-depth trees fail instead of looking complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-discovery-completeness-'));
  try {
    const broken = join(dir, 'broken');
    mkdirSync(broken);
    symlinkSync(join(dir, 'does-not-exist'), join(broken, 'agent'), 'dir');
    await expectDiscoveryFailureWithoutNetwork(broken, /Could not resolve ATIF symlink/);

    const tooDeep = join(dir, 'too-deep');
    mkdirSync(tooDeep);
    let nested = tooDeep;
    for (let index = 0; index < 8; index += 1) {
      nested = join(nested, `level-${index}`);
      mkdirSync(nested);
    }
    await expectDiscoveryFailureWithoutNetwork(tooDeep, /discovery exceeds maximum depth 6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: an unreadable subtree fails before authentication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-unreadable-'));
  const unreadable = join(dir, 'unreadable');
  try {
    mkdirSync(unreadable);
    chmodSync(unreadable, 0o000);
    await expectDiscoveryFailureWithoutNetwork(dir, /Could not read ATIF directory/);
  } finally {
    chmodSync(unreadable, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: fails clearly on an empty directory and on a nonexistent path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-empty-'));
  try {
    const s1 = spy();
    try {
      await analyzeAtif({ path: dir, local: true });
      assert.fail('expected process.exit');
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    } finally {
      s1.restore();
    }
    assert.equal(s1.exitCode, 1);
    assert.ok(s1.errs.some((l) => /No trajectories found/.test(l)));

    const s2 = spy();
    try {
      await analyzeAtif({ path: join(dir, 'does-not-exist'), local: true });
      assert.fail('expected process.exit');
    } catch (e) {
      assert.equal((e as Error).message, '__exit__');
    } finally {
      s2.restore();
    }
    assert.equal(s2.exitCode, 1);
    assert.ok(s2.errs.some((l) => /No such file or directory/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
