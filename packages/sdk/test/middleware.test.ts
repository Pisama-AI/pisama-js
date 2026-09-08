import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { pisamaMiddleware } from '../src/middleware.js';
import { TraceExporter } from '../src/exporter.js';
import type { TraceEvent } from '../src/types.js';
import { decodeEvents, tokenResponse } from './otlp-helpers.js';

interface CapturedRequest {
  url: string;
  body: { events: TraceEvent[] };
  headers: Record<string, string>;
}

function captureExporter(maxBatchSize = 1) {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (
    input: unknown,
    init?: { headers?: Record<string, string>; body?: string },
  ) => {
    if (String(input).endsWith('/api/v1/auth/token')) return tokenResponse();
    const body = JSON.parse(init?.body ?? '{}');
    captured.push({
      url: String(input),
      body: { events: decodeEvents(body) },
      headers: init?.headers ?? {},
    });
    return new Response(JSON.stringify({ accepted: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const exporter = new TraceExporter({
    apiKey: 'pisama_middleware_test_key',
    projectId: 'ws_test',
    endpoint: 'http://test/api/v1/traces/ingest',
    fetchImpl,
    flushIntervalMs: 5,
    maxBatchSize,
  });
  return { captured, exporter };
}

test('generateText: TraceEvent captured with text + tool calls + tokens', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'test-model',
    doGenerate: async () => ({
      content: [
        { type: 'text', text: 'Hello world' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'lookup',
          input: '{"query":"weather"}',
        },
      ],
      finishReason: 'stop',
      usage: {
        inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
      warnings: [],
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({ projectId: 'ws_test', exporter, redact: 'off' }),
  });

  await generateText({
    model: wrapped,
    prompt: 'Say hi.',
  });

  await exporter.flush();

  assert.equal(captured.length, 1, 'exporter should have flushed exactly one batch');
  const events = captured[0]!.body.events;
  assert.equal(events.length, 1);
  const ev = events[0]!;

  assert.equal(ev.projectId, 'ws_test');
  assert.match(ev.traceId, /^[0-9a-f]{32}$/);
  assert.match(ev.spanId, /^[0-9a-f]{16}$/);
  assert.equal(ev.model, 'test-model');
  assert.equal(ev.completion, 'Hello world');
  assert.equal(ev.inputTokens, 8);
  assert.equal(ev.outputTokens, 4);
  assert.equal(ev.finishReason, 'stop');
  assert.equal(ev.toolCalls.length, 1);
  assert.equal(ev.toolCalls[0]!.toolName, 'lookup');
  assert.deepEqual(ev.toolCalls[0]!.args, { query: 'weather' });
  assert.match(ev.prompt ?? '', /Say hi/);
  assert.equal(captured[0]!.headers['x-pisama-project-id'], 'ws_test');
});

test('streamText: deltas accumulate into completion text', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'stream-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Once ' },
          { type: 'text-delta', id: 't1', delta: 'upon ' },
          { type: 'text-delta', id: 't1', delta: 'a ' },
          { type: 'text-delta', id: 't1', delta: 'time.' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 5 },
              outputTokens: { total: 14 },
            },
          },
        ],
        chunkDelayInMs: null,
      }),
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({ projectId: 'ws_test', exporter, redact: 'off' }),
  });

  const result = streamText({
    model: wrapped,
    prompt: 'Tell me a story.',
  });

  // Consume the stream
  for await (const _ of result.textStream) {
    void _;
  }
  await result.consumeStream();

  await exporter.flush();

  assert.equal(captured.length, 1);
  const ev = captured[0]!.body.events[0]!;
  assert.equal(ev.completion, 'Once upon a time.');
  assert.equal(ev.inputTokens, 5);
  assert.equal(ev.outputTokens, 14);
  assert.equal(ev.finishReason, 'stop');
  assert.equal(ev.toolCalls.length, 0);
});

