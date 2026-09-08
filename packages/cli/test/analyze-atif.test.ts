import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { v1Detectors } from '@pisama/detectors';
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
const TOPOLOGY_FREE_TRAJECTORY = resolve(
  here,
  'fixtures',
  'atif',
  'continuation',
  'trajectory.cont-1.json',
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

function minimalTrajectory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'ATIF-v1.7',
    session_id: 'NORMALIZED_SESSION_ID',
    agent: { name: 'test', version: '1', model_name: 'test-model' },
    steps: [{ step_id: 1, source: 'user', message: 'test' }],
    ...overrides,
  };
}

function trajectoryWithSubagentRefs(
  sessionId: string,
  references: Array<{ trajectory_id?: string; trajectory_path?: string }>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return minimalTrajectory({
    session_id: sessionId,
    steps: [
      {
        step_id: 1,
        source: 'user',
        message: 'delegate this task',
        observation: { results: [{ subagent_trajectory_ref: references }] },
      },
    ],
    ...overrides,
  });
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

test('analyze-atif --local runs detectors but fails closed on a real Harbor file with missing refs', async () => {
  const s = spy();
  try {
    try {
      await withNoNetwork(() => analyzeAtif({ path: REAL_TRAJECTORY, local: true }));
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
  } finally {
    s.restore();
  }

  // The fixture's real tool-call sequence is 5x consecutive `bash_command`
  // then 2x `mark_task_complete` (steps 5-6 have no tool_calls and are
  // skipped by the AgentTrace projection). That's MIN_CONSECUTIVE_CRIT
  // exactly, so the loop detector's own severity formula gives 50 (medium),
  // not >=65 (high) -- so this should NOT exit non-zero. If it did, either
  // the severity mapping or the detector wiring regressed.
  assert.equal(s.exitCode, 1, 'missing referenced trajectories make the local result incomplete');
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
  assert.match(out, /Trajectory topology is incomplete; result is not clean/);
  assert.match(out, /trajectory\.summarization-1-summary\.json/);
  assert.doesNotMatch(out, /No critical\/high-severity failures/);
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
    agent: { name: 'clean', version: '1', model_name: 'claude-sonnet-4-6' },
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

test('analyze-atif --local flattens valid multimodal content and cannot false-clean', async () => {
  const repeated = 'This sufficiently long answer line repeats exactly.';
  const trajectory = {
    schema_version: 'ATIF-v1.7',
    session_id: 'multimodal-session',
    agent: { name: 'multimodal', version: '1', model_name: 'test-model' },
    steps: [
      {
        step_id: 1,
        source: 'user',
        message: [
          { type: 'text', text: 'Write a concise answer about this image.' },
          { type: 'image', source: { media_type: 'image/png', path: 'fixture.png' } },
        ],
      },
      {
        step_id: 2,
        source: 'agent',
        message: [
          { type: 'text', text: repeated },
          { type: 'text', text: repeated },
          { type: 'text', text: repeated },
          { type: 'text', text: repeated },
        ],
      },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-multimodal-'));
  const file = join(dir, 'trajectory.json');
  writeFileSync(file, JSON.stringify(trajectory));
  const s = spy();
  try {
    try {
      await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    assert.match(s.logs.join('\n'), /repetition[\s\S]*Line repeated 4x/);
    assert.match(s.logs.join('\n'), /critical\/high-severity detection fired/);
    assert.doesNotMatch(s.logs.join('\n'), /No detections|No critical\/high-severity failures/);
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif --local rejects malformed projection inputs before any clean result', async () => {
  const agentStep = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    step_id: 1,
    source: 'agent',
    message: 'done',
    ...overrides,
  });
  const cases: Array<{ name: string; trajectory: Record<string, unknown> }> = [
    { name: 'invalid session identity', trajectory: minimalTrajectory({ session_id: {} }) },
    { name: 'invalid trajectory identity', trajectory: minimalTrajectory({ trajectory_id: [] }) },
    { name: 'missing agent', trajectory: minimalTrajectory({ agent: undefined }) },
    {
      name: 'missing agent version',
      trajectory: minimalTrajectory({ agent: { name: 'test' } }),
    },
    { name: 'empty steps', trajectory: minimalTrajectory({ steps: [] }) },
    {
      name: 'non-sequential step',
      trajectory: minimalTrajectory({ steps: [{ step_id: 2, source: 'user', message: 'x' }] }),
    },
    {
      name: 'invalid message',
      trajectory: minimalTrajectory({ steps: [{ step_id: 1, source: 'user', message: {} }] }),
    },
    {
      name: 'invalid content part',
      trajectory: minimalTrajectory({
        steps: [{ step_id: 1, source: 'user', message: [{ type: 'text', text: null }] }],
      }),
    },
    {
      name: 'legacy date string',
      trajectory: minimalTrajectory({
        steps: [
          {
            step_id: 1,
            source: 'user',
            message: 'test',
            timestamp: 'December 17, 1995 03:24:00',
          },
        ],
      }),
    },
    {
      name: 'normalized invalid date',
      trajectory: minimalTrajectory({
        steps: [{ step_id: 1, source: 'user', message: 'test', timestamp: '2020-02-30T00:00:00Z' }],
      }),
    },
    {
      name: 'non-agent model',
      trajectory: minimalTrajectory({
        steps: [{ step_id: 1, source: 'user', message: 'test', model_name: 'not-allowed' }],
      }),
    },
    {
      name: 'invalid model type',
      trajectory: minimalTrajectory({ steps: [agentStep({ model_name: {} })] }),
    },
    {
      name: 'invalid token string',
      trajectory: minimalTrajectory({ steps: [agentStep({ metrics: { prompt_tokens: '' } })] }),
    },
    {
      name: 'invalid token array',
      trajectory: minimalTrajectory({ steps: [agentStep({ metrics: { prompt_tokens: [] } })] }),
    },
    {
      name: 'invalid token boolean',
      trajectory: minimalTrajectory({ steps: [agentStep({ metrics: { prompt_tokens: true } })] }),
    },
    {
      name: 'fractional token count',
      trajectory: minimalTrajectory({ steps: [agentStep({ metrics: { prompt_tokens: 1.5 } })] }),
    },
    {
      name: 'invalid cost string',
      trajectory: minimalTrajectory({ steps: [agentStep({ metrics: { cost_usd: '0.2' } })] }),
    },
    {
      name: 'non-agent metrics',
      trajectory: minimalTrajectory({
        steps: [{ step_id: 1, source: 'user', message: 'test', metrics: { prompt_tokens: 1 } }],
      }),
    },
    {
      name: 'zero call count with metrics',
      trajectory: minimalTrajectory({
        steps: [agentStep({ llm_call_count: 0, metrics: { prompt_tokens: 1 } })],
      }),
    },
    {
      name: 'unknown observation tool call',
      trajectory: minimalTrajectory({
        steps: [
          agentStep({
            tool_calls: [{ tool_call_id: 'known', function_name: 'lookup', arguments: { q: 'x' } }],
            observation: { results: [{ source_call_id: 'missing', content: 'not found' }] },
          }),
        ],
      }),
    },
    {
      name: 'invalid subagent reference collection',
      trajectory: minimalTrajectory({
        steps: [
          {
            step_id: 1,
            source: 'user',
            message: 'delegate',
            observation: { results: [{ subagent_trajectory_ref: {} }] },
          },
        ],
      }),
    },
    {
      name: 'unresolvable subagent reference',
      trajectory: trajectoryWithSubagentRefs('invalid-subagent', [{}]),
    },
    {
      name: 'invalid embedded collection',
      trajectory: minimalTrajectory({ subagent_trajectories: {} }),
    },
    {
      name: 'invalid final metric',
      trajectory: minimalTrajectory({ final_metrics: { total_completion_tokens: {} } }),
    },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-invalid-local-'));
  try {
    for (const entry of cases) {
      const file = join(dir, `${entry.name.replaceAll(' ', '-')}.json`);
      writeFileSync(file, JSON.stringify(entry.trajectory));
      const s = spy();
      try {
        try {
          await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
          assert.fail('expected process.exit');
        } catch (error) {
          assert.equal((error as Error).message, '__exit__', entry.name);
        }
        assert.equal(s.exitCode, 1, entry.name);
        assert.ok(s.errs.some((line) => /invalid ATIF trajectory for --local/.test(line)));
        assert.doesNotMatch(s.logs.join('\n'), /No detections|No critical\/high-severity failures/);
      } finally {
        s.restore();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif --local falls back from explicit null final totals to step metrics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-null-final-metrics-'));
  const file = join(dir, 'trajectory.json');
  writeFileSync(
    file,
    JSON.stringify(
      minimalTrajectory({
        agent: { name: 'test', version: '1', model_name: 'test-model' },
        steps: [
          {
            step_id: 1,
            source: 'agent',
            message: 'done',
            metrics: { prompt_tokens: 17_001, completion_tokens: 0, cost_usd: 2 },
          },
        ],
        final_metrics: {
          total_prompt_tokens: null,
          total_completion_tokens: null,
          total_cost_usd: null,
        },
      }),
    ),
  );
  const s = spy();
  try {
    try {
      await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    const output = s.logs.join('\n');
    assert.match(output, /HIGH/);
    assert.match(output, /High token usage: 17001 tokens/);
    assert.doesNotMatch(output, /No detections|No critical\/high-severity failures/);
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif --local reports detector exceptions as incomplete and exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-detector-error-'));
  const file = join(dir, 'trajectory.json');
  writeFileSync(file, JSON.stringify(minimalTrajectory()));
  v1Detectors.push({
    name: 'forced_failure',
    description: 'test-only throwing detector',
    detect: () => {
      throw new Error('forced detector failure');
    },
  });
  const s = spy();
  try {
    try {
      await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    const output = s.logs.join('\n');
    assert.match(output, /Detection analysis partial; result is incomplete/);
    assert.match(output, /detectors_failed: forced_failure/);
    assert.match(output, /0 confirmed detections returned; result is not clean/);
    assert.doesNotMatch(output, /No detections|No critical\/high-severity failures/);
  } finally {
    s.restore();
    assert.equal(v1Detectors.pop()?.name, 'forced_failure');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif --local rejects explicit null, empty, and unknown schema versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-'));
  try {
    for (const [index, schemaVersion] of [null, '', 'ATIF-v99.0'].entries()) {
      const file = join(dir, `bad-schema-${index}.json`);
      writeFileSync(file, JSON.stringify(minimalTrajectory({ schema_version: schemaVersion })));
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
      assert.ok(s.errs.some((line) => /unsupported schema_version/.test(line)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif --local defaults an omitted schema to v1.7 in memory only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-default-schema-local-'));
  const file = join(dir, 'trajectory.json');
  const trajectory = minimalTrajectory();
  delete trajectory.schema_version;
  const raw = JSON.stringify(trajectory);
  writeFileSync(file, raw);
  const s = spy();
  try {
    await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
    assert.equal(s.exitCode, null);
    assert.match(s.logs.join('\n'), /schema ATIF-v1\.7/);
    assert.equal(readFileSync(file, 'utf8'), raw);
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif --local uses the backend identity priority and a deterministic anonymous fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-local-identity-'));
  const cases: Array<{
    name: string;
    trajectory: Record<string, unknown>;
    expectedKey?: string;
  }> = [
    {
      name: 'session wins over trajectory',
      trajectory: minimalTrajectory({
        session_id: 'primary-session',
        trajectory_id: 'secondary-id',
      }),
      expectedKey: 'primary-session',
    },
    {
      name: 'empty trajectory falls through to session',
      trajectory: minimalTrajectory({ session_id: 'nonempty-session', trajectory_id: '' }),
      expectedKey: 'nonempty-session',
    },
    {
      name: 'continuation session normalizes',
      trajectory: minimalTrajectory({
        session_id: 'logical-session-cont-12',
        trajectory_id: 'secondary',
      }),
      expectedKey: 'logical-session',
    },
    {
      name: 'anonymous source bytes',
      trajectory: minimalTrajectory({ session_id: '', trajectory_id: '' }),
    },
  ];
  try {
    for (const entry of cases) {
      const file = join(dir, `${entry.name.replaceAll(' ', '-')}.json`);
      const raw = JSON.stringify(entry.trajectory);
      writeFileSync(file, raw);
      const anonymousKey = `pisama-anonymous-${createHash('sha256')
        .update('pisama:atif:anonymous-source:v1\0', 'utf8')
        .update(raw, 'utf8')
        .digest('hex')}`;
      const expectedTrace = mockTraceId(entry.expectedKey ?? anonymousKey);
      const s = spy();
      try {
        await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
        assert.equal(s.exitCode, null, entry.name);
        assert.match(s.logs.join('\n'), new RegExp(`trace_id ${expectedTrace}`), entry.name);
      } finally {
        s.restore();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('analyze-atif rejects invalid UTF-8 bytes before authentication or analysis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-invalid-utf8-'));
  try {
    for (const [index, invalidBytes] of [Buffer.from([0xff]), Buffer.from([0xfe])].entries()) {
      const file = join(dir, `invalid-utf8-${index}.json`);
      writeFileSync(
        file,
        Buffer.concat([
          Buffer.from('{"schema_version":"ATIF-v1.7","message":"', 'utf8'),
          invalidBytes,
          Buffer.from('"}', 'utf8'),
        ]),
      );
      await expectDiscoveryFailureWithoutNetwork(file, /trajectory file is not valid UTF-8/);
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
    try {
      await withNoNetwork(() => analyzeAtif({ path: REAL_CONTINUATION_ROOT, local: true }));
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
  } finally {
    s.restore();
  }
  const output = s.logs.join('\n');
  assert.match(output, /Analyzing 2 trajectories locally/);
  assert.ok(output.indexOf('trajectory.json') < output.indexOf('trajectory.cont-1.json'));
  assert.match(
    output,
    /trajectory\.json[\s\S]*0 confirmed detections returned; result is not clean/,
  );
  assert.match(output, /trajectory\.cont-1\.json[\s\S]*High token usage: 8832 tokens/);
  assert.match(output, /Summary: 2 trajectories, 1 total detection\(s\)/);
  assert.match(output, /Trajectory topology is incomplete; result is not clean/);
  assert.doesNotMatch(output, /No critical\/high-severity failures/);
});

test('analyze-atif --local reconciles a selected file-backed subagent by canonical path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-local-subagent-selected-'));
  writeFileSync(
    join(dir, 'root.json'),
    JSON.stringify(
      trajectoryWithSubagentRefs('root-session', [
        { trajectory_id: 'external-child', trajectory_path: 'child.json' },
      ]),
    ),
  );
  writeFileSync(
    join(dir, 'child.json'),
    JSON.stringify(minimalTrajectory({ session_id: 'child' })),
  );
  const s = spy();
  try {
    await withNoNetwork(() => analyzeAtif({ path: dir, local: true }));
    assert.equal(s.exitCode, null);
    const output = s.logs.join('\n');
    assert.match(output, /selected trajectory refs: child\.json/);
    assert.doesNotMatch(output, /topology is incomplete|result is not clean/);
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif --local keeps missing, escaping, ID-only, and mixed-provenance refs incomplete', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-local-subagent-unsafe-'));
  const outside = join(parent, 'outside.json');
  writeFileSync(outside, JSON.stringify(minimalTrajectory({ session_id: 'outside' })));
  const cases: Array<{
    name: string;
    references: Array<{ trajectory_id?: string; trajectory_path?: string }>;
    symlink?: boolean;
  }> = [
    { name: 'missing', references: [{ trajectory_path: 'missing.atif' }] },
    { name: 'escaping', references: [{ trajectory_path: '../outside.json' }] },
    { name: 'id-only', references: [{ trajectory_id: 'child.json' }] },
    {
      name: 'path-and-id-collision',
      references: [{ trajectory_path: 'child.json' }, { trajectory_id: 'child.json' }],
    },
    {
      name: 'escaping-symlink',
      references: [{ trajectory_path: 'outside-link.atif' }],
      symlink: true,
    },
  ];
  try {
    for (const entry of cases) {
      const dir = join(parent, entry.name);
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'root.json'),
        JSON.stringify(trajectoryWithSubagentRefs(`root-${entry.name}`, entry.references)),
      );
      writeFileSync(
        join(dir, 'child.json'),
        JSON.stringify(minimalTrajectory({ session_id: `child-${entry.name}` })),
      );
      if (entry.symlink) symlinkSync(outside, join(dir, 'outside-link.atif'));
      const s = spy();
      try {
        try {
          await withNoNetwork(() => analyzeAtif({ path: dir, local: true }));
          assert.fail('expected process.exit');
        } catch (error) {
          assert.equal((error as Error).message, '__exit__', entry.name);
        }
        assert.equal(s.exitCode, 1, entry.name);
        const output = s.logs.join('\n');
        assert.match(output, /Trajectory topology is incomplete; result is not clean/, entry.name);
        assert.match(
          output,
          /At least one analysis had incomplete detector or topology evidence/,
          entry.name,
        );
        assert.doesNotMatch(output, /No critical\/high-severity failures/, entry.name);
      } finally {
        s.restore();
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('analyze-atif --local fails closed on embedded subagent content it does not analyze', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-local-embedded-'));
  const file = join(dir, 'trajectory.json');
  const embedded = minimalTrajectory({
    session_id: 'embedded-session',
    trajectory_id: 'embedded-child',
    agent: { name: 'embedded', version: '1', model_name: 'test-model' },
    steps: [
      {
        step_id: 1,
        source: 'agent',
        message: 'done',
        metrics: { prompt_tokens: 17_001, completion_tokens: 0, cost_usd: 2 },
      },
    ],
  });
  writeFileSync(
    file,
    JSON.stringify(
      trajectoryWithSubagentRefs('root-embedded', [{ trajectory_id: 'embedded-child' }], {
        subagent_trajectories: [embedded],
      }),
    ),
  );
  const s = spy();
  try {
    try {
      await withNoNetwork(() => analyzeAtif({ path: file, local: true }));
      assert.fail('expected process.exit');
    } catch (error) {
      assert.equal((error as Error).message, '__exit__');
    }
    assert.equal(s.exitCode, 1);
    const output = s.logs.join('\n');
    assert.match(output, /Detection analysis partial; result is incomplete/);
    assert.match(output, /detectors_failed: embedded_subagent_analysis/);
    assert.doesNotMatch(output, /No detections|No critical\/high-severity failures/);
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
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

function mockTraceId(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
}

function mockAnalyzeResponse(overrides: {
  detections?: MockDiagnosisDetection[];
  detectionStatus?: string;
  detectorsRun?: string[];
  detectorsFailed?: Record<string, string>;
  topologyComplete?: boolean;
  unresolvedTrajectoryRefs?: string[];
  healing?: Record<string, unknown> | null;
  traceId?: string;
  schemaVersion?: string;
  sessionId?: string | null;
  trajectoryId?: string | null;
}): Record<string, unknown> {
  const traceId = overrides.traceId ?? mockTraceId('NORMALIZED_SESSION_ID');
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
      trace_id: traceId,
      has_failures: detections.length > 0,
      failure_count: detections.length,
      detection_status: overrides.detectionStatus ?? 'complete',
      all_detections: detections,
      detectors_run: overrides.detectorsRun ?? ['loop', 'persona_drift'],
      detectors_failed: overrides.detectorsFailed ?? {},
    },
    trace: {
      trace_id: traceId,
      span_count: 3,
      total_tokens: 100,
      atif_schema_version: overrides.schemaVersion ?? 'ATIF-v1.7',
      atif_session_id:
        overrides.sessionId === undefined ? 'NORMALIZED_SESSION_ID' : overrides.sessionId,
      atif_trajectory_id: overrides.trajectoryId ?? null,
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
      () =>
        analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'k-1', baseUrl: 'https://test/' }),
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

test('analyze-atif (remote) defaults an omitted schema to v1.7 in memory and binds the echo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-default-schema-hosted-'));
  const file = join(dir, 'trajectory.json');
  const trajectory = minimalTrajectory();
  delete trajectory.schema_version;
  const raw = JSON.stringify(trajectory);
  writeFileSync(file, raw);
  let submittedSchema = '';
  const s = spy();
  try {
    await withMockFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          trajectory: { schema_version: string; session_id: string; trajectory_id?: string };
        };
        submittedSchema = body.trajectory.schema_version;
        return jsonResponse(
          mockAnalyzeResponse({
            traceId: mockTraceId(body.trajectory.session_id),
            schemaVersion: body.trajectory.schema_version,
            sessionId: body.trajectory.session_id,
            trajectoryId: body.trajectory.trajectory_id ?? null,
          }),
        );
      },
      () => analyzeAtif({ path: file, apiKey: 'key', baseUrl: 'https://test' }),
    );
    assert.equal(s.exitCode, null);
    assert.equal(submittedSchema, 'ATIF-v1.7');
    assert.match(s.logs.join('\n'), /schema ATIF-v1\.7/);
    assert.equal(readFileSync(file, 'utf8'), raw);
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif (remote) binds response identity for continuations and trajectory-only documents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-identity-'));
  try {
    writeFileSync(
      join(dir, 'continuation.json'),
      JSON.stringify(minimalTrajectory({ session_id: 'logical-run-cont-12' })),
    );
    writeFileSync(
      join(dir, 'trajectory-only.json'),
      JSON.stringify(minimalTrajectory({ session_id: null, trajectory_id: 'document-9' })),
    );

    const s = spy();
    try {
      await withMockFetch(
        (_url, init) => {
          const body = JSON.parse(String(init?.body)) as {
            trajectory: {
              schema_version: string;
              session_id?: string | null;
              trajectory_id?: string;
            };
          };
          const trajectory = body.trajectory;
          const identity = trajectory.session_id
            ? trajectory.session_id.replace(/-cont-\d+$/, '')
            : trajectory.trajectory_id!;
          return jsonResponse(
            mockAnalyzeResponse({
              traceId: mockTraceId(identity),
              schemaVersion: trajectory.schema_version,
              sessionId: trajectory.session_id ?? null,
              trajectoryId: trajectory.trajectory_id ?? null,
            }),
          );
        },
        () => analyzeAtif({ path: dir, apiKey: 'key', baseUrl: 'https://test' }),
      );
      assert.equal(s.exitCode, null);
    } finally {
      s.restore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif (remote) reconciles a nested file-backed subagent selected from Harbor output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-hosted-nested-selected-'));
  const rootAgent = join(dir, 'trial-root', 'agent');
  const childAgent = join(dir, 'trial-child', 'agent');
  mkdirSync(rootAgent, { recursive: true });
  mkdirSync(childAgent, { recursive: true });
  const externalReference = '../../trial-child/agent/trajectory.json';
  const embedded = trajectoryWithSubagentRefs(
    'embedded-session',
    [{ trajectory_id: 'nested-external-id', trajectory_path: externalReference }],
    { trajectory_id: 'embedded-child' },
  );
  writeFileSync(
    join(rootAgent, 'trajectory.json'),
    JSON.stringify(
      minimalTrajectory({
        session_id: 'hosted-root',
        subagent_trajectories: [embedded],
      }),
    ),
  );
  writeFileSync(
    join(childAgent, 'trajectory.json'),
    JSON.stringify(minimalTrajectory({ session_id: 'hosted-external-child' })),
  );
  const s = spy();
  try {
    await withMockFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          trajectory: {
            schema_version: string;
            session_id: string;
            trajectory_id?: string;
          };
        };
        const trajectory = body.trajectory;
        const unresolved = trajectory.session_id === 'hosted-root' ? [externalReference] : [];
        return jsonResponse(
          mockAnalyzeResponse({
            traceId: mockTraceId(trajectory.session_id),
            schemaVersion: trajectory.schema_version,
            sessionId: trajectory.session_id,
            trajectoryId: trajectory.trajectory_id ?? null,
            topologyComplete: unresolved.length === 0,
            unresolvedTrajectoryRefs: unresolved,
          }),
        );
      },
      () => analyzeAtif({ path: dir, apiKey: 'key', baseUrl: 'https://test' }),
    );
    assert.equal(s.exitCode, null);
    const output = s.logs.join('\n');
    assert.match(
      output,
      /selected trajectory refs: \.\.\/\.\.\/trial-child\/agent\/trajectory\.json/,
    );
    assert.doesNotMatch(output, /topology is incomplete|result is not clean/);
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif (remote) gives anonymous source bytes a stable, bound request identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-anonymous-'));
  const file = join(dir, 'anonymous.json');
  const compact =
    '{"schema_version":"ATIF-v1.7","agent":{"name":"anonymous","version":"1"},' +
    '"steps":[{"step_id":1,"source":"user","message":"héllo"}]}';
  const reformatted = JSON.stringify(JSON.parse(compact), null, 2);
  writeFileSync(file, compact);
  const submittedIds: string[] = [];
  const s = spy();
  try {
    await withMockFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          trajectory: { schema_version: string; session_id?: string | null; trajectory_id: string };
        };
        const trajectory = body.trajectory;
        submittedIds.push(trajectory.trajectory_id);
        return jsonResponse(
          mockAnalyzeResponse({
            traceId: mockTraceId(trajectory.trajectory_id),
            schemaVersion: trajectory.schema_version,
            sessionId: trajectory.session_id ?? null,
            trajectoryId: trajectory.trajectory_id,
          }),
        );
      },
      async () => {
        await analyzeAtif({ path: file, apiKey: 'key', baseUrl: 'https://test' });
        assert.equal(readFileSync(file, 'utf8'), compact, 'the source file must not be mutated');
        await analyzeAtif({ path: file, apiKey: 'key', baseUrl: 'https://test' });
        writeFileSync(file, reformatted);
        await analyzeAtif({ path: file, apiKey: 'key', baseUrl: 'https://test' });
      },
    );
    assert.equal(s.exitCode, null);
    assert.equal(submittedIds.length, 3);
    const expectedId = `pisama-anonymous-${createHash('sha256')
      .update('pisama:atif:anonymous-source:v1\0', 'utf8')
      .update(Buffer.from(compact, 'utf8'))
      .digest('hex')}`;
    assert.equal(submittedIds[0], expectedId);
    assert.equal(submittedIds[0], submittedIds[1], 'the same bytes must be idempotent');
    assert.notEqual(
      submittedIds[0],
      submittedIds[2],
      'byte-only reformatting must change identity',
    );
    assert.doesNotMatch(submittedIds.join('\n'), /anonymous\.json|héllo/);
    assert.equal(
      readFileSync(file, 'utf8'),
      reformatted,
      'the reformatted file must stay unchanged',
    );
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze-atif (remote) treats explicit null and empty IDs as anonymous', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-empty-identity-'));
  const file = join(dir, 'anonymous.json');
  const submittedIds: string[] = [];
  const s = spy();
  try {
    await withMockFetch(
      (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          trajectory: { schema_version: string; session_id: string | null; trajectory_id: string };
        };
        submittedIds.push(body.trajectory.trajectory_id);
        return jsonResponse(
          mockAnalyzeResponse({
            traceId: mockTraceId(body.trajectory.trajectory_id),
            sessionId: body.trajectory.session_id,
            trajectoryId: body.trajectory.trajectory_id,
          }),
        );
      },
      async () => {
        for (const identity of [
          { session_id: null, trajectory_id: null },
          { session_id: '', trajectory_id: '' },
        ]) {
          writeFileSync(
            file,
            JSON.stringify({
              schema_version: 'ATIF-v1.7',
              ...identity,
              agent: { name: 'anonymous', version: '1' },
              steps: [{ step_id: 1, source: 'user', message: 'hello' }],
            }),
          );
          await analyzeAtif({ path: file, apiKey: 'key', baseUrl: 'https://test' });
        }
      },
    );
    assert.equal(s.exitCode, null);
    assert.equal(submittedIds.length, 2);
    for (const submittedId of submittedIds) {
      assert.match(submittedId, /^pisama-anonymous-[a-f0-9]{64}$/);
    }
    assert.notEqual(submittedIds[0], submittedIds[1], 'distinct source bytes get distinct IDs');
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
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
                unresolvedTrajectoryRefs: [
                  'trajectory.summarization-1-summary.json',
                  'trajectory.summarization-1-questions.json',
                  'trajectory.summarization-1-answers.json',
                  'trajectory.cont-1.json',
                ],
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
  assert.match(output, /selected trajectory refs: trajectory\.cont-1\.json/);
  assert.match(output, /completion_misjudgment/);
  assert.match(output, /At least one analysis had incomplete detector or topology evidence/);
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
        () => analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
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
        () => analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
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

test('analyze-atif (remote) requires the backend-exact nested subagent topology', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pisama-analyze-atif-nested-topology-'));
  const trajectoryPath = join(dir, 'trajectory.json');
  const trajectory = minimalTrajectory({
    steps: [
      {
        observation: {
          results: [
            {
              subagent_trajectory_ref: [
                {
                  trajectory_id: 'embedded-child',
                  trajectory_path: 'embedded-child-path-is-resolved.json',
                },
                { trajectory_id: 'top-id' },
                { trajectory_id: 'top-both-id', trajectory_path: 'top-path.json' },
              ],
            },
          ],
        },
      },
    ],
    subagent_trajectories: [
      minimalTrajectory({
        trajectory_id: 'embedded-child',
        steps: [
          {
            observation: {
              results: [
                {
                  subagent_trajectory_ref: [
                    {
                      trajectory_id: 'nested-embedded',
                      trajectory_path: 'nested-embedded-path-is-resolved.json',
                    },
                    { trajectory_id: 'nested-id' },
                    {
                      trajectory_id: 'nested-both-id',
                      trajectory_path: 'nested-path.json',
                    },
                  ],
                },
              ],
            },
          },
        ],
        continued_trajectory_ref: 'nested-continuation.json',
        subagent_trajectories: [minimalTrajectory({ trajectory_id: 'nested-embedded' })],
      }),
    ],
  });
  writeFileSync(trajectoryPath, JSON.stringify(trajectory));

  const exact = [
    'top-id',
    'top-path.json',
    'nested-id',
    'nested-path.json',
    'nested-continuation.json',
  ];
  const invalidCases: Array<{ name: string; refs: string[]; complete: boolean }> = [
    { name: 'complete response omits every subagent ref', refs: [], complete: true },
    {
      name: 'response omits a nested subagent ref',
      refs: exact.filter((ref) => ref !== 'nested-id'),
      complete: false,
    },
    {
      name: 'response uses ID instead of path when both are present',
      refs: exact.map((ref) => (ref === 'top-path.json' ? 'top-both-id' : ref)),
      complete: false,
    },
    {
      name: 'response reports a ref resolved by an immediate embedded child',
      refs: ['embedded-child', ...exact],
      complete: false,
    },
    {
      name: 'response reorders the backend topology contract',
      refs: [...exact].reverse(),
      complete: false,
    },
  ];

  try {
    for (const entry of invalidCases) {
      const s = spy();
      try {
        try {
          await withMockFetch(
            () =>
              jsonResponse(
                mockAnalyzeResponse({
                  topologyComplete: entry.complete,
                  unresolvedTrajectoryRefs: entry.refs,
                }),
              ),
            () => analyzeAtif({ path: trajectoryPath, apiKey: 'key', baseUrl: 'https://test' }),
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
        s.errs.some((line) => /unresolved refs derived from the submitted trajectory/.test(line)),
        `${entry.name}: ${s.errs.join('\n')}`,
      );
      assert.doesNotMatch(s.logs.join('\n'), /No detections|No critical\/high-severity failures/);
    }

    const s = spy();
    try {
      try {
        await withMockFetch(
          () =>
            jsonResponse(
              mockAnalyzeResponse({
                topologyComplete: false,
                unresolvedTrajectoryRefs: exact,
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
    }
    assert.equal(s.exitCode, 1);
    assert.match(
      s.logs.join('\n'),
      /top-id, top-path\.json, nested-id, nested-path\.json, nested-continuation\.json/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const selfConsistentWrongTrace = mockAnalyzeResponse({ traceId: mockTraceId('another-run') });

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
    { name: 'self-consistent trace ID from another source', response: selfConsistentWrongTrace },
    {
      name: 'schema version from another source',
      response: mockAnalyzeResponse({ schemaVersion: 'ATIF-v1.0' }),
    },
    {
      name: 'session ID from another source',
      response: mockAnalyzeResponse({ sessionId: 'different-session' }),
    },
    {
      name: 'trajectory ID from another source',
      response: mockAnalyzeResponse({ trajectoryId: 'different-document' }),
    },
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
          () =>
            analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
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
      () =>
        analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: rawKey, baseUrl: 'https://test' }),
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
      () =>
        analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'secret', baseUrl: 'https://test' }),
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
          path: TOPOLOGY_FREE_TRAJECTORY,
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
      () => analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
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
      () => analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
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
      () => analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
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
      () => analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
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
      () => analyzeAtif({ path: TOPOLOGY_FREE_TRAJECTORY, apiKey: 'k', baseUrl: 'https://test' }),
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
  const base = { path: TOPOLOGY_FREE_TRAJECTORY, apply: true } as const;
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
      path: TOPOLOGY_FREE_TRAJECTORY,
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
            path: TOPOLOGY_FREE_TRAJECTORY,
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
        path: TOPOLOGY_FREE_TRAJECTORY,
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
        path: TOPOLOGY_FREE_TRAJECTORY,
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
          path: TOPOLOGY_FREE_TRAJECTORY,
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
            path: TOPOLOGY_FREE_TRAJECTORY,
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
            path: TOPOLOGY_FREE_TRAJECTORY,
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
            path: TOPOLOGY_FREE_TRAJECTORY,
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
    const trajectory = JSON.parse(readFileSync(TOPOLOGY_FREE_TRAJECTORY, 'utf8'));
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
    writeFileSync(join(agentDir, 'trajectory.json'), JSON.stringify(minimalTrajectory()));

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
    const raw = JSON.stringify(minimalTrajectory());
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
    const raw = JSON.stringify(minimalTrajectory());
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
    const raw = JSON.stringify(minimalTrajectory());
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
