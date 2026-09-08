import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, '..', 'dist', 'bin.js');
const packageVersion = (
  JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')) as { version: string }
).version;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RpcExchange {
  initialization: JsonRpcResponse;
  response: JsonRpcResponse;
}

async function rpcExchange(
  request: { id: number; method: string; params?: unknown },
  timeoutMs = 4000,
  options: { apiKey?: string; baseUrl?: string } = {},
): Promise<RpcExchange> {
  const args = [binPath, 'mcp'];
  if (options.baseUrl) args.push('--base-url', options.baseUrl);
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PISAMA_API_KEY: options.apiKey ?? 'pisama_mcp_test_key' },
  });

  const initMessage = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  };
  const initialized = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  };
  const call = { jsonrpc: '2.0', ...request };

  child.stdin.write(JSON.stringify(initMessage) + '\n');
  child.stdin.write(JSON.stringify(initialized) + '\n');
  child.stdin.write(JSON.stringify(call) + '\n');

  return await new Promise<RpcExchange>((resolveP, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp rpc timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    let buffer = '';
    let stderr = '';
    let initialization: JsonRpcResponse | undefined;
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: JsonRpcResponse;
        try {
          parsed = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        if (parsed.id === initMessage.id) {
          initialization = parsed;
          continue;
        }
        if (parsed.id === request.id) {
          if (!initialization) {
            clearTimeout(timer);
            child.kill();
            reject(new Error('mcp call completed before initialization response'));
            return;
          }
          clearTimeout(timer);
          child.kill();
          resolveP({ initialization, response: parsed });
          return;
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`spawn failed: ${e.message}\nstderr: ${stderr}`));
    });
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`child exited ${code}\nstderr: ${stderr}`));
      }
    });
  });
}

async function rpcCall(
  request: { id: number; method: string; params?: unknown },
  timeoutMs = 4000,
  options: { apiKey?: string; baseUrl?: string } = {},
): Promise<JsonRpcResponse> {
  return (await rpcExchange(request, timeoutMs, options)).response;
}

function jwt(scope: string, suffix: number): string {
  const claims = Buffer.from(JSON.stringify({ tenant_id: 'tenant-mcp-1', scope }), 'utf8').toString(
    'base64url',
  );
  return `test.${claims}.token-${suffix}`;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function platformTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'trace-default',
    session_id: 'session-default',
    framework: 'langgraph',
    status: 'completed',
    detection_status: 'complete',
    total_tokens: 0,
    total_cost_cents: 0,
    created_at: '2026-09-04T12:00:00Z',
    completed_at: null,
    state_count: 0,
    detection_count: 0,
    ...overrides,
  };
}

function platformDetection(
  traceId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `detection-${traceId}`,
    trace_id: traceId,
    state_id: null,
    detection_type: 'loop',
    confidence: 80,
    confidence_tier: 'HIGH',
    method: 'heuristic',
    details: {},
    validated: false,
    false_positive: null,
    created_at: '2026-09-04T12:00:00Z',
    ...overrides,
  };
}

function platformState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'state-default',
    sequence_num: 0,
    agent_id: 'agent',
    state_delta: {},
    state_hash: 'state-hash',
    response_redacted: null,
    token_count: 0,
    latency_ms: 0,
    created_at: '2026-09-04T12:00:00Z',
    span_kind: null,
    span_status: null,
    ...overrides,
  };
}

async function withHttpServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      respond(response, 500, { error: String(error) });
    });
  });
  await new Promise<void>((resolveP) => server.listen(0, '127.0.0.1', resolveP));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolveP, reject) =>
      server.close((error) => (error ? reject(error) : resolveP())),
    );
  }
}

interface ToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string };
  outputSchema?: { type?: string };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

test('mcp: tools/list returns 3 pisama tools', async () => {
  const res = await rpcCall({ id: 1, method: 'tools/list' });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const tools = (res.result as { tools: ToolDef[] }).tools;
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_recent_failures', 'get_recent_traces', 'get_trace']);
});

test('mcp: initialize advertises the package version', async () => {
  const exchange = await rpcExchange({ id: 3, method: 'tools/list' });
  const result = exchange.initialization.result as {
    serverInfo?: { name?: string; version?: string };
  };

  assert.equal(result.serverInfo?.name, 'pisama');
  assert.equal(result.serverInfo?.version, packageVersion);
});

test('mcp: every tool declares MCP 2025-06-18 ergonomic fields', async () => {
  const res = await rpcCall({ id: 2, method: 'tools/list' });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const tools = (res.result as { tools: ToolDef[] }).tools;

  for (const tool of tools) {
    // title (top-level, distinct from annotations.title)
    assert.ok(
      tool.title && /^[A-Z]/.test(tool.title),
      `tool ${tool.name} missing Title Case title`,
    );

    // outputSchema (object-typed per spec)
    assert.ok(tool.outputSchema, `tool ${tool.name} missing outputSchema`);
    assert.equal(
      tool.outputSchema.type,
      'object',
      `tool ${tool.name} outputSchema.type must be 'object'`,
    );

    // annotations with all four behavioral hints set explicitly
    assert.ok(tool.annotations, `tool ${tool.name} missing annotations`);
    assert.equal(
      typeof tool.annotations.readOnlyHint,
      'boolean',
      `tool ${tool.name} missing readOnlyHint`,
    );
    assert.equal(
      typeof tool.annotations.destructiveHint,
      'boolean',
      `tool ${tool.name} missing destructiveHint`,
    );
    assert.equal(
      typeof tool.annotations.idempotentHint,
      'boolean',
      `tool ${tool.name} missing idempotentHint`,
    );
    assert.equal(
      typeof tool.annotations.openWorldHint,
      'boolean',
      `tool ${tool.name} missing openWorldHint`,
    );

    // All Pisama tools are pure reads against the API.
    assert.equal(
      tool.annotations.readOnlyHint,
      true,
      `tool ${tool.name} should be readOnlyHint=true`,
    );
    assert.equal(
      tool.annotations.destructiveHint,
      false,
      `tool ${tool.name} should be destructiveHint=false`,
    );
  }
});

