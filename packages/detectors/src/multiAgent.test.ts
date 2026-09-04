/**
 * Tests for MultiAgentDetectors typed clients.
 *
 * We mock fetch and assert:
 *   - request shape (method, path, headers, body)
 *   - typed result is returned with the right category
 *   - the raw API key is exchanged for a full-scoped JWT and never used as bearer auth
 *   - a 401 causes exactly one token refresh with an identical request body/id
 *   - 4xx and 5xx surface as PisamaBackendError with status
 *   - network errors surface as PisamaBackendError
 *   - input validation rejects malformed inputs
 *   - unsupported backend categories are absent from the public API
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMultiAgentDetectors,
  PisamaBackendError,
  type CoordinationInput,
  type PersonaInput,
} from './multiAgent/index.js';
// @ts-expect-error Unsupported operations do not have public input types.
import type { DelegationInput } from './index.js';
// @ts-expect-error Unsupported operations do not have public input types.
import type { ConsensusCollapseInput } from './index.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type PublicDetectorOperation = keyof ReturnType<typeof createMultiAgentDetectors>;
type PublicOperationsAreSupported = Assert<
  Equal<PublicDetectorOperation, 'coordination' | 'persona'>
>;
type RemovedPublicInputs = [DelegationInput, ConsensusCollapseInput];

const publicOperationsAreSupported: PublicOperationsAreSupported = true;
const removedPublicInputs: RemovedPublicInputs | undefined = undefined;

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string | null;
  redirect: RequestRedirect | undefined;
}

const REQUEST_TRACE_ID = '__request_trace_id__';

function scopedToken(scope: string, sequence: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ scope })).toString('base64url');
  return `${header}.${payload}.test-${sequence}`;
}

function bindRequestTraceId(body: unknown, captured: CapturedRequest): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  if ((body as Record<string, unknown>)['trace_id'] !== REQUEST_TRACE_ID) return body;
  const content = (captured.body as { content?: unknown } | null)?.content;
  const submitted = typeof content === 'string' ? JSON.parse(content) : null;
  return {
    ...(body as Record<string, unknown>),
    trace_id: (submitted as { trace_id?: unknown } | null)?.trace_id,
  };
}

function makeFetchMock(
  responder: (req: CapturedRequest) => {
    status: number;
    body: unknown;
  },
): { fetch: typeof fetch; calls: CapturedRequest[]; authCalls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const authCalls: CapturedRequest[] = [];
  const fn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const initHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(initHeaders)) {
      headers[k.toLowerCase()] = initHeaders[k]!;
    }
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const captured: CapturedRequest = {
      url: String(url),
      method: init?.method,
      headers,
      body: rawBody ? JSON.parse(rawBody) : null,
      rawBody,
      redirect: init?.redirect,
    };
    if (captured.url.endsWith('/api/v1/auth/token')) {
      authCalls.push(captured);
      const scope = (captured.body as { scope?: string } | null)?.scope ?? 'unknown';
      return Response.json({ access_token: scopedToken(scope, authCalls.length) });
    }
    calls.push(captured);
    const { status, body } = responder(captured);
    const responseBody = bindRequestTraceId(body, captured);
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls, authCalls };
}

const baseResponse = (
  detections: Array<Record<string, unknown>> = [],
  detector: 'coordination' | 'persona_drift' = detections[0]?.['category'] === 'persona_drift'
    ? 'persona_drift'
    : 'coordination',
) => ({
  trace_id: REQUEST_TRACE_ID,
  detector,
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

test('coordination: posts span-shaped input to its dedicated detector route', async () => {
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
    apiKey: 'pisama_coordination_test_key',
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
  assert.equal(calls[0]!.url, 'http://mock.local/api/v1/diagnose/multi-agent/coordination');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers['content-type'], 'application/json');
  const body = calls[0]!.body as { content: string };
  assert.deepEqual(Object.keys(body), ['content']);
  const innerTrace = JSON.parse(body.content) as Record<string, unknown>;
  assert.equal(innerTrace['detector_hint'], 'coordination');
  assert.equal(innerTrace['trace_id'], 'corr-1');
  assert.deepEqual(innerTrace['metadata'], {
    'pisama.coordination.agent_ids': ['planner', 'executor'],
  });
  assert.deepEqual(innerTrace['spans'], [
    {
      id: 'corr-1-message-1',
      trace_id: 'corr-1',
      parent_id: 'corr-1-root',
      name: 'pisama.agent.message',
      agent_id: 'planner',
      agent_name: 'planner',
      response: 'do X',
      metadata: { 'pisama.message.recipient': 'executor' },
    },
    {
      id: 'corr-1-message-2',
      trace_id: 'corr-1',
      parent_id: 'corr-1-root',
      name: 'pisama.agent.message',
      agent_id: 'executor',
      agent_name: 'executor',
      response: 'doing Y instead',
      metadata: { 'pisama.message.recipient': 'planner' },
    },
  ]);

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
    apiKey: 'pisama_empty_test_key',
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

test('coordination: rejects wrong, duplicate, and malformed backend results instead of reporting clean', async () => {
  const validDetection = {
    category: 'coordination',
    detected: true,
    confidence: 0.8,
    severity: 'high',
    title: 'Coordination breakdown',
    description: 'Agents contradicted each other.',
    evidence: [],
    affected_spans: ['span-1'],
    suggested_fix: null,
  };
  const invalidResponses: unknown[] = [
    { ...baseResponse([]), trace_id: 'some-other-trace' },
    { ...baseResponse([]), detector: 'persona_drift' },
    baseResponse([validDetection, validDetection]),
    baseResponse([{ ...validDetection, category: 'persona_drift' }], 'coordination'),
    { ...baseResponse([]), all_detections: undefined },
    baseResponse([{ ...validDetection, detected: false }]),
    baseResponse([{ ...validDetection, confidence: Number.NaN }]),
    baseResponse([{ ...validDetection, severity: 'catastrophic' }]),
    baseResponse([{ ...validDetection, evidence: ['not-an-object'] }]),
    baseResponse([{ ...validDetection, affected_spans: [7] }]),
    baseResponse([{ ...validDetection, suggested_fix: { text: 'fix it' } }]),
  ];

  for (const body of invalidResponses) {
    const { fetch } = makeFetchMock(() => ({ status: 200, body }));
    const det = createMultiAgentDetectors({
      endpoint: 'http://mock.local',
      apiKey: 'pisama_response_contract_key',
      fetchImpl: fetch,
    });
    await assert.rejects(
      () => det.coordination({ agent_ids: ['a'], messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof PisamaBackendError);
        assert.match(error.message, /invalid Pisama multi-agent response/);
        return true;
      },
    );
  }
});

test('coordination: generates collision-resistant trace ids when correlation_id is absent', async () => {
  const { fetch, calls } = makeFetchMock(() => ({
    status: 200,
    body: baseResponse([]),
  }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_trace_id_test_key',
    fetchImpl: fetch,
  });

  await det.coordination({ agent_ids: ['a'], messages: [] });
  await det.coordination({ agent_ids: ['a'], messages: [] });

  const traceIds = calls.map((call) => {
    const content = (call.body as { content: string }).content;
    return (JSON.parse(content) as { trace_id: string }).trace_id;
  });
  assert.match(traceIds[0]!, /^ts-coord-/);
  assert.match(traceIds[1]!, /^ts-coord-/);
  assert.notEqual(traceIds[0], traceIds[1]);
});

test('coordination: validates runtime identifiers and messages before network', async () => {
  let requestCount = 0;
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    fetchImpl: (async () => {
      requestCount += 1;
      return new Response('{}');
    }) as unknown as typeof fetch,
  });
  const invalid: Array<[unknown, RegExp]> = [
    [{ agent_ids: [], messages: [] }, /agent_ids must be a non-empty array/],
    [{ agent_ids: ['   '], messages: [] }, /agent_ids\[0\] must be a non-empty string/],
    [{ agent_ids: ['a', ' a '], messages: [] }, /agent_ids must be unique/],
    [{ agent_ids: ['a'], messages: [], correlation_id: '  ' }, /correlation_id/],
    [{ agent_ids: ['a'], messages: [null] }, /messages\[0\] must be an object/],
    [{ agent_ids: ['a'], messages: [{ sender: ' ', content: 'hello' }] }, /messages\[0\][.]sender/],
    [
      { agent_ids: ['a'], messages: [{ sender: 'other', content: 'hello' }] },
      /sender must appear in agent_ids/,
    ],
    [{ agent_ids: ['a'], messages: [{ sender: 'a', content: '  ' }] }, /messages\[0\][.]content/],
    [
      { agent_ids: ['a'], messages: [{ sender: 'a', content: 'hello', recipient: ' ' }] },
      /messages\[0\][.]recipient/,
    ],
    [
      { agent_ids: ['a'], messages: [{ sender: 'a', content: 'hello', timestamp: Infinity }] },
      /messages\[0\][.]timestamp must be a finite number/,
    ],
  ];
  for (const [input, expected] of invalid) {
    await assert.rejects(() => det.coordination(input as CoordinationInput), expected);
  }
  assert.equal(requestCount, 0);
});

test('coordination: trims identifiers without rewriting message content', async () => {
  const { fetch, calls } = makeFetchMock(() => ({ status: 200, body: baseResponse([]) }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_normalization_test_key',
    fetchImpl: fetch,
  });

  await det.coordination({
    agent_ids: [' planner '],
    messages: [{ sender: ' planner ', recipient: ' executor ', content: '  retain this  ' }],
    correlation_id: ' corr-trimmed ',
  });

  const request = calls[0]!.body as { content: string };
  const trace = JSON.parse(request.content) as {
    trace_id: string;
    spans: Array<{ agent_id: string; response: string; metadata: Record<string, string> }>;
  };
  assert.equal(trace.trace_id, 'corr-trimmed');
  assert.equal(trace.spans[0]!.agent_id, 'planner');
  assert.equal(trace.spans[0]!.response, '  retain this  ');
  assert.equal(trace.spans[0]!.metadata['pisama.message.recipient'], 'executor');
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
    apiKey: 'pisama_persona_test_key',
    fetchImpl: fetch,
  });
  const input: PersonaInput = {
    agent: {
      id: 'support-bot',
      persona_description: 'polite customer-support agent',
      allowed_actions: ['respond_to_user', 'lookup_order'],
    },
    task: 'Help this customer understand the refund process.',
    output: "ugh fine, here's your refund or whatever.",
  };
  const result = await det.persona(input);

  assert.equal(calls[0]!.url, 'http://mock.local/api/v1/diagnose/multi-agent/persona_drift');
  const body = calls[0]!.body as { content: string };
  const innerTrace = JSON.parse(body.content) as Record<string, unknown>;
  const spans = innerTrace['spans'] as Array<Record<string, unknown>>;
  assert.equal(spans[0]!['agent_id'], 'support-bot');
  assert.equal(spans[0]!['prompt'], input.task);
  assert.equal(spans[0]!['response'], input.output);
  assert.deepEqual(spans[0]!['metadata'], {
    'gen_ai.persona': 'polite customer-support agent',
    'pisama.allowed_actions': ['respond_to_user', 'lookup_order'],
  });
  assert.equal(result.category, 'persona_drift');
  assert.equal(result.detected, true);
  assert.equal(result.severity, 'high');
});

test('persona: rejects a missing task before any network request', async () => {
  let requestCount = 0;
  const det = createMultiAgentDetectors({
    fetchImpl: (async () => {
      requestCount++;
      return Response.json({});
    }) as typeof fetch,
  });

  await assert.rejects(
    () =>
      det.persona({
        agent: { id: 'support-bot', persona_description: 'support', allowed_actions: [] },
        task: '',
        output: 'A sufficiently long output that must not leave this process.',
      }),
    /task must be a non-empty string/,
  );
  assert.equal(requestCount, 0);
});

test('persona: rejects blank identifiers and malformed persona metadata before network', async () => {
  let requestCount = 0;
  const det = createMultiAgentDetectors({
    fetchImpl: (async () => {
      requestCount += 1;
      return Response.json({});
    }) as typeof fetch,
  });
  const base: PersonaInput = {
    agent: { id: 'support-bot', persona_description: 'support', allowed_actions: [] },
    task: 'Help the customer.',
    output: 'Here is the answer.',
  };
  const invalid: Array<[unknown, RegExp]> = [
    [{ ...base, agent: { ...base.agent, id: ' ' } }, /agent[.]id/],
    [{ ...base, agent: { ...base.agent, persona_description: ' ' } }, /persona_description/],
    [{ ...base, agent: { ...base.agent, allowed_actions: [7] } }, /allowed_actions\[0\]/],
    [{ ...base, correlation_id: '' }, /correlation_id/],
  ];
  for (const [input, expected] of invalid) {
    await assert.rejects(() => det.persona(input as PersonaInput), expected);
  }
  assert.equal(requestCount, 0);
});

test('public API omits detector operations that the backend cannot surface', () => {
  let requestCount = 0;
  const det = createMultiAgentDetectors({
    endpoint: 'http://unused.local',
    fetchImpl: (async () => {
      requestCount += 1;
      return new Response('{}');
    }) as unknown as typeof fetch,
  });

  assert.equal(publicOperationsAreSupported, true);
  assert.equal(removedPublicInputs, undefined);
  assert.deepEqual(Object.keys(det).sort(), ['coordination', 'persona']);
  assert.equal('delegation' in det, false);
  assert.equal('consensus_collapse' in det, false);
  assert.equal(requestCount, 0);
});

// ---- auth & errors ----

test('auth exchanges the raw key for a full JWT and preserves the project label', async () => {
  const { fetch, calls, authCalls } = makeFetchMock(() => ({
    status: 200,
    body: baseResponse([]),
  }));
  const rawKey = 'pisama_raw_test_key';
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: rawKey,
    projectId: 'proj-abc',
    fetchImpl: fetch,
  });
  await det.coordination({
    agent_ids: ['a'],
    messages: [{ sender: 'a', content: 'hi' }],
  });
  assert.equal(authCalls.length, 1);
  assert.deepEqual(authCalls[0]!.body, { api_key: rawKey, scope: 'full' });
  assert.equal(authCalls[0]!.headers['authorization'], undefined);
  assert.equal(calls[0]!.headers['authorization'], `Bearer ${scopedToken('full', 1)}`);
  assert.notEqual(calls[0]!.headers['authorization'], `Bearer ${rawKey}`);
  assert.equal(calls[0]!.headers['x-pisama-project-id'], 'proj-abc');
  assert.match(calls[0]!.headers['x-request-id']!, /^pisama-detect-/);
  assert.equal(authCalls[0]!.redirect, 'error');
  assert.equal(calls[0]!.redirect, 'error');
});

test('auth retries exactly once on 401 with a fresh JWT and identical request', async () => {
  let attempt = 0;
  const { fetch, calls, authCalls } = makeFetchMock(() => ({
    status: attempt++ === 0 ? 401 : 200,
    body: attempt === 1 ? { detail: 'expired' } : baseResponse([]),
  }));
  const rawKey = 'pisama_retry_test_key';
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: rawKey,
    fetchImpl: fetch,
  });

  await det.coordination({ agent_ids: ['a'], messages: [] });

  assert.equal(authCalls.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers['authorization'], `Bearer ${scopedToken('full', 1)}`);
  assert.equal(calls[1]!.headers['authorization'], `Bearer ${scopedToken('full', 2)}`);
  assert.equal(calls[0]!.rawBody, calls[1]!.rawBody);
  assert.equal(calls[0]!.headers['x-request-id'], calls[1]!.headers['x-request-id']);
  assert.ok(calls.every((call) => call.headers['authorization'] !== `Bearer ${rawKey}`));
});

test('auth stops after one refresh when the diagnose route keeps returning 401', async () => {
  const { fetch, calls, authCalls } = makeFetchMock(() => ({
    status: 401,
    body: { detail: 'still expired' },
  }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_persistent_401_key',
    fetchImpl: fetch,
  });

  await assert.rejects(
    () => det.coordination({ agent_ids: ['a'], messages: [] }),
    (error: unknown) => error instanceof PisamaBackendError && error.status === 401,
  );
  assert.equal(authCalls.length, 2);
  assert.equal(calls.length, 2);
});

test('auth token is cached across detector operations', async () => {
  const { fetch, authCalls } = makeFetchMock((request) => ({
    status: 200,
    body: baseResponse(
      [],
      request.url.endsWith('/persona_drift') ? 'persona_drift' : 'coordination',
    ),
  }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_cache_test_key',
    fetchImpl: fetch,
  });

  await det.coordination({ agent_ids: ['a'], messages: [] });
  await det.persona({
    agent: { id: 'a', persona_description: 'tester', allowed_actions: [] },
    task: 'Perform the requested test.',
    output: 'hello',
  });

  assert.equal(authCalls.length, 1);
});

test('auth rejects missing, unknown, and insufficient token scopes before diagnosis', async () => {
  for (const scope of ['', 'admin', 'read']) {
    let calls = 0;
    const det = createMultiAgentDetectors({
      endpoint: 'http://mock.local',
      apiKey: 'pisama_scope_test_key',
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/v1/auth/token')) {
          return Response.json({ access_token: scopedToken(scope, 1) });
        }
        calls++;
        return Response.json(baseResponse([]));
      }) as typeof fetch,
    });

    await assert.rejects(
      () => det.coordination({ agent_ids: ['a'], messages: [] }),
      /scope|scoped/i,
    );
    assert.equal(calls, 0);
  }
});

test('concurrent 401s share one refresh and cannot evict the fresh token', async () => {
  let tokenCalls = 0;
  let initialCalls = 0;
  let releaseInitial!: () => void;
  const bothInitialStarted = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const protectedTokens: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input).endsWith('/api/v1/auth/token')) {
      tokenCalls++;
      return Response.json({ access_token: scopedToken('full', tokenCalls) });
    }
    const authorization = new Headers(init.headers).get('authorization') ?? '';
    protectedTokens.push(authorization);
    if (authorization === `Bearer ${scopedToken('full', 1)}`) {
      initialCalls++;
      if (initialCalls === 2) releaseInitial();
      await bothInitialStarted;
      return Response.json({ detail: 'expired' }, { status: 401 });
    }
    const request = JSON.parse(String(init.body)) as { content: string };
    const submitted = JSON.parse(request.content) as { trace_id: string };
    return Response.json({
      ...baseResponse(
        [],
        String(input).endsWith('/persona_drift') ? 'persona_drift' : 'coordination',
      ),
      trace_id: submitted.trace_id,
    });
  }) as typeof fetch;
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_concurrent_test_key',
    fetchImpl,
  });

  await Promise.all([
    det.coordination({ agent_ids: ['a'], messages: [] }),
    det.persona({
      agent: { id: 'a', persona_description: 'tester', allowed_actions: [] },
      task: 'Perform the requested test.',
      output: 'hello',
    }),
  ]);

  assert.equal(tokenCalls, 2);
  assert.deepEqual(protectedTokens, [
    `Bearer ${scopedToken('full', 1)}`,
    `Bearer ${scopedToken('full', 1)}`,
    `Bearer ${scopedToken('full', 2)}`,
    `Bearer ${scopedToken('full', 2)}`,
  ]);
});

test('rejected API-key exchange surfaces its status without a diagnose request', async () => {
  let requestCount = 0;
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_rejected_test_key',
    fetchImpl: (async () => {
      requestCount += 1;
      return Response.json({ detail: 'invalid key' }, { status: 401 });
    }) as unknown as typeof fetch,
  });

  await assert.rejects(
    () => det.coordination({ agent_ids: ['a'], messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof PisamaBackendError);
      assert.equal(error.status, 401);
      assert.deepEqual(error.body, { detail: 'invalid key' });
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test('missing API key fails closed before any network request', async () => {
  let requestCount = 0;
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: '',
    fetchImpl: (async () => {
      requestCount += 1;
      return Response.json({});
    }) as unknown as typeof fetch,
  });

  await assert.rejects(
    () => det.coordination({ agent_ids: ['a'], messages: [] }),
    /PISAMA_API_KEY or apiKey is required; no network request was made/,
  );
  assert.equal(requestCount, 0);
});

test('error: 4xx surfaces as PisamaBackendError with status', async () => {
  const { fetch } = makeFetchMock(() => ({
    status: 400,
    body: { detail: 'bad trace shape' },
  }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_4xx_test_key',
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
    apiKey: 'pisama_5xx_test_key',
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
    apiKey: 'pisama_network_test_key',
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

test('timeout covers API-key exchange even when the injected fetch ignores abort', async () => {
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_timeout_test_key',
    timeoutMs: 20,
    fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
  });

  const started = Date.now();
  await assert.rejects(
    () => det.coordination({ agent_ids: ['a'], messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof PisamaBackendError);
      assert.match(error.message, /timed out after 20ms/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1_000);
});

test('timeout covers a token response body that never finishes', async () => {
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_timeout_test_key',
    timeoutMs: 20,
    fetchImpl: (async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });

  const started = Date.now();
  await assert.rejects(
    () => det.coordination({ agent_ids: ['a'], messages: [] }),
    /timed out after 20ms/,
  );
  assert.ok(Date.now() - started < 1_000);
});

test('timeout covers a protected response body that never finishes', async () => {
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_timeout_test_key',
    timeoutMs: 20,
    fetchImpl: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/v1/auth/token')) {
        return Response.json({ access_token: scopedToken('full', 1) });
      }
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const started = Date.now();
  await assert.rejects(
    () => det.coordination({ agent_ids: ['a'], messages: [] }),
    /timed out after 20ms/,
  );
  assert.ok(Date.now() - started < 1_000);
});

test('client validates its total request timeout', () => {
  assert.throws(
    () =>
      createMultiAgentDetectors({
        apiKey: 'pisama_timeout_test_key',
        timeoutMs: Number.NaN,
      }),
    /timeoutMs must be a positive finite number/,
  );
});
