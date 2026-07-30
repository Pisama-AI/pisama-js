import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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

test('fixture sanity: the vendored trajectory file still parses as valid JSON', () => {
  const raw = readFileSync(REAL_TRAJECTORY, 'utf8');
  const parsed = JSON.parse(raw) as { schema_version?: string; steps?: unknown[] };
  assert.equal(parsed.schema_version, 'ATIF-v1.7');
  assert.ok(Array.isArray(parsed.steps) && parsed.steps.length > 0);
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
}

function mockAnalyzeResponse(overrides: {
  detections?: MockDiagnosisDetection[];
  healing?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const detections = overrides.detections ?? [];
  return {
    diagnosis: {
      trace_id: 'trace-1',
      has_failures: detections.length > 0,
      failure_count: detections.length,
      detection_status: 'completed',
      all_detections: detections,
      detectors_run: ['loop', 'persona_drift'],
      detectors_failed: {},
    },
    trace: {
      trace_id: 'trace-1',
      span_count: 3,
      total_tokens: 100,
      atif_schema_version: 'ATIF-v1.7',
      atif_session_id: 'sess-1',
      atif_trajectory_id: null,
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

function withMockFetch<T>(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
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
        capturedAuth = (init?.headers as Record<string, string>)?.authorization;
        return jsonResponse(mockAnalyzeResponse({}));
      },
      () => analyzeAtif({ path: REAL_TRAJECTORY, apiKey: 'k-1', baseUrl: 'https://test/' }),
    );
    assert.equal(s.exitCode, null);
  } finally {
    s.restore();
  }
  assert.equal(capturedAuth, 'Bearer k-1');
  assert.ok((capturedBody?.trajectory as { schema_version?: string })?.schema_version);
  const out = s.logs.join('\n');
  assert.match(out, /against https:\/\/test/);
  assert.match(out, /No detections/);
  assert.match(out, /No high-severity failures/);
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
  assert.ok(s.logs.some((l) => /At least one high-severity detection fired/.test(l)));
  assert.ok(s.logs.some((l) => /persona_drift/.test(l)));
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
  assert.ok(s.errs.some((l) => /could not reach https:\/\/test\/api\/v1\/atif\/analyze/.test(l)));
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
    assert.equal(s.exitCode, null);
  } finally {
    s.restore();
  }
  const out = s.logs.join('\n');
  assert.match(out, /rolled back/);
  assert.match(out, /successor agent-2/);
});

test('--apply renders a failed healing with its error', async () => {
  const s = spy();
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
    assert.equal(s.exitCode, null);
  } finally {
    s.restore();
  }
  const out = s.logs.join('\n');
  assert.match(out, /apply failed/);
  assert.match(out, /workflow locked/);
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