test('mcp: missing traceId returns isError with structured error payload', async () => {
  // Call get_trace with no traceId argument; should fail validation BEFORE
  // any network call, so no need to stub fetch.
  const res = await rpcCall({
    id: 3,
    method: 'tools/call',
    params: { name: 'get_trace', arguments: {} },
  });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const result = res.result as {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: { error?: { code?: string; message?: string } };
  };
  assert.equal(result.isError, true, 'expected isError=true');
  assert.ok(result.content.length > 0, 'expected text content');
  assert.ok(result.structuredContent, 'expected structuredContent payload');
  assert.equal(result.structuredContent.error?.code, 'validation_error');
  assert.ok(
    result.structuredContent.error?.message?.includes('traceId'),
    `expected error.message to mention traceId, got ${result.structuredContent.error?.message}`,
  );
});

test('mcp: executable exchanges the raw key and reads current tenant routes with one 401 retry', async () => {
  const rawKey = 'pisama_mcp_raw_secret';
  const traceId = '11111111-1111-4111-8111-111111111111';
  let tokenCalls = 0;
  let traceCalls = 0;
  const protectedHeaders: Array<string | undefined> = [];

  await withHttpServer(
    async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://test');
      if (url.pathname === '/api/v1/auth/token') {
        tokenCalls += 1;
        assert.equal(request.headers.authorization, undefined);
        assert.deepEqual(JSON.parse(await requestBody(request)), {
          api_key: rawKey,
          scope: 'read',
        });
        respond(response, 200, { access_token: jwt('read', tokenCalls) });
        return;
      }

      protectedHeaders.push(request.headers.authorization);
      assert.notEqual(request.headers.authorization, `Bearer ${rawKey}`);
      if (url.pathname === '/api/v1/tenants/tenant-mcp-1/traces') {
        traceCalls += 1;
        assert.equal(url.searchParams.get('page'), '1');
        assert.equal(url.searchParams.get('per_page'), '100');
        if (traceCalls === 1) {
          respond(response, 401, { detail: 'expired' });
          return;
        }
        respond(response, 200, {
          traces: [
            platformTrace({
              id: traceId,
              session_id: 'session-1',
              framework: 'vercel-ai-sdk',
              status: 'completed',
              detection_status: 'complete',
              total_tokens: 42,
              total_cost_cents: 3,
              created_at: '2026-09-04T12:00:00Z',
              completed_at: '2026-09-04T12:00:01Z',
              detection_count: 1,
              state_count: 1,
            }),
          ],
          total: 1,
          page: 1,
          per_page: 100,
        });
        return;
      }
      if (url.pathname === '/api/v1/tenants/tenant-mcp-1/detections') {
        assert.equal(url.searchParams.get('trace_id'), traceId);
        assert.equal(url.searchParams.get('page'), '1');
        respond(response, 200, {
          items: [
            platformDetection(traceId, {
              detection_type: 'loop',
              confidence: 80,
              details: { repeated: 4 },
              explanation: 'Repeated the same tool.',
              suggested_fix: 'Bound retries.',
            }),
          ],
          total: 1,
          page: 1,
          per_page: 100,
        });
        return;
      }
      respond(response, 404, { detail: 'not found' });
    },
    async (baseUrl) => {
      const response = await rpcCall(
        {
          id: 20,
          method: 'tools/call',
          params: { name: 'get_recent_failures', arguments: { limit: 5 } },
        },
        5000,
        { apiKey: rawKey, baseUrl },
      );
      assert.equal(response.error, undefined, JSON.stringify(response));
      const result = response.result as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: {
          tenantId?: string;
          events?: Array<{
            event?: { traceId?: string };
            hits?: Array<{
              detector?: string;
              confidence?: number;
              confidenceTier?: string;
              severity?: number;
            }>;
          }>;
        };
      };
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent?.tenantId, 'tenant-mcp-1');
      assert.equal(result.structuredContent?.events?.[0]?.event?.traceId, traceId);
      assert.equal(result.structuredContent?.events?.[0]?.hits?.[0]?.detector, 'loop');
      assert.equal(result.structuredContent?.events?.[0]?.hits?.[0]?.confidence, 80);
      assert.equal(result.structuredContent?.events?.[0]?.hits?.[0]?.confidenceTier, 'HIGH');
      assert.equal(result.structuredContent?.events?.[0]?.hits?.[0]?.severity, undefined);
      assert.match(result.content[0].text, /loop\/80% HIGH/);
      assert.doesNotMatch(result.content[0].text, /severity/);
    },
  );

  assert.equal(tokenCalls, 2, 'initial exchange plus exactly one 401 re-exchange');
  assert.equal(traceCalls, 2, 'protected request retries exactly once');
  assert.ok(protectedHeaders.every((header) => header?.startsWith('Bearer test.')));
});

