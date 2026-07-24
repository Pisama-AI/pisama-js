/**
 * Tests for MultiAgentDetectors typed clients.
 *
 * We mock fetch and assert:
 *   - request shape (method, path, headers, body)
 *   - typed result is returned with the right category
 *   - auth headers are injected when apiKey + projectId are set
 *   - 4xx and 5xx surface as PisamaBackendError with status
 *   - network errors surface as PisamaBackendError
 *   - input validation rejects malformed inputs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMultiAgentDetectors,
  PisamaBackendError,
  type CoordinationInput,
  type DelegationInput,
  type PersonaInput,
  type ConsensusCollapseInput,
} from './multiAgent/index.js';

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetchMock(
  responder: (req: CapturedRequest) => {
    status: number;
    body: unknown;
  },
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const initHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(initHeaders)) {
      headers[k.toLowerCase()] = initHeaders[k]!;
    }
    const captured: CapturedRequest = {
      url: String(url),
      method: init?.method,
      headers,
      body: init?.body ? JSON.parse(init.body as string) : null,
    };
    calls.push(captured);
    const { status, body } = responder(captured);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const baseResponse = (detections: unknown[] = []) => ({
  trace_id: 't-1',
  analyzed_at: new Date().toISOString(),
  has_failures: detections.length > 0,
  failure_count: detections.length,
  primary_failure: null,
  all_detections: detections,
  total_spans: 1,
  error_spans: 0,
  total_tokens: 0,
  duration_ms: 1,
  detection_time_ms: 1,
  detectors_run: [],
});

// ---- coordination ----

test('coordination: posts to /diagnose/why-failed with typed input and returns typed result', async () => {
  const { fetch, calls } = makeFetchMock(() => ({
    status: 200,
    body: baseResponse([
      {
        category: 'coordination',
        detected: true,
        confidence: 0.91,
        severity: 'high',
        title: 'Coordination breakdown',
        description: 'Agents A and B issued contradictory instructions.',
        evidence: [{ turn: 3, note: 'contradiction' }],
        affected_spans: ['span-2'],
        suggested_fix: 'Introduce explicit message ordering.',
      },
    ]),
  }));

  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: fetch,
  });

  const input: CoordinationInput = {
    agent_ids: ['planner', 'executor'],
    messages: [
      { sender: 'planner', recipient: 'executor', content: 'do X' },
      { sender: 'executor', recipient: 'planner', content: 'doing Y instead' },
    ],
    correlation_id: 'corr-1',
  };
  const result = await det.coordination(input);

  // Request assertions
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://mock.local/api/v1/diagnose/why-failed');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers['content-type'], 'application/json');
  const body = calls[0]!.body as { content: string; format: string };
  assert.equal(body.format, 'raw');
  const innerTrace = JSON.parse(body.content) as Record<string, unknown>;
  assert.equal(innerTrace['detector_hint'], 'coordination');
  assert.deepEqual(innerTrace['agents'], [{ id: 'planner' }, { id: 'executor' }]);
  assert.equal(innerTrace['trace_id'], 'corr-1');

  // Typed result assertions
  assert.equal(result.category, 'coordination');
  assert.equal(result.detected, true);
  assert.equal(result.confidence, 0.91);
  assert.equal(result.severity, 'high');
  assert.equal(result.suggestedFix, 'Introduce explicit message ordering.');
  assert.deepEqual(result.affectedSpans, ['span-2']);
});

test('coordination: returns stub when backend returns no matching detection', async () => {
  const { fetch } = makeFetchMock(() => ({
    status: 200,
    body: baseResponse([]),
  }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: fetch,
  });
  const result = await det.coordination({
    agent_ids: ['a'],
    messages: [],
  });
  assert.equal(result.detected, false);
  assert.equal(result.category, 'coordination');
  assert.equal(result.confidence, 0);
});

test('coordination: validates input', async () => {
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      det.coordination({
        agent_ids: [],
        messages: [],
      }),
    /agent_ids must be a non-empty array/,
  );
});

// ---- delegation ----

test('delegation: posts typed input and surfaces detection by category', async () => {
  const { fetch, calls } = makeFetchMock(() => ({
    status: 200,
    body: baseResponse([
      {
        category: 'delegation',
        detected: true,
        confidence: 0.74,
        severity: 'medium',
        title: 'Vague handoff',
        description: 'Handoff lacks success criteria.',
        evidence: [],
        affected_spans: [],
        suggested_fix: null,
      },
    ]),
  }));

  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: fetch,
  });
  const input: DelegationInput = {
    handoff_instruction: 'Pls handle the user thing',
    context_completeness: 0.3,
    bounds: ['no destructive writes'],
    success_criteria: [],
  };
  const result = await det.delegation(input);

  const body = calls[0]!.body as { content: string };
  const innerTrace = JSON.parse(body.content) as Record<string, unknown>;
  assert.equal(innerTrace['detector_hint'], 'delegation');
  assert.equal(innerTrace['context_completeness'], 0.3);
  assert.deepEqual(innerTrace['bounds'], ['no destructive writes']);
  assert.equal(result.detected, true);
  assert.equal(result.category, 'delegation');
});

test('delegation: validates context_completeness range', async () => {
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      det.delegation({
        handoff_instruction: 'x',
        context_completeness: 1.5,
        bounds: [],
        success_criteria: [],
      }),
    /context_completeness must be a number in \[0, 1\]/,
  );
});

// ---- persona ----

test('persona: posts agent persona + output, maps persona_drift category', async () => {
  const { fetch, calls } = makeFetchMock(() => ({
    status: 200,
    body: baseResponse([
      {
        category: 'persona_drift',
        detected: true,
        confidence: 0.82,
        severity: 'high',
        title: 'Persona drift',
        description: 'Agent broke character.',
        evidence: [{ marker: 'tone shift' }],
        affected_spans: [],
        suggested_fix: 'Reinforce persona in system prompt.',
      },
    ]),
  }));

  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: fetch,
  });
  const input: PersonaInput = {
    agent: {
      id: 'support-bot',
      persona_description: 'polite customer-support agent',
      allowed_actions: ['respond_to_user', 'lookup_order'],
    },
    output: "ugh fine, here's your refund or whatever.",
  };
  const result = await det.persona(input);

  const body = calls[0]!.body as { content: string };
  const innerTrace = JSON.parse(body.content) as Record<string, unknown>;
  const agents = innerTrace['agents'] as Array<Record<string, unknown>>;
  assert.equal(agents[0]!['id'], 'support-bot');
  assert.equal(agents[0]!['persona_description'], 'polite customer-support agent');
  assert.equal(result.category, 'persona_drift');
  assert.equal(result.detected, true);
  assert.equal(result.severity, 'high');
});

// ---- consensus_collapse ----

test('consensus_collapse: posts debate trace and surfaces detection', async () => {
  const { fetch, calls } = makeFetchMock(() => ({
    status: 200,
    body: baseResponse([
      {
        category: 'consensus_collapse',
        detected: true,
        confidence: 0.95,
        severity: 'critical',
        title: 'Consensus collapse',
        description: 'Debate converged on a hallucinated fact via anchor bias.',
        evidence: [{ pattern: 'dropped_dissent' }],
        affected_spans: [],
        suggested_fix: 'Inject adversarial reviewer.',
      },
    ]),
  }));

  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: fetch,
  });
  const input: ConsensusCollapseInput = {
    agent_outputs: [
      { agent_id: 'a', output: 'X is true' },
      { agent_id: 'b', output: 'X is true' },
      { agent_id: 'c', output: 'X is true' },
    ],
    challenge_patterns: ['dropped_dissent', 'anchor_bias'],
    agreement_ratio: 1.0,
    debate_trace: [
      { agent_id: 'a', round: 1, content: 'I think X' },
      { agent_id: 'b', round: 1, content: 'agreed, X' },
      { agent_id: 'c', round: 1, content: 'X for sure' },
    ],
  };
  const result = await det.consensus_collapse(input);

  const body = calls[0]!.body as { content: string };
  const innerTrace = JSON.parse(body.content) as Record<string, unknown>;
  assert.equal(innerTrace['detector_hint'], 'consensus_collapse');
  assert.equal(innerTrace['agreement_ratio'], 1.0);
  assert.deepEqual(innerTrace['challenge_patterns'], ['dropped_dissent', 'anchor_bias']);
  assert.equal(result.category, 'consensus_collapse');
  assert.equal(result.severity, 'critical');
});

test('consensus_collapse: rejects empty agent_outputs', async () => {
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      det.consensus_collapse({
        agent_outputs: [],
        challenge_patterns: [],
        agreement_ratio: 0.5,
        debate_trace: [],
      }),
    /agent_outputs must be a non-empty array/,
  );
});

// ---- auth & errors ----

test('auth headers: bearer token + project id injected when configured', async () => {
  const { fetch, calls } = makeFetchMock(() => ({
    status: 200,
    body: baseResponse([]),
  }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'sk-test-123',
    projectId: 'proj-abc',
    fetchImpl: fetch,
  });
  await det.coordination({
    agent_ids: ['a'],
    messages: [{ sender: 'a', content: 'hi' }],
  });
  assert.equal(calls[0]!.headers['authorization'], 'Bearer sk-test-123');
  assert.equal(calls[0]!.headers['x-pisama-project-id'], 'proj-abc');
});

test('error: 4xx surfaces as PisamaBackendError with status', async () => {
  const { fetch } = makeFetchMock(() => ({
    status: 400,
    body: { detail: 'bad trace shape' },
  }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: fetch,
  });
  await assert.rejects(
    () => det.coordination({ agent_ids: ['a'], messages: [] }),
    (err: unknown) => {
      assert.ok(err instanceof PisamaBackendError);
      assert.equal((err as PisamaBackendError).status, 400);
      assert.deepEqual((err as PisamaBackendError).body, {
        detail: 'bad trace shape',
      });
      return true;
    },
  );
});

test('error: 5xx surfaces as PisamaBackendError', async () => {
  const { fetch } = makeFetchMock(() => ({
    status: 503,
    body: { detail: 'unavailable' },
  }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: fetch,
  });
  await assert.rejects(
    () => det.coordination({ agent_ids: ['a'], messages: [] }),
    (err: unknown) => {
      assert.ok(err instanceof PisamaBackendError);
      assert.equal((err as PisamaBackendError).status, 503);
      return true;
    },
  );
});

test('error: network failure surfaces as PisamaBackendError without status', async () => {
  const failingFetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: failingFetch,
  });
  await assert.rejects(
    () => det.coordination({ agent_ids: ['a'], messages: [] }),
    (err: unknown) => {
      assert.ok(err instanceof PisamaBackendError);
      assert.equal((err as PisamaBackendError).status, undefined);
      assert.match((err as Error).message, /ECONNREFUSED/);
      return true;
    },
  );
});