test('streamText: tool calls are collected through the stream', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'tool-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'tc_1',
            toolName: 'search',
            input: '{"q":"bun"}',
          },
          {
            type: 'tool-call',
            toolCallId: 'tc_2',
            toolName: 'search',
            input: '{"q":"deno"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: { total: 12 }, outputTokens: { total: 6 } },
          },
        ],
        chunkDelayInMs: null,
      }),
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({ projectId: 'ws_test', exporter, redact: 'off' }),
  });

  const result = streamText({
    model: wrapped,
    prompt: 'Search for bun and deno.',
  });
  await result.consumeStream();
  await exporter.flush();

  const ev = captured[0]!.body.events[0]!;
  assert.equal(ev.toolCalls.length, 2);
  assert.deepEqual(
    ev.toolCalls.map((t) => t.toolName),
    ['search', 'search'],
  );
  assert.deepEqual(ev.toolCalls[0]!.args, { q: 'bun' });
});

test('redact: standard mode strips emails from completion', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'redact-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Email me at hello@example.com please.' }],
      finishReason: 'stop',
      usage: { inputTokens: { total: 5 }, outputTokens: { total: 8 } },
      warnings: [],
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({
      projectId: 'ws_test',
      exporter,
      redact: 'standard',
    }),
  });

  await generateText({ model: wrapped, prompt: 'What is your email?' });
  await exporter.flush();

  const ev = captured[0]!.body.events[0]!;
  assert.match(ev.completion ?? '', /\[email\]/);
  assert.doesNotMatch(ev.completion ?? '', /hello@example\.com/);
});

test('explicitly disabled middleware is a passthrough no-op', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'noop-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'passthrough' }],
      finishReason: 'stop',
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      warnings: [],
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({ exporter, enabled: false }),
  });

  const result = await generateText({ model: wrapped, prompt: 'Hi.' });
  await exporter.flush();

  assert.equal(result.text, 'passthrough');
  assert.equal(captured.length, 0, 'exporter should not have been called');
});

test('middleware fails closed when no API key or custom exporter is configured', async () => {
  const originalKey = process.env.PISAMA_API_KEY;
  delete process.env.PISAMA_API_KEY;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response();
  }) as typeof fetch;
  try {
    const model = new MockLanguageModelV3({
      modelId: 'no-key-model',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'passthrough' }],
        finishReason: 'stop',
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      }),
    });
    const wrapped = wrapLanguageModel({
      model,
      middleware: pisamaMiddleware({ projectId: 'service-without-key' }),
    });
    const result = await generateText({ model: wrapped, prompt: 'Hi.' });
    assert.equal(result.text, 'passthrough');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PISAMA_API_KEY;
    else process.env.PISAMA_API_KEY = originalKey;
  }
});

test('error telemetry applies each configured privacy mode before OTLP serialization', async () => {
  const email = 'private.person@example.com';
  const openAiKey = `sk-proj-${'x'.repeat(32)}_suffix`;
  const githubKey = `github_pat_${'y'.repeat(32)}_suffix`;
  const pisamaKey = ['pisama', '_', 'z'.repeat(43)].join('');
  const githubServerToken = ['ghs', '_', 's'.repeat(36)].join('');
  const githubOauthToken = ['gho', '_', 'o'.repeat(36)].join('');
  const originalMessage = `failure for ${email} using ${openAiKey} ${pisamaKey} ${githubServerToken}`;
  const originalName = `ProviderError-${githubKey}-${githubOauthToken}`;

  for (const mode of ['standard', 'metadata-only', 'off'] as const) {
    const bodies: unknown[] = [];
    const exporter = new TraceExporter({
      apiKey: 'pisama_error_privacy_test_key',
      projectId: 'ws_error_privacy',
      endpoint: 'https://api.test/api/v1/traces/ingest',
      maxBatchSize: 32,
      fetchImpl: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (String(input).endsWith('/api/v1/auth/token')) return tokenResponse();
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ accepted: 1 }, { status: 202 });
      }) as typeof fetch,
    });
    const middleware = pisamaMiddleware({ exporter, redact: mode, eager: true }) as unknown as {
      wrapGenerate: (args: {
        doGenerate: () => Promise<never>;
        params: { prompt: string };
        model: { modelId: string };
      }) => Promise<unknown>;
    };
    const providerError = new Error(originalMessage);
    providerError.name = originalName;

    await assert.rejects(() =>
      middleware.wrapGenerate({
        doGenerate: async () => {
          throw providerError;
        },
        params: { prompt: `debug ${email}` },
        model: { modelId: 'privacy-model' },
      }),
    );

    assert.equal(bodies.length, 1);
    const serialized = JSON.stringify(bodies[0]);
    if (mode === 'off') {
      assert.match(serialized, /private\.person@example\.com/);
      assert.ok(serialized.includes(openAiKey));
      assert.ok(serialized.includes(githubKey));
      assert.ok(serialized.includes(pisamaKey));
      assert.ok(serialized.includes(githubServerToken));
      assert.ok(serialized.includes(githubOauthToken));
    } else {
      assert.doesNotMatch(serialized, /private\.person@example\.com/);
      assert.ok(!serialized.includes(openAiKey));
      assert.ok(!serialized.includes(githubKey));
      assert.ok(!serialized.includes(pisamaKey));
      assert.ok(!serialized.includes(githubServerToken));
      assert.ok(!serialized.includes(githubOauthToken));
      if (mode === 'standard') {
        assert.match(serialized, /\[email\]/);
        assert.match(serialized, /\[openai-key\]/);
        assert.match(serialized, /\[pisama-key\]/);
        assert.match(serialized, /\[github-token\]/);
      } else {
        assert.match(serialized, /\[redacted\]/);
      }
    }
  }
});