test('mcp: get_trace uses exact authenticated trace, states, and detections routes', async () => {
  const traceId = '22222222-2222-4222-8222-222222222222';
  const seenPaths: string[] = [];
  await withHttpServer(
    async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://test');
      if (url.pathname === '/api/v1/auth/token') {
        const body = JSON.parse(await requestBody(request)) as { scope?: string };
        respond(response, 200, { access_token: jwt(body.scope ?? 'read', 1) });
        return;
      }
      seenPaths.push(`${url.pathname}${url.search}`);
      assert.match(request.headers.authorization ?? '', /^Bearer test\./);
      if (url.pathname.endsWith(`/traces/${traceId}`)) {
        respond(
          response,
          200,
          platformTrace({
            id: traceId,
            session_id: 'session-detail',
            framework: 'langgraph',
            status: 'completed',
            detection_status: 'partial',
            total_tokens: 10,
            total_cost_cents: 1,
            created_at: '2026-09-04T12:00:00Z',
            completed_at: '2026-09-04T12:00:01Z',
            detection_count: 1,
            state_count: 1,
          }),
        );
        return;
      }
      if (url.pathname.endsWith(`/traces/${traceId}/states`)) {
        assert.equal(url.searchParams.get('full_state'), 'true');
        assert.equal(url.searchParams.get('limit'), '2000');
        respond(response, 200, [
          platformState({
            id: '33333333-3333-4333-8333-333333333333',
            sequence_num: 0,
            agent_id: 'agent',
            state_delta: { _prompt: 'Diagnose this run.' },
            response_redacted: 'The run looped.',
            token_count: 10,
            latency_ms: 1000,
            created_at: '2026-09-04T12:00:00Z',
            span_kind: 'internal',
            span_status: 'ok',
          }),
        ]);
        return;
      }
      if (url.pathname.endsWith('/detections')) {
        assert.equal(url.searchParams.get('trace_id'), traceId);
        respond(response, 200, { items: [], total: 0, page: 1, per_page: 100 });
        return;
      }
      respond(response, 404, { detail: 'not found' });
    },
    async (baseUrl) => {
      const response = await rpcCall(
        {
          id: 21,
          method: 'tools/call',
          params: { name: 'get_trace', arguments: { traceId } },
        },
        5000,
        { apiKey: 'pisama_key', baseUrl },
      );
      const result = response.result as {
        isError?: boolean;
        content?: { text?: string }[];
        structuredContent?: {
          event?: {
            framework?: string;
            model?: string;
            totalTokens?: number;
            outputTokens?: number;
            traceStatus?: string;
            finishReason?: string;
            detectionStatus?: string;
            prompt?: string;
            completion?: string;
            toolCalls?: unknown[];
            stateMetadata?: Array<{
              stateId?: string;
              sequenceNumber?: number;
              agentId?: string;
              tokenCount?: number;
              latencyMs?: number;
              spanKind?: string;
              spanStatus?: string;
            }>;
            metadata?: unknown;
          };
          visibleDetectionCount?: number;
        };
      };
      assert.equal(result.isError, false, JSON.stringify(response));
      assert.ok(result.structuredContent);
      assert.ok(result.structuredContent.event);
      const event = result.structuredContent.event;
      assert.equal(event.framework, 'langgraph');
      assert.equal(event.model, undefined);
      assert.equal(event.totalTokens, 10);
      assert.equal(event.outputTokens, undefined);
      assert.equal(event.traceStatus, 'completed');
      assert.equal(event.finishReason, undefined);
      assert.equal(event.detectionStatus, 'partial');
      assert.equal(event.prompt, 'Diagnose this run.');
      assert.equal(event.completion, 'The run looped.');
      assert.deepEqual(event.toolCalls, []);
      assert.deepEqual(event.stateMetadata, [
        {
          stateId: '33333333-3333-4333-8333-333333333333',
          sequenceNumber: 0,
          agentId: 'agent',
          tokenCount: 10,
          latencyMs: 1000,
          createdAt: '2026-09-04T12:00:00Z',
          spanKind: 'internal',
          spanStatus: 'ok',
        },
      ]);
      assert.equal(result.structuredContent.visibleDetectionCount, 0);
      const text = result.content?.[0]?.text ?? '';
      assert.match(text, /framework: langgraph/);
      assert.match(text, /tokens: total=10/);
      assert.match(text, /traceStatus: completed/);
      assert.match(text, /detectionStatus: partial/);
      assert.doesNotMatch(text, /^model:/m);
      assert.doesNotMatch(text, /^finishReason:/m);
    },
  );
  assert.equal(seenPaths.length, 3);
});

