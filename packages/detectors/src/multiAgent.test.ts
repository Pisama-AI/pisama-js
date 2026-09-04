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

function scopedToken(scope: string, sequence: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ scope })).toString('base64url');
  return `${header}.${payload}.test-${sequence}`;
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
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls, authCalls };
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
  const { fetch, authCalls } = makeFetchMock(() => ({
    status: 200,
    body: baseResponse([]),
  }));
  const det = createMultiAgentDetectors({
    endpoint: 'http://mock.local',
    apiKey: 'pisama_cache_test_key',
    fetchImpl: fetch,
  });

  await det.coordination({ agent_ids: ['a'], messages: [] });
  await det.persona({
    agent: { id: 'a', persona_description: 'tester', allowed_actions: [] },
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
    return Response.json(baseResponse([]));
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