test('stream setup errors redact first-party and GitHub token shapes before OTLP serialization', async () => {
  const pisamaKey = ['pisama', '_', 'q'.repeat(43)].join('');
  const githubServerToken = ['ghs', '_', 'r'.repeat(36)].join('');
  const githubOauthToken = ['gho', '_', 't'.repeat(36)].join('');
  const bodies: unknown[] = [];
  const exporter = new TraceExporter({
    apiKey: 'pisama_stream_privacy_test_key',
    projectId: 'ws_stream_privacy',
    endpoint: 'https://api.test/api/v1/traces/ingest',
    maxBatchSize: 32,
    fetchImpl: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).endsWith('/api/v1/auth/token')) return tokenResponse();
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ accepted: 1 }, { status: 202 });
    }) as typeof fetch,
  });
  const middleware = pisamaMiddleware({ exporter, redact: 'standard', eager: true });
  const providerError = new Error(
    `stream refused ${pisamaKey} ${githubServerToken} ${githubOauthToken}`,
  );

  await assert.rejects(
    () =>
      middleware.wrapStream!({
        doStream: async () => {
          throw providerError;
        },
        params: { prompt: `do not expose ${pisamaKey}` },
        model: { modelId: 'privacy-stream-model' },
      } as never),
    (error: unknown) => error === providerError,
  );

  assert.equal(bodies.length, 1);
  const serialized = JSON.stringify(bodies[0]);
  for (const secret of [pisamaKey, githubServerToken, githubOauthToken]) {
    assert.ok(!serialized.includes(secret));
  }
  assert.match(serialized, /\[pisama-key\]/);
  assert.match(serialized, /\[github-token\]/);
});

test('error telemetry preserves a hostile thrown value without invoking unsafe fields', async () => {
  const { captured, exporter } = captureExporter(32);
  const hostile = {
    get message(): never {
      throw new Error('message getter must not escape');
    },
    name: 404,
  };
  const middleware = pisamaMiddleware({ exporter, redact: 'standard', eager: true }) as unknown as {
    wrapGenerate: (args: {
      doGenerate: () => Promise<never>;
      params: { prompt: string };
      model: { modelId: string };
    }) => Promise<unknown>;
  };

  let caught: unknown;
  try {
    await middleware.wrapGenerate({
      doGenerate: async () => {
        throw hostile;
      },
      params: { prompt: 'Trigger the provider error.' },
      model: { modelId: 'hostile-error-model' },
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, hostile, 'telemetry must rethrow the original provider value');
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.body.events[0]!.error?.message, 'unknown');
  assert.equal(captured[0]!.body.events[0]!.error?.name, undefined);
});