test('mcp: recent failures scan later trace pages and omit hidden-only detections', async () => {
  const hiddenTraceId = 'hidden-trace';
  const visibleTraceId = 'visible-trace';
  const tracePages: number[] = [];

  await withHttpServer(
    async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://test');
      if (url.pathname === '/api/v1/auth/token') {
        respond(response, 200, { access_token: jwt('read', 1) });
        return;
      }
      if (url.pathname === '/api/v1/tenants/tenant-mcp-1/traces') {
        const page = Number(url.searchParams.get('page'));
        tracePages.push(page);
        assert.equal(url.searchParams.get('per_page'), '100');
        if (page === 1) {
          respond(response, 200, {
            traces: Array.from({ length: 100 }, (_, index) =>
              platformTrace({
                id: index === 0 ? hiddenTraceId : `clean-${index}`,
                framework: 'langgraph',
                status: 'completed',
                detection_status: 'complete',
                total_tokens: index,
                created_at: '2026-09-04T12:00:00Z',
                detection_count: index === 0 ? 1 : 0,
              }),
            ),
            total: 101,
            page: 1,
            per_page: 100,
          });
          return;
        }
        respond(response, 200, {
          traces: [
            platformTrace({
              id: visibleTraceId,
              framework: 'crewai',
              status: 'failed',
              detection_status: 'complete',
              total_tokens: 21,
              created_at: '2026-09-04T11:00:00Z',
              detection_count: 1,
            }),
          ],
          total: 101,
          page: 2,
          per_page: 100,
        });
        return;
      }
      if (url.pathname === '/api/v1/tenants/tenant-mcp-1/detections') {
        const traceId = url.searchParams.get('trace_id');
        assert.equal(url.searchParams.get('page'), '1');
        if (traceId === hiddenTraceId) {
          respond(response, 200, { items: [], total: 0, page: 1, per_page: 100 });
        } else {
          assert.equal(traceId, visibleTraceId);
          respond(response, 200, {
            items: [
              platformDetection(visibleTraceId, {
                detection_type: 'loop',
                confidence: 90,
                explanation: 'Visible loop.',
              }),
            ],
            total: 1,
            page: 1,
            per_page: 100,
          });
        }
        return;
      }
      respond(response, 404, { detail: 'not found' });
    },
    async (baseUrl) => {
      const response = await rpcCall(
        {
          id: 22,
          method: 'tools/call',
          params: { name: 'get_recent_failures', arguments: { limit: 1 } },
        },
        5000,
        { apiKey: 'pisama_key', baseUrl },
      );
      const result = response.result as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: {
          count?: number;
          scannedTraceCount?: number;
          totalTraceCount?: number;
          scanComplete?: boolean;
          resultsTruncated?: boolean;
          events?: Array<{ event?: { traceId?: string }; hits?: unknown[] }>;
        };
      };
      assert.equal(result.isError, false, JSON.stringify(response));
      assert.equal(result.structuredContent?.count, 1);
      assert.equal(result.structuredContent?.scannedTraceCount, 101);
      assert.equal(result.structuredContent?.totalTraceCount, 101);
      assert.equal(result.structuredContent?.scanComplete, true);
      assert.equal(result.structuredContent?.resultsTruncated, false);
      assert.equal(result.structuredContent?.events?.[0]?.event?.traceId, visibleTraceId);
      assert.equal(result.structuredContent?.events?.[0]?.hits?.length, 1);
      assert.doesNotMatch(result.content[0].text, /\(clean\)/);
    },
  );

  assert.deepEqual(tracePages, [1, 2]);
});

test('mcp: a trace page without the contracted total fails closed', async () => {
  const tracePages: number[] = [];
  await withHttpServer(
    async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://test');
      if (url.pathname === '/api/v1/auth/token') {
        respond(response, 200, { access_token: jwt('read', 1) });
        return;
      }
      if (url.pathname === '/api/v1/tenants/tenant-mcp-1/traces') {
        const page = Number(url.searchParams.get('page'));
        tracePages.push(page);
        if (page === 1) {
          respond(response, 200, {
            traces: Array.from({ length: 100 }, (_, index) =>
              platformTrace({
                id: `unknown-total-clean-${index}`,
                status: 'completed',
                detection_status: 'complete',
                created_at: '2026-09-04T12:00:00Z',
                detection_count: 0,
              }),
            ),
            page: 1,
            per_page: 100,
          });
          return;
        }
      }
      respond(response, 404, { detail: 'not found' });
    },
    async (baseUrl) => {
      const response = await rpcCall(
        {
          id: 25,
          method: 'tools/call',
          params: { name: 'get_recent_failures', arguments: { limit: 1 } },
        },
        6000,
        { apiKey: 'pisama_key', baseUrl },
      );
      const result = response.result as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: { error?: { code?: string } };
      };
      assert.equal(result.isError, true, JSON.stringify(response));
      assert.equal(result.structuredContent?.error?.code, 'upstream_error');
      assert.match(result.content?.[0]?.text ?? '', /invalid response/i);
    },
  );
  assert.deepEqual(tracePages, [1]);
});

