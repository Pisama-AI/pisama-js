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
        assert.equal(url.searchParams.get('per_page'), '5');
        if (traceCalls === 1) {
          respond(response, 401, { detail: 'expired' });
          return;
        }
        respond(response, 200, {
          traces: [
            {
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
            },
          ],
          total: 1,
          page: 1,
          per_page: 5,
        });
        return;
      }
      if (url.pathname === '/api/v1/tenants/tenant-mcp-1/detections') {
        assert.equal(url.searchParams.get('trace_id'), traceId);
        respond(response, 200, {
          items: [
            {
              detection_type: 'loop',
              confidence: 80,
              details: { repeated: 4 },
              explanation: 'Repeated the same tool.',
              suggested_fix: 'Bound retries.',
            },
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
          events?: Array<{ event?: { traceId?: string }; hits?: Array<{ detector?: string }> }>;
        };
      };
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent?.tenantId, 'tenant-mcp-1');
      assert.equal(result.structuredContent?.events?.[0]?.event?.traceId, traceId);
      assert.equal(result.structuredContent?.events?.[0]?.hits?.[0]?.detector, 'loop');
      assert.match(result.content[0].text, /loop\/8/);
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
        respond(response, 200, {
          id: traceId,
          session_id: 'session-detail',
          framework: 'langgraph',
          status: 'completed',
          detection_status: 'complete',
          total_tokens: 10,
          total_cost_cents: 1,
          created_at: '2026-09-04T12:00:00Z',
          completed_at: '2026-09-04T12:00:01Z',
          detection_count: 1,
          state_count: 1,
        });
        return;
      }
      if (url.pathname.endsWith(`/traces/${traceId}/states`)) {
        assert.equal(url.searchParams.get('full_state'), 'true');
        assert.equal(url.searchParams.get('limit'), '2000');
        respond(response, 200, [
          {
            id: '33333333-3333-4333-8333-333333333333',
            sequence_num: 0,
            agent_id: 'agent',
            state_delta: { _prompt: 'Diagnose this run.' },
            response_redacted: 'The run looped.',
            token_count: 10,
            latency_ms: 1000,
            created_at: '2026-09-04T12:00:00Z',
          },
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
        structuredContent?: {
          event?: {
            prompt?: string;
            completion?: string;
            toolCalls?: unknown[];
            metadata?: unknown;
          };
        };
      };
      assert.equal(result.isError, false, JSON.stringify(response));
      assert.equal(result.structuredContent?.event?.prompt, 'Diagnose this run.');
      assert.equal(result.structuredContent?.event?.completion, 'The run looped.');
      assert.deepEqual(result.structuredContent?.event?.toolCalls, []);
    },
  );
  assert.equal(seenPaths.length, 3);
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
