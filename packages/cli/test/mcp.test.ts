import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, '..', 'dist', 'bin.js');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpcCall(
  request: { id: number; method: string; params?: unknown },
  timeoutMs = 4000,
): Promise<JsonRpcResponse> {
  const child = spawn(process.execPath, [binPath, 'mcp', '--project-id', 'ws_mcp_test'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PISAMA_PROJECT_ID: 'ws_mcp_test' },
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

  return await new Promise<JsonRpcResponse>((resolveP, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp rpc timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    let buffer = '';
    let stderr = '';
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
        if (parsed.id === request.id) {
          clearTimeout(timer);
          child.kill();
          resolveP(parsed);
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
  const child = spawn(
    process.execPath,
    [binPath, 'mcp', '--project-id', 'ws_mcp_test', '--base-url', 'http://127.0.0.1:1'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
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