test('mcp: repeated and cross-page inconsistent trace pagination fail closed', async () => {
  for (const mode of [
    'repeated-page',
    'changed-total',
    'duplicate-id-within-page',
    'duplicate-id-across-pages',
  ] as const) {
    await withHttpServer(
      (request, response) => {
        const url = new URL(request.url ?? '/', 'http://test');
        if (url.pathname === '/api/v1/auth/token') {
          respond(response, 200, { access_token: jwt('read', 1) });
          return;
        }
        if (url.pathname === '/api/v1/tenants/tenant-mcp-1/traces') {
          const requestedPage = Number(url.searchParams.get('page'));
          if (requestedPage === 1) {
            respond(response, 200, {
              traces: Array.from({ length: 100 }, (_, index) =>
                platformTrace({
                  id:
                    mode === 'duplicate-id-within-page' && index === 99
                      ? `${mode}-page-1-0`
                      : `${mode}-page-1-${index}`,
                }),
              ),
              total: 101,
              page: 1,
              per_page: 100,
            });
            return;
          }
          respond(response, 200, {
            traces: Array.from({ length: mode === 'changed-total' ? 2 : 1 }, (_, index) =>
              platformTrace({
                id:
                  mode === 'duplicate-id-across-pages'
                    ? `${mode}-page-1-0`
                    : `${mode}-page-2-${index}`,
              }),
            ),
            total: mode === 'changed-total' ? 102 : 101,
            page: mode === 'repeated-page' ? 1 : 2,
            per_page: 100,
          });
          return;
        }
        respond(response, 404, { detail: 'not found' });
      },
      async (baseUrl) => {
        const response = await rpcCall(
          {
            id:
              mode === 'repeated-page'
                ? 28
                : mode === 'changed-total'
                  ? 29
                  : mode === 'duplicate-id-within-page'
                    ? 32
                    : 33,
            method: 'tools/call',
            params: { name: 'get_recent_failures', arguments: { limit: 1 } },
          },
          6000,
          { apiKey: 'pisama_key', baseUrl },
        );
        const result = response.result as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
          structuredContent?: { error?: { code?: string } };
        };
        assert.equal(result.isError, true, `${mode}: ${JSON.stringify(response)}`);
        assert.equal(result.structuredContent?.error?.code, 'upstream_error');
        assert.match(result.content?.[0]?.text ?? '', /invalid response/i);
      },
    );
  }
});

test('mcp: malformed trace and detection pages fail closed', async () => {
  const traceWithDetection = (id: string): Record<string, unknown> => ({
    traces: [
      platformTrace({
        id,
        status: 'failed',
        detection_status: 'complete',
        created_at: '2026-09-04T12:00:00Z',
        detection_count: 1,
      }),
    ],
    total: 1,
    page: 1,
    per_page: 100,
  });
  const cases: Array<{ name: string; tracePage: unknown; detectionPage?: unknown }> = [
    {
      name: 'non-array traces',
      tracePage: { traces: null, total: 1, page: 1, per_page: 100 },
    },
    {
      name: 'invalid trace total',
      tracePage: { traces: [], total: '1', page: 1, per_page: 100 },
    },
    {
      name: 'missing trace page echo',
      tracePage: { traces: [], total: 0, per_page: 100 },
    },
    {
      name: 'mismatched trace page echo',
      tracePage: { traces: [], total: 0, page: 2, per_page: 100 },
    },
    {
      name: 'mismatched trace per-page echo',
      tracePage: { traces: [], total: 0, page: 1, per_page: 99 },
    },
    {
      name: 'trace total smaller than observed items',
      tracePage: {
        traces: [platformTrace({ id: 'extra-trace' })],
        total: 0,
        page: 1,
        per_page: 100,
      },
    },
    {
      name: 'sparse trace row',
      tracePage: { traces: [{ id: 'sparse-trace' }], total: 1, page: 1, per_page: 100 },
    },
    {
      name: 'non-array detections',
      tracePage: traceWithDetection('malformed-detection-page'),
      detectionPage: { items: null, total: 1, page: 1, per_page: 100 },
    },
    {
      name: 'invalid detection total',
      tracePage: traceWithDetection('invalid-detection-total'),
      detectionPage: { items: [], total: -1, page: 1, per_page: 100 },
    },
    {
      name: 'missing detection page echo',
      tracePage: traceWithDetection('missing-detection-page'),
      detectionPage: { items: [], total: 0, per_page: 100 },
    },
    {
      name: 'mismatched detection page echo',
      tracePage: traceWithDetection('mismatched-detection-page'),
      detectionPage: { items: [], total: 0, page: 2, per_page: 100 },
    },
    {
      name: 'mismatched detection per-page echo',
      tracePage: traceWithDetection('mismatched-detection-per-page'),
      detectionPage: { items: [], total: 0, page: 1, per_page: 99 },
    },
    {
      name: 'sparse detection row',
      tracePage: traceWithDetection('sparse-detection-row'),
      detectionPage: {
        items: [{ detection_type: 'loop' }],
        total: 1,
        page: 1,
        per_page: 100,
      },
    },
    {
      name: 'contradictory detection confidence tier',
      tracePage: traceWithDetection('contradictory-confidence-tier'),
      detectionPage: {
        items: [
          platformDetection('contradictory-confidence-tier', {
            confidence: 80,
            confidence_tier: 'LOW',
          }),
        ],
        total: 1,
        page: 1,
        per_page: 100,
      },
    },
  ];

  for (const entry of cases) {
    await withHttpServer(
      async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://test');
        if (url.pathname === '/api/v1/auth/token') {
          respond(response, 200, { access_token: jwt('read', 1) });
          return;
        }
        if (url.pathname === '/api/v1/tenants/tenant-mcp-1/traces') {
          respond(response, 200, entry.tracePage);
          return;
        }
        if (url.pathname === '/api/v1/tenants/tenant-mcp-1/detections') {
          respond(response, 200, entry.detectionPage);
          return;
        }
        respond(response, 404, { detail: 'not found' });
      },
      async (baseUrl) => {
        const response = await rpcCall(
          {
            id: 26,
            method: 'tools/call',
            params: { name: 'get_recent_failures', arguments: { limit: 1 } },
          },
          5000,
          { apiKey: 'pisama_key', baseUrl },
        );
        const result = response.result as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
          structuredContent?: { error?: { code?: string } };
        };
        assert.equal(result.isError, true, `${entry.name}: ${JSON.stringify(response)}`);
        assert.equal(result.structuredContent?.error?.code, 'upstream_error');
        assert.match(result.content?.[0]?.text ?? '', /invalid response/i);
      },
    );
  }
});

test('mcp: get_trace rejects mismatched traces and malformed states', async () => {
  const traceId = '55555555-5555-4555-8555-555555555555';
  const cases: Array<{ name: string; trace: unknown; states: unknown }> = [
    {
      name: 'mismatched trace ID',
      trace: platformTrace({ id: 'another-trace' }),
      states: [],
    },
    {
      name: 'sparse trace response',
      trace: { id: traceId },
      states: [],
    },
    {
      name: 'non-array states response',
      trace: platformTrace({ id: traceId }),
      states: { items: [] },
    },
    {
      name: 'sparse state row',
      trace: platformTrace({ id: traceId, state_count: 1 }),
      states: [{ id: 'sparse-state' }],
    },
  ];

  for (const entry of cases) {
    await withHttpServer(
      async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://test');
        if (url.pathname === '/api/v1/auth/token') {
          respond(response, 200, { access_token: jwt('read', 1) });
          return;
        }
        if (url.pathname.endsWith(`/traces/${traceId}`)) {
          respond(response, 200, entry.trace);
          return;
        }
        if (url.pathname.endsWith(`/traces/${traceId}/states`)) {
          respond(response, 200, entry.states);
          return;
        }
        if (url.pathname.endsWith('/detections')) {
          respond(response, 200, { items: [], total: 0, page: 1, per_page: 100 });
          return;
        }
        respond(response, 404, { detail: 'not found' });
      },
      async (baseUrl) => {
        const response = await rpcCall(
          {
            id: 27,
            method: 'tools/call',
            params: { name: 'get_trace', arguments: { traceId } },
          },
          5000,
          { apiKey: 'pisama_key', baseUrl },
        );
        const result = response.result as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
          structuredContent?: { error?: { code?: string } };
        };
        assert.equal(result.isError, true, `${entry.name}: ${JSON.stringify(response)}`);
        assert.equal(result.structuredContent?.error?.code, 'upstream_error');
        assert.match(result.content?.[0]?.text ?? '', /invalid response/i);
      },
    );
  }
});

test('mcp: a trace with only filtered detections is never rendered as clean', async () => {
  const traceId = 'hidden-only-trace';
  await withHttpServer(
    async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://test');
      if (url.pathname === '/api/v1/auth/token') {
        respond(response, 200, { access_token: jwt('read', 1) });
        return;
      }
      if (url.pathname === '/api/v1/tenants/tenant-mcp-1/traces') {
        respond(response, 200, {
          traces: [
            platformTrace({
              id: traceId,
              framework: 'n8n',
              status: 'completed',
              detection_status: 'complete',
              created_at: '2026-09-04T12:00:00Z',
              detection_count: 2,
            }),
          ],
          total: 1,
          page: 1,
          per_page: 1,
        });
        return;
      }
      if (url.pathname === '/api/v1/tenants/tenant-mcp-1/detections') {
        respond(response, 200, { items: [], total: 0, page: 1, per_page: 100 });
        return;
      }
      respond(response, 404, { detail: 'not found' });
    },
    async (baseUrl) => {
      const response = await rpcCall(
        {
          id: 23,
          method: 'tools/call',
          params: { name: 'get_recent_traces', arguments: { limit: 1 } },
        },
        5000,
        { apiKey: 'pisama_key', baseUrl },
      );
      const result = response.result as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, false, JSON.stringify(response));
      assert.match(result.content[0].text, /\(no visible detector hits\)/);
      assert.doesNotMatch(result.content[0].text, /\(clean\)/);
    },
  );
});

test('mcp: exact trace paginates visible detections and marks the response cap', async () => {
  const traceId = '44444444-4444-4444-8444-444444444444';
  const detectionPages: number[] = [];
  await withHttpServer(
    async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://test');
      if (url.pathname === '/api/v1/auth/token') {
        respond(response, 200, { access_token: jwt('read', 1) });
        return;
      }
      if (url.pathname.endsWith(`/traces/${traceId}`)) {
        respond(
          response,
          200,
          platformTrace({
            id: traceId,
            framework: 'openai-agents',
            status: 'completed',
            detection_status: 'complete',
            created_at: '2026-09-04T12:00:00Z',
            detection_count: 501,
            state_count: 0,
          }),
        );
        return;
      }
      if (url.pathname.endsWith(`/traces/${traceId}/states`)) {
        respond(response, 200, []);
        return;
      }
      if (url.pathname.endsWith('/detections')) {
        const page = Number(url.searchParams.get('page'));
        detectionPages.push(page);
        assert.equal(url.searchParams.get('per_page'), '100');
        respond(response, 200, {
          items: Array.from({ length: 100 }, (_, index) =>
            platformDetection(traceId, {
              id: `detection-${page}-${index}`,
              detection_type: `detector-${page}-${index}`,
              confidence: 80,
              explanation: `Detection ${page}-${index}`,
            }),
          ),
          total: 501,
          page,
          per_page: 100,
        });
        return;
      }
      respond(response, 404, { detail: 'not found' });
    },
    async (baseUrl) => {
      const response = await rpcCall(
        {
          id: 24,
          method: 'tools/call',
          params: { name: 'get_trace', arguments: { traceId } },
        },
        8000,
        { apiKey: 'pisama_key', baseUrl },
      );
      const result = response.result as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: {
          hits?: unknown[];
          visibleDetectionCount?: number;
          hitsTruncated?: boolean;
        };
      };
      assert.equal(result.isError, false, JSON.stringify(response));
      assert.equal(result.structuredContent?.hits?.length, 500);
      assert.equal(result.structuredContent?.visibleDetectionCount, 501);
      assert.equal(result.structuredContent?.hitsTruncated, true);
      assert.match(result.content[0].text, /visibleDetectorHits: 501 \(showing first 500\)/);
    },
  );

  assert.deepEqual(detectionPages, [1, 2, 3, 4, 5]);
});

test('mcp: repeated and cross-page inconsistent detection pagination fail closed', async () => {
  const traceId = '66666666-6666-4666-8666-666666666666';
  for (const mode of [
    'repeated-page',
    'changed-total',
    'duplicate-id-within-page',
    'duplicate-id-across-pages',
  ] as const) {
    await withHttpServer(
      (request, response) => {
        const url = new URL(request.url ?? '/', 'http://test');
        if (url.pathname === '/api/v1/auth/token') {
          respond(response, 200, { access_token: jwt('read', 1) });
          return;
        }
        if (url.pathname.endsWith(`/traces/${traceId}`)) {
          respond(
            response,
            200,
            platformTrace({ id: traceId, detection_count: 102, state_count: 0 }),
          );
          return;
        }
        if (url.pathname.endsWith(`/traces/${traceId}/states`)) {
          respond(response, 200, []);
          return;
        }
        if (url.pathname.endsWith('/detections')) {
          const requestedPage = Number(url.searchParams.get('page'));
          if (requestedPage === 1) {
            respond(response, 200, {
              items: Array.from({ length: 100 }, (_, index) =>
                platformDetection(traceId, {
                  id:
                    mode === 'duplicate-id-within-page' && index === 99
                      ? `${mode}-page-1-0`
                      : `${mode}-page-1-${index}`,
                }),
              ),
              total: 101,
              page: 1,
              per_page: 100,
            });
            return;
          }
          respond(response, 200, {
            items: Array.from({ length: mode === 'changed-total' ? 2 : 1 }, (_, index) =>
              platformDetection(traceId, {
                id:
                  mode === 'duplicate-id-across-pages'
                    ? `${mode}-page-1-0`
                    : `${mode}-page-2-${index}`,
              }),
            ),
            total: mode === 'changed-total' ? 102 : 101,
            page: mode === 'repeated-page' ? 1 : 2,
            per_page: 100,
          });
          return;
        }
        respond(response, 404, { detail: 'not found' });
      },
      async (baseUrl) => {
        const response = await rpcCall(
          {
            id:
              mode === 'repeated-page'
                ? 30
                : mode === 'changed-total'
                  ? 31
                  : mode === 'duplicate-id-within-page'
                    ? 34
                    : 35,
            method: 'tools/call',
            params: { name: 'get_trace', arguments: { traceId } },
          },
          8000,
          { apiKey: 'pisama_key', baseUrl },
        );
        const result = response.result as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
          structuredContent?: { error?: { code?: string } };
        };
        assert.equal(result.isError, true, `${mode}: ${JSON.stringify(response)}`);
        assert.equal(result.structuredContent?.error?.code, 'upstream_error');
        assert.match(result.content?.[0]?.text ?? '', /invalid response/i);
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Prompts (MCP 2025-06-18 prompts primitive)
// ---------------------------------------------------------------------------

interface PromptDef {
  name: string;
  title?: string;
  description?: string;
  arguments?: {
    name: string;
    description?: string;
    required?: boolean;
  }[];
}

interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: string; text: string };
}

interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

test('mcp: prompts/list returns the four documented Pisama prompts', async () => {
  const res = await rpcCall({ id: 10, method: 'prompts/list' });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const prompts = (res.result as { prompts: PromptDef[] }).prompts;
  assert.ok(prompts.length >= 4, `expected >=4 prompts, got ${prompts.length}`);
  const names = new Set(prompts.map((p) => p.name));
  for (const expected of [
    'investigate_recent_failures',
    'explain_trace',
    'propose_fix',
    'daily_quality_report',
  ]) {
    assert.ok(names.has(expected), `missing prompt: ${expected}`);
  }
});

test('mcp: every prompt declares title, description, and argument shape', async () => {
  const res = await rpcCall({ id: 11, method: 'prompts/list' });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const prompts = (res.result as { prompts: PromptDef[] }).prompts;
  for (const p of prompts) {
    assert.ok(p.title && /^[A-Z]/.test(p.title), `prompt ${p.name} missing Title Case title`);
    assert.ok(p.description && p.description.length > 0, `prompt ${p.name} missing description`);
    // No em-dashes or arrows in external-facing copy.
    const blob = [
      p.title,
      p.description,
      ...(p.arguments ?? []).map((a) => a.description ?? ''),
    ].join(' ');
    assert.ok(!blob.includes('—'), `prompt ${p.name} contains em-dash`);
    assert.ok(!blob.includes('->'), `prompt ${p.name} contains -> arrow`);
    assert.ok(!blob.includes('=>'), `prompt ${p.name} contains => arrow`);
    assert.ok(Array.isArray(p.arguments), `prompt ${p.name} should declare arguments array`);
    for (const arg of p.arguments ?? []) {
      assert.ok(arg.name, `prompt ${p.name} has argument with no name`);
      assert.ok(
        arg.description && arg.description.length > 0,
        `prompt ${p.name} arg ${arg.name} missing description`,
      );
    }
  }
});

test('mcp: prompts/get for investigate_recent_failures returns user message referencing real tools', async () => {
  const res = await rpcCall({
    id: 12,
    method: 'prompts/get',
    params: { name: 'investigate_recent_failures', arguments: {} },
  });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const result = res.result as GetPromptResult;
  assert.ok(Array.isArray(result.messages) && result.messages.length >= 1);
  const msg = result.messages[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.content.type, 'text');
  assert.ok(
    msg.content.text.includes('get_recent_failures'),
    'body should reference get_recent_failures tool',
  );
  assert.ok(msg.content.text.includes('24'), 'default lookback of 24 hours should appear in body');
  assert.match(msg.content.text, /bounded sample/);
  assert.match(msg.content.text, /do not claim a tenant-wide total/);
});

test('mcp: prompts/get for investigate_recent_failures honors lookback_hours + framework args', async () => {
  const res = await rpcCall({
    id: 13,
    method: 'prompts/get',
    params: {
      name: 'investigate_recent_failures',
      arguments: { lookback_hours: '72', framework: 'n8n' },
    },
  });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const text = (res.result as GetPromptResult).messages[0].content.text;
  assert.ok(text.includes('72'), 'custom lookback should appear in body');
  assert.ok(text.includes('n8n'), 'framework filter should appear in body');
});

test('mcp: prompts/get for explain_trace requires trace_id', async () => {
  const res = await rpcCall({
    id: 14,
    method: 'prompts/get',
    params: { name: 'explain_trace', arguments: {} },
  });
  // Missing required arg should surface as a JSON-RPC error (the handler throws).
  assert.ok(
    res.error !== undefined || (res.result as { isError?: boolean })?.isError === true,
    `expected an error response, got ${JSON.stringify(res)}`,
  );
});

test('mcp: prompts/get for explain_trace embeds the trace_id and references get_trace', async () => {
  const res = await rpcCall({
    id: 15,
    method: 'prompts/get',
    params: {
      name: 'explain_trace',
      arguments: { trace_id: 'trace-abc-123' },
    },
  });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const text = (res.result as GetPromptResult).messages[0].content.text;
  assert.ok(text.includes('trace-abc-123'));
  assert.ok(text.includes('get_trace'));
});

test('mcp: prompts/get for propose_fix chains get_recent_failures and get_trace', async () => {
  const res = await rpcCall({
    id: 16,
    method: 'prompts/get',
    params: {
      name: 'propose_fix',
      arguments: { failure_id: 'trace-xyz-999' },
    },
  });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const text = (res.result as GetPromptResult).messages[0].content.text;
  assert.ok(text.includes('trace-xyz-999'));
  assert.ok(text.includes('get_recent_failures'));
  assert.ok(text.includes('get_trace'));
});

test('mcp: prompts/get for daily_quality_report renders without tenant', async () => {
  const res = await rpcCall({
    id: 17,
    method: 'prompts/get',
    params: { name: 'daily_quality_report', arguments: {} },
  });
  assert.equal(res.error, undefined, JSON.stringify(res));
  const text = (res.result as GetPromptResult).messages[0].content.text;
  assert.ok(text.includes('get_recent_traces'));
  assert.ok(text.includes('get_recent_failures'));
  assert.ok(text.includes('24 hours'));
  assert.match(text, /sample recent activity/);
  assert.match(text, /Proposed-fix coverage/);
  assert.match(text, /not evidence that a fix was applied or healed/);
  assert.doesNotMatch(text, /healing-success rate/i);
  assert.doesNotMatch(text, /count overall detection volume/i);
});

test('mcp: tool call propagates errors when base url is unreachable', async () => {
  // Override base-url to a non-routable address; fetch should fail and the
  // tool call should return isError:true with a text payload.
  const child = spawn(process.execPath, [binPath, 'mcp', '--base-url', 'http://127.0.0.1:1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PISAMA_API_KEY: 'pisama_mcp_test_key' },
  });
  const init = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  };
  child.stdin.write(JSON.stringify(init) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'get_recent_failures', arguments: { limit: 5 } },
    }) + '\n',
  );

  const result = await new Promise<JsonRpcResponse>((resolveP, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, 5000);
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed.id === 9) {
            clearTimeout(timer);
            child.kill();
            resolveP(parsed);
            return;
          }
        } catch {
          /* ignore */
        }
      }
    });
    child.on('error', reject);
  });

  // The MCP server may either:
  //   (a) return a result with isError true and a textual error, OR
  //   (b) return a JSON-RPC error.
  // Both are valid; assert one of them.
  if (result.error) {
    assert.ok(typeof result.error.message === 'string');
  } else {
    const r = result.result as { isError?: boolean; content: unknown[] };
    assert.equal(r.isError, true);
    assert.ok(r.content.length > 0);
  }
});
